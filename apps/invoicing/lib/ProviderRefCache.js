// ==================================================================================
// ProviderRefCache — Parasut contact/product ID'lerinin kalici onbellegi
// ==================================================================================
// 2026-07-29 (canli olay): Bafetto'da 7 sube ayni aksam imalat siparisi verdi;
// 4 subenin e-irsaliyesi Parasut'tan 429 alip DLQ'ya dustu, panelde "queued"
// takildi ve kullaniciya HIC gorunmedi.
//
// Kok neden istek amplifikasyonu: upsertContact 1 GET, upsertProduct ise HER
// KALEM icin 1 GET atiyordu (`/products?filter[name]=...`). 15 kalemlik bir
// imalat siparisi = 16+ istek — hem de ayni urunler dun de arandigi halde.
// Parasut'un limiti SAATLIK (kullanici + IP basina); birkac sube pes pese
// siparis verince limit doluyordu.
//
// Cozum: bir kez cozulen isim->Parasut ID eslesmesini sakla. Tekrar eden
// urunlerde istek sayisi 0'a iner; yalniz DAHA ONCE GORULMEMIS urun icin
// Parasut'a gidilir.
//
// Iki katmanli: sureç-ici Map (ayni is icindeki tekrarlar) + Firestore
// (kalici, servis yeniden baslasa da yasar, tum instance'lar paylasir).
//
// Firestore semasi:
//   invoicingProviderRefs/{tenantId}/products/{hash}  -> { parasutId, label, updatedAt }
//   invoicingProviderRefs/{tenantId}/contacts/{hash}  -> { parasutId, label, updatedAt }
//
// NOT: Bu onbellek yalniz KIMLIK eslesmesi tutar (isim -> id), fiyat/stok gibi
// degisken alan tutmaz. Urun Parasut'ta silinirse kayit bayatlar; bu durumda
// cagiran katman forget() ile dusurur ve sonraki denemede yeniden cozulur.
// ==================================================================================

const crypto = require('crypto');

const DEFAULT_COLLECTION = 'invoicingProviderRefs';
const MEM_MAX_ENTRIES = 5000;

/**
 * Isim farkliliklarini tek anahtara indirger (bas/son bosluk, ic bosluk, buyuk-kucuk).
 *
 * DIKKAT — burada BILEREK yerel-ayar duyarsiz toLowerCase() kullaniliyor.
 * toLocaleLowerCase('tr-TR') ile "HARCI" -> "harcı" (noktasiz), "Harci" -> "harci"
 * (noktali) olur ve ayni urun IKI FARKLI anahtara duserdi. Yanlis ID dondurmektense
 * onbellek ISKALAMASI tercih edilir: iskalama yalniz bir ekstra arama istegine
 * mal olur, yanlis eslesme ise faturaya yanlis urun yazardi.
 */
function normalizeLabel(raw) {
    return String(raw == null ? '' : raw)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function hashKey(label) {
    return crypto.createHash('sha256').update(normalizeLabel(label)).digest('hex').slice(0, 40);
}

class ProviderRefCache {
    /**
     * @param {object} opts
     * @param {object} opts.db                 Firestore instance (admin SDK)
     * @param {string} [opts.collection]       Kok koleksiyon adi
     * @param {object} [opts.logger]           console-uyumlu
     */
    constructor({ db, collection = DEFAULT_COLLECTION, logger = console } = {}) {
        if (!db) throw new Error('ProviderRefCache: db required');
        this.db = db;
        this.collection = collection;
        this.logger = logger;
        this.mem = new Map();
        this.stats = { hitMem: 0, hitStore: 0, miss: 0, writes: 0, errors: 0 };
    }

    _memKey(tenantId, kind, key) {
        return `${tenantId}:${kind}:${key}`;
    }

    _docRef(tenantId, kind, key) {
        return this.db.collection(this.collection).doc(String(tenantId)).collection(kind).doc(key);
    }

    /**
     * Onbellekten Parasut ID getir. Yoksa null.
     * Onbellek hatasi ASLA akisi bozmaz — null doner, cagiran normal yoluna devam eder.
     */
    async get(tenantId, kind, label) {
        if (!tenantId || !label) return null;
        const key = hashKey(label);
        const mk = this._memKey(tenantId, kind, key);

        if (this.mem.has(mk)) {
            this.stats.hitMem += 1;
            return this.mem.get(mk);
        }

        try {
            const snap = await this._docRef(tenantId, kind, key).get();
            if (snap.exists) {
                const id = snap.data() && snap.data().parasutId;
                if (id) {
                    this._memSet(mk, String(id));
                    this.stats.hitStore += 1;
                    return String(id);
                }
            }
        } catch (e) {
            this.stats.errors += 1;
            this.logger.warn(`[ProviderRefCache] get failed (${kind}): ${e.message}`);
            return null;
        }

        this.stats.miss += 1;
        return null;
    }

    /** Cozulen eslesmeyi kalici yaz. Hata yutulur — yazamamak akisi bozmamali. */
    async set(tenantId, kind, label, parasutId) {
        if (!tenantId || !label || !parasutId) return;
        const key = hashKey(label);
        this._memSet(this._memKey(tenantId, kind, key), String(parasutId));

        try {
            await this._docRef(tenantId, kind, key).set(
                {
                    parasutId: String(parasutId),
                    label: String(label).slice(0, 300),
                    updatedAt: Date.now(),
                },
                { merge: true }
            );
            this.stats.writes += 1;
        } catch (e) {
            this.stats.errors += 1;
            this.logger.warn(`[ProviderRefCache] set failed (${kind}): ${e.message}`);
        }
    }

    /** Bayat kaydi dusur (urun/cari Parasut'ta silinmisse). */
    async forget(tenantId, kind, label) {
        if (!tenantId || !label) return;
        const key = hashKey(label);
        this.mem.delete(this._memKey(tenantId, kind, key));
        try {
            await this._docRef(tenantId, kind, key).delete();
        } catch (e) {
            this.logger.warn(`[ProviderRefCache] forget failed (${kind}): ${e.message}`);
        }
    }

    _memSet(mk, value) {
        // Kaba LRU: sinir asilinca en eski girisi at (Map ekleme sirasini korur).
        if (this.mem.size >= MEM_MAX_ENTRIES) {
            const oldest = this.mem.keys().next().value;
            if (oldest !== undefined) this.mem.delete(oldest);
        }
        this.mem.set(mk, value);
    }

    snapshotStats() {
        const { hitMem, hitStore, miss } = this.stats;
        const total = hitMem + hitStore + miss;
        return {
            ...this.stats,
            total,
            hitRate: total > 0 ? Number(((hitMem + hitStore) / total).toFixed(3)) : null,
        };
    }
}

module.exports = ProviderRefCache;
module.exports.normalizeLabel = normalizeLabel;
module.exports.hashKey = hashKey;
