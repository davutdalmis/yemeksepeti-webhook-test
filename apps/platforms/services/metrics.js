// ==================================================================================
// PROMETHEUS METRICS COLLECTOR
// ==================================================================================
// Lightweight metrics collection — no external dependencies
// Exposes counters (increment-only) and gauges (point-in-time from stores)
// Output: Prometheus text exposition format (text/plain; version=0.0.4)
// ==================================================================================

class MetricsCollector {
    constructor({ orderStore, cancellationStore, webhookStore, courierState, io, getRedisStatus, getRedisFailoverInfo }) {
        this.orderStore = orderStore;
        this.cancellationStore = cancellationStore;
        this.webhookStore = webhookStore;
        this.courierState = courierState;
        this.io = io;
        this.getRedisStatus = getRedisStatus;
        this.getRedisFailoverInfo = getRedisFailoverInfo || null;

        // Counter storage: { 'metric_name': { 'label_key=label_val': value } }
        this.counters = {};
        this.startTime = Date.now();

        // Circuit breaker status provider (set via setCircuitBreakerProvider)
        this._circuitBreakerProvider = null;
    }

    /**
     * Register a function that returns circuit breaker statuses.
     * @param {Function} provider - () => [{name, state, stateCode, failureCount, tripCount}]
     */
    setCircuitBreakerProvider(provider) {
        this._circuitBreakerProvider = provider;
    }

    /**
     * Increment a counter metric
     * @param {string} name - Metric name (e.g. 'orders_received_total')
     * @param {Object} labels - Label key-value pairs (e.g. { platform: 'yemeksepeti' })
     * @param {number} value - Increment amount (default 1)
     */
    increment(name, labels = {}, value = 1) {
        if (!this.counters[name]) {
            this.counters[name] = {};
        }
        const labelKey = this._serializeLabels(labels);
        this.counters[name][labelKey] = (this.counters[name][labelKey] || 0) + value;
    }

    /**
     * Get current value of a counter (for testing/debugging)
     */
    getCounter(name, labels = {}) {
        const labelKey = this._serializeLabels(labels);
        return this.counters[name]?.[labelKey] || 0;
    }

    /**
     * Generate Prometheus text exposition format output
     */
    async getMetrics() {
        const lines = [];
        const now = Date.now();

        // ── Counters ──
        this._writeCounter(lines, 'orders_received_total', 'Total orders received by platform');
        this._writeCounter(lines, 'orders_cancelled_total', 'Total orders cancelled by platform');
        this._writeCounter(lines, 'polling_requests_total', 'Total polling requests by platform');
        this._writeCounter(lines, 'webhook_requests_total', 'Total webhook requests by platform');
        this._writeCounter(lines, 'socket_events_total', 'Total socket events by type');
        this._writeCounter(lines, 'dispatch_assignments_total', 'Total dispatch assignments by status');
        this._writeCounter(lines, 'delayed_call_enqueue_total', 'Total delayed API calls enqueued');
        this._writeCounter(lines, 'delayed_call_processed_total', 'Total delayed API calls successfully dispatched');
        this._writeCounter(lines, 'delayed_call_failed_total', 'Total delayed API calls that exhausted retries');

        // ── Gauges (live from stores) ──
        try {
            const ordersActive = await this.orderStore.size();
            this._writeGauge(lines, 'orders_active', 'Currently active orders in queue', ordersActive);
        } catch { this._writeGauge(lines, 'orders_active', 'Currently active orders in queue', -1); }

        try {
            const branchCount = await this.orderStore.indexedBranchCount();
            this._writeGauge(lines, 'orders_active_branches', 'Number of branches with active orders', branchCount);
        } catch { this._writeGauge(lines, 'orders_active_branches', 'Number of branches with active orders', -1); }

        try {
            const cancellations = await this.cancellationStore.size();
            this._writeGauge(lines, 'cancellations_active', 'Active cancellations in queue', cancellations);
        } catch { this._writeGauge(lines, 'cancellations_active', 'Active cancellations in queue', -1); }

        try {
            const webhooks = await this.webhookStore.size();
            this._writeGauge(lines, 'webhooks_active', 'Active webhooks in queue', webhooks);
        } catch { this._writeGauge(lines, 'webhooks_active', 'Active webhooks in queue', -1); }

        try {
            const socketCount = this.io.sockets.sockets.size;
            this._writeGauge(lines, 'socket_connections_active', 'Total active socket connections', socketCount);
        } catch { this._writeGauge(lines, 'socket_connections_active', 'Total active socket connections', -1); }

        try {
            const couriers = await this.courierState.connectedCount();
            this._writeGauge(lines, 'couriers_connected', 'Number of connected couriers', couriers);
        } catch { this._writeGauge(lines, 'couriers_connected', 'Number of connected couriers', -1); }

        const redisStatus = this.getRedisStatus();
        this._writeGauge(lines, 'redis_connected', 'Redis connection status (1=connected, 0=disconnected)', redisStatus.connected ? 1 : 0);

        // ── Redis Failover metrics ──
        if (this.getRedisFailoverInfo) {
            try {
                const failover = this.getRedisFailoverInfo();
                this._writeGauge(lines, 'redis_failover_active', 'Redis failover active (1=in failover, 0=normal)', failover.inFailover ? 1 : 0);
                this._writeGauge(lines, 'redis_failover_duration_seconds', 'Current Redis failover duration in seconds', Math.round(failover.failoverDurationMs / 1000));
                this._writeGauge(lines, 'redis_reconnect_attempts_total', 'Total Redis reconnect attempts in current failover', failover.reconnectAttempts);
                this._writeGauge(lines, 'redis_failovers_total', 'Total number of Redis failovers since startup', failover.totalFailovers);
            } catch { /* ignore failover metrics errors */ }
        }

        // ── Circuit Breaker metrics ──
        if (this._circuitBreakerProvider) {
            try {
                const breakers = this._circuitBreakerProvider();
                // State gauge: 0=closed, 1=open, 2=half-open
                lines.push('# HELP circuit_breaker_state Circuit breaker state (0=closed, 1=open, 2=half-open)');
                lines.push('# TYPE circuit_breaker_state gauge');
                for (const cb of breakers) {
                    lines.push(`circuit_breaker_state{name="${cb.name}"} ${cb.stateCode}`);
                }
                // Trip counter
                lines.push('# HELP circuit_breaker_trips_total Total times circuit breaker tripped to open');
                lines.push('# TYPE circuit_breaker_trips_total counter');
                for (const cb of breakers) {
                    lines.push(`circuit_breaker_trips_total{name="${cb.name}"} ${cb.tripCount}`);
                }
                // Failure count gauge (current consecutive failures)
                lines.push('# HELP circuit_breaker_failures Current consecutive failure count');
                lines.push('# TYPE circuit_breaker_failures gauge');
                for (const cb of breakers) {
                    lines.push(`circuit_breaker_failures{name="${cb.name}"} ${cb.failureCount}`);
                }
            } catch { /* ignore CB metrics errors */ }
        }

        // Uptime gauge
        const uptimeSeconds = Math.floor((now - this.startTime) / 1000);
        this._writeGauge(lines, 'process_uptime_seconds', 'Process uptime in seconds', uptimeSeconds);

        return lines.join('\n') + '\n';
    }

    // ── Internal helpers ──

    _serializeLabels(labels) {
        const keys = Object.keys(labels).sort();
        if (keys.length === 0) return '';
        return keys.map(k => `${k}="${labels[k]}"`).join(',');
    }

    _formatLabels(serialized) {
        return serialized ? `{${serialized}}` : '';
    }

    _writeCounter(lines, name, help) {
        const data = this.counters[name];
        if (!data || Object.keys(data).length === 0) {
            // Still write the metric with 0 if no data yet
            lines.push(`# HELP ${name} ${help}`);
            lines.push(`# TYPE ${name} counter`);
            return;
        }
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} counter`);
        for (const [labelKey, value] of Object.entries(data)) {
            lines.push(`${name}${this._formatLabels(labelKey)} ${value}`);
        }
    }

    _writeGauge(lines, name, help, value) {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name} ${value}`);
    }
}

module.exports = MetricsCollector;
