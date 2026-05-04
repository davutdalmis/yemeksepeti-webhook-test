// ==================================================================================
// RetryPolicy — hata siniflandirmasi + exponential backoff
// ==================================================================================
// Plan 27 Faz 2.3.
// Geçici hatalar (5xx, 429, network): retry
// Kalıcı (4xx validation): retry yok -> failed
// Auth (401/403): token invalidate + 1 retry; sonra kullaniciya bildiri
// ==================================================================================

const BACKOFF_SCHEDULE_MS = [5000, 30000, 5 * 60 * 1000];

function classify(err) {
    if (!err) return { retryable: false, kind: 'unknown', authError: false };

    const status = err.status || (err.response && err.response.status) || null;
    const code = err.code || (err.constructor && err.constructor.name);

    // Network / timeout
    if (!status || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        return { retryable: true, kind: 'network', authError: false };
    }

    // Auth — invalidate token then retry once
    if (status === 401 || status === 403) {
        return { retryable: true, kind: 'auth', authError: true };
    }

    // Rate limit
    if (status === 429) {
        const retryAfter = parseInt((err.response && err.response.headers && err.response.headers['retry-after']) || '0', 10);
        return { retryable: true, kind: 'rate_limit', authError: false, retryAfterMs: retryAfter * 1000 || null };
    }

    // 5xx — retryable
    if (status >= 500 && status < 600) {
        return { retryable: true, kind: 'server', authError: false };
    }

    // 4xx (other) — permanent
    return { retryable: false, kind: 'validation', authError: false };
}

function backoffMs(attempt) {
    // attempt is 1-indexed (1 = first retry, etc.)
    const idx = Math.max(0, Math.min(BACKOFF_SCHEDULE_MS.length - 1, attempt - 1));
    return BACKOFF_SCHEDULE_MS[idx];
}

function maxAttempts() {
    return BACKOFF_SCHEDULE_MS.length;
}

module.exports = { classify, backoffMs, maxAttempts, BACKOFF_SCHEDULE_MS };
