// ==================================================================================
// Shared Sentry Init — DSN-parametreli, opsiyonel
// ==================================================================================
// DSN bos veya @sentry/node yuklu degilse no-op. Service per-app cagrir.
// Plan 27 Faz 4.1'de invoicing-engine'de aktive edilecek.
// ==================================================================================

let SentryRef = null;

function initSentry({ dsn, service, environment } = {}) {
    if (!dsn) {
        console.log(`[Sentry] No DSN — disabled (service=${service || 'unknown'})`);
        return null;
    }
    if (SentryRef) {
        return SentryRef;
    }

    try {
        const Sentry = require('@sentry/node');
        Sentry.init({
            dsn,
            environment: environment || process.env.NODE_ENV || 'production',
            initialScope: { tags: { service: service || 'unknown' } },
        });
        SentryRef = Sentry;
        console.log(`[Sentry] Initialized (service=${service})`);
        return Sentry;
    } catch (e) {
        console.warn(`[Sentry] init failed (${e.code || e.message}) — running without Sentry`);
        return null;
    }
}

function getSentry() {
    return SentryRef;
}

module.exports = { initSentry, getSentry };
