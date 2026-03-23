// ==================================================================================
// CIRCUIT BREAKER WITH JITTER
// ==================================================================================
// Prevents cascading failures by temporarily cutting calls to failing services.
// Jitter spreads retry timing across multi-instance deployments to avoid
// thundering herd effect.
//
// States: CLOSED (normal) → OPEN (failing, use fallback) → HALF_OPEN (probe)
// ==================================================================================

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

class CircuitBreaker {
    /**
     * @param {string} name - Identifier for logging/metrics
     * @param {Object} options
     * @param {number} options.failureThreshold - Failures before opening (default 5)
     * @param {number} options.resetTimeoutMs - Base wait before half-open probe (default 60000)
     * @param {number} options.jitterFactor - Random spread ±factor (default 0.3 = ±30%)
     * @param {number} options.halfOpenSuccessThreshold - Successes in half-open to close (default 2)
     */
    constructor(name, options = {}) {
        this.name = name;
        this.failureThreshold = options.failureThreshold || 5;
        this.resetTimeoutMs = options.resetTimeoutMs || 60000;
        this.jitterFactor = options.jitterFactor || 0.3;
        this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold || 2;

        this.state = STATES.CLOSED;
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.halfOpenSuccessCount = 0;
        this.tripCount = 0; // Total times circuit opened
    }

    /**
     * Execute a function through the circuit breaker.
     * If circuit is open and reset timeout hasn't elapsed, calls fallback immediately.
     * @param {Function} fn - Async function to execute
     * @param {Function} [fallback] - Fallback function if circuit is open or fn fails
     * @returns {*} Result from fn or fallback
     */
    async execute(fn, fallback) {
        if (this.state === STATES.OPEN) {
            const elapsed = Date.now() - this.lastFailureTime;
            const resetTimeout = this._jitteredTimeout();

            if (elapsed < resetTimeout) {
                // Still open — use fallback without hitting the service
                if (fallback) return fallback();
                return null;
            }

            // Reset timeout elapsed — try half-open probe
            this.state = STATES.HALF_OPEN;
            this.halfOpenSuccessCount = 0;
            console.log(`[CircuitBreaker:${this.name}] HALF-OPEN — probing service`);
        }

        try {
            const result = await fn();
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure();
            if (fallback) return fallback();
            throw error;
        }
    }

    _onSuccess() {
        if (this.state === STATES.HALF_OPEN) {
            this.halfOpenSuccessCount++;
            if (this.halfOpenSuccessCount >= this.halfOpenSuccessThreshold) {
                this.state = STATES.CLOSED;
                this.failureCount = 0;
                this.halfOpenSuccessCount = 0;
                console.log(`[CircuitBreaker:${this.name}] CLOSED — service recovered`);
            }
        } else {
            // In closed state, reset failure count on success
            this.failureCount = 0;
        }
    }

    _onFailure() {
        this.failureCount++;
        this.lastFailureTime = Date.now();

        if (this.state === STATES.HALF_OPEN) {
            // Half-open probe failed — go back to open
            this.state = STATES.OPEN;
            this.halfOpenSuccessCount = 0;
            console.warn(`[CircuitBreaker:${this.name}] OPEN — half-open probe failed (trip #${this.tripCount})`);
        } else if (this.failureCount >= this.failureThreshold) {
            this.state = STATES.OPEN;
            this.tripCount++;
            console.warn(`[CircuitBreaker:${this.name}] OPEN — ${this.failureCount} consecutive failures (trip #${this.tripCount})`);
        }
    }

    /**
     * Apply jitter to reset timeout to prevent thundering herd.
     * Returns resetTimeoutMs ± (jitterFactor * resetTimeoutMs)
     */
    _jitteredTimeout() {
        const jitter = 1 + (Math.random() * 2 - 1) * this.jitterFactor;
        return Math.round(this.resetTimeoutMs * jitter);
    }

    /**
     * Get current status for health/metrics endpoints.
     */
    getStatus() {
        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount,
            tripCount: this.tripCount,
            lastFailureTime: this.lastFailureTime,
            stateCode: this.state === STATES.CLOSED ? 0 : this.state === STATES.OPEN ? 1 : 2
        };
    }
}

module.exports = { CircuitBreaker, STATES };
