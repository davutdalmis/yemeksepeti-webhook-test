// Birim normalizasyonu + dönüşümü (02.09.2026).
//
// Neden: CanonicalStockWriter irsaliye kalemini sipariş birimiyle (ör. "1 kg") stok kartına
// birim çevirmeden yazıyor ve kartın satır birimini eziyordu. Maltepe Zeytin: 8.469 g + "1 kg"
// → 8.470 "kg". Gram kartına kg sevkiyat 1000 kat eksik giriyordu.
//
// Kural: miktar her zaman HEDEF birime çevrilir (kg↔g, lt↔ml). Sayılabilir birimler
// (adet/paket/kutu/sise/top/koli) birbirine ve ağırlık/hacme çevrilemez; bu durumda miktar
// olduğu gibi yazılır ve hareket `unitMismatch: true` ile işaretlenir — TAHMİN YAPILMAZ.

const ALIAS = {
    kg: 'kg', kilogram: 'kg', kilo: 'kg',
    g: 'g', gr: 'g', gram: 'g',
    lt: 'lt', l: 'lt', litre: 'lt', liter: 'lt',
    ml: 'ml', mililitre: 'ml',
    adet: 'adet', ad: 'adet', pcs: 'adet',
    paket: 'paket', pk: 'paket',
    kutu: 'kutu',
    sise: 'sise', 'şişe': 'sise',
    top: 'top',
    koli: 'koli',
};

// Aynı boyuttaki birimlerin taban birime çarpanı (ağırlık tabanı g, hacim tabanı ml).
const TO_BASE = {
    kg: { dim: 'mass', f: 1000 },
    g: { dim: 'mass', f: 1 },
    lt: { dim: 'volume', f: 1000 },
    ml: { dim: 'volume', f: 1 },
};

function normalizeUnit(u, fallback) {
    if (u == null) return fallback;
    const k = String(u).trim().toLowerCase();
    if (!k) return fallback;
    return ALIAS[k] || k;
}

function roundQty(n) {
    return Math.round(n * 10000) / 10000;
}

/**
 * qty'yi fromUnit → toUnit çevirir.
 * @returns {{ qty: number, unit: string, converted: boolean, mismatch: boolean }}
 *  converted: gerçek çarpan uygulandı (kg→g gibi)
 *  mismatch : birimler farklı ama çevrilemez (adet↔g) — qty DEĞİŞMEDİ, unit = toUnit
 */
function convertQuantity(qty, fromUnit, toUnit) {
    const from = normalizeUnit(fromUnit, 'adet');
    const to = normalizeUnit(toUnit, from);
    const q = Number(qty) || 0;
    if (from === to) return { qty: roundQty(q), unit: to, converted: false, mismatch: false };
    const a = TO_BASE[from], b = TO_BASE[to];
    if (a && b && a.dim === b.dim) {
        return { qty: roundQty(q * a.f / b.f), unit: to, converted: true, mismatch: false };
    }
    return { qty: roundQty(q), unit: to, converted: false, mismatch: true };
}

module.exports = { normalizeUnit, convertQuantity, roundQty };
