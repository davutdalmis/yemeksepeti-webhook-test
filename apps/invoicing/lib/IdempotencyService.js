// ==================================================================================
// IdempotencyService — sha256(tenantId + sourceType + sourceId) anahtariyla
// invoiceDocuments koleksiyonunda tek-yazim.
// ==================================================================================
// Plan 27 Faz 2.4.
// Anahtar Firestore doc ID olarak kullanildigi icin Firestore'un kendi unique constraint'i bizim icin idempotency saglar.
// "Already exists" -> mevcut doc'u dondur (yeni yaratim degil).
// ==================================================================================

const crypto = require('crypto');

function buildIdempotencyKey({ tenantId, sourceType, sourceId }) {
    if (!tenantId || !sourceType || !sourceId) {
        throw new Error('IdempotencyService: tenantId, sourceType, sourceId required');
    }
    return crypto
        .createHash('sha256')
        .update(`${tenantId}:${sourceType}:${sourceId}`)
        .digest('hex');
}

class IdempotencyService {
    constructor({ db, collection = 'invoiceDocuments' }) {
        if (!db) throw new Error('IdempotencyService: db required');
        this.db = db;
        this.collection = collection;
    }

    /**
     * Idempotency check + draft create (Plan 27 manual mode).
     * Returns { existing: true, doc } if already present, or { existing: false, doc } after create.
     */
    async ensureDraft({ tenantId, sourceType, sourceId, data }) {
        const key = buildIdempotencyKey({ tenantId, sourceType, sourceId });
        const ref = this.db.collection(this.collection).doc(key);
        const snap = await ref.get();
        if (snap.exists) {
            return { existing: true, id: key, doc: snap.data() };
        }
        const draft = {
            tenantId,
            sourceType,
            sourceId,
            idempotencyKey: key,
            status: 'draft',
            errorCount: 0,
            audit: [{ ts: Date.now(), event: 'draft_created', by: 'invoicing-engine' }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...data,
        };
        try {
            await ref.create(draft);
            return { existing: false, id: key, doc: draft };
        } catch (e) {
            // Race: another process won
            if (e.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(e.message))) {
                const reSnap = await ref.get();
                return { existing: true, id: key, doc: reSnap.data() };
            }
            throw e;
        }
    }

    async getById(id) {
        const snap = await this.db.collection(this.collection).doc(id).get();
        return snap.exists ? { id, ...snap.data() } : null;
    }

    async update(id, patch) {
        await this.db.collection(this.collection).doc(id).set(
            { ...patch, updatedAt: Date.now() },
            { merge: true }
        );
    }

    async appendAudit(id, event, by, details) {
        const admin = require('firebase-admin');
        const entry = { ts: Date.now(), event, by };
        if (details) entry.details = details;
        await this.db.collection(this.collection).doc(id).update({
            audit: admin.firestore.FieldValue.arrayUnion(entry),
            updatedAt: Date.now(),
        });
    }
}

module.exports = { IdempotencyService, buildIdempotencyKey };
