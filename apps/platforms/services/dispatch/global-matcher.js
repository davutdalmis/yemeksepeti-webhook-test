// ==================================================================================
// GLOBAL MATCHER — Plan 29 Faz 4.1
// ==================================================================================
// Greedy → Global geçişi: N sipariş × M kurye matriksini optimal eşleştirir.
// Sektör ilhamı: DoorDash DeepRed MIP optimization, Uber Eats global matching (greedy → %33 verim).
//
// Algoritma seçimi (matriks boyutuna göre):
//   - ≤6 sipariş × ≤6 kurye: brute-force optimal (max 720 permütasyon)
//   - 7+ × 7+: greedy best-match (sıralı en düşük skor) — Hungarian'a yakın yaklaşım
//
// Pure helper — Firestore/Redis bağımlılığı yok. Caller skor matriksini hazırlar, helper eşleştirir.
//
// Geriye uyumlu: flag globalMatchingEnabled (default false). Kapalı → caller eski greedy akışını kullanır.

/**
 * @typedef {object} MatchInput
 * @property {Array<string>} orderIds
 * @property {Array<string>} courierIds
 * @property {number[][]} scoreMatrix - scoreMatrix[i][j] = orderIds[i] x courierIds[j] skoru (düşük=iyi)
 * @property {number} [maxBruteForceSize=6] - Üstü greedy
 *
 * @typedef {object} MatchResult
 * @property {Array<{orderId: string, courierId: string|null, score: number}>} assignments
 * @property {number} totalScore
 * @property {string} method - "brute_force" | "greedy"
 * @property {number} elapsedMs
 */

const DEFAULT_MAX_BRUTE = 6;

/**
 * Brute-force optimal matching (küçük matrisler için).
 * @returns {{ assignments: Array, totalScore: number }}
 */
function bruteForceMatch(orderIds, courierIds, scoreMatrix) {
    const n = orderIds.length;
    const m = courierIds.length;
    if (n === 0 || m === 0) return { assignments: [], totalScore: 0 };

    // Permütasyon üzerinden en iyi atama (n!)
    let best = { totalScore: Infinity, mapping: null };

    function permute(arr, start, callback) {
        if (start === arr.length) { callback(arr.slice()); return; }
        for (let i = start; i < arr.length; i++) {
            [arr[start], arr[i]] = [arr[i], arr[start]];
            permute(arr, start + 1, callback);
            [arr[start], arr[i]] = [arr[i], arr[start]];
        }
    }

    // Her sipariş için kurye seçimi (n ≤ m varsayımı; n > m ise bazı siparişler atanmaz)
    if (n <= m) {
        const courierIdx = Array.from({ length: m }, (_, i) => i);
        permute(courierIdx, 0, (perm) => {
            let total = 0;
            const mapping = [];
            for (let i = 0; i < n; i++) {
                const cIdx = perm[i];
                total += scoreMatrix[i][cIdx];
                mapping.push({ orderIdx: i, courierIdx: cIdx });
                if (total >= best.totalScore) return; // erken terminasyon
            }
            if (total < best.totalScore) best = { totalScore: total, mapping };
        });
    } else {
        // n > m — bazı siparişler kuryesiz kalır. Greedy fallback (brute-force pahalı).
        return greedyMatch(orderIds, courierIds, scoreMatrix);
    }

    if (!best.mapping) return greedyMatch(orderIds, courierIds, scoreMatrix);

    return {
        assignments: best.mapping.map(({ orderIdx, courierIdx }) => ({
            orderId: orderIds[orderIdx],
            courierId: courierIds[courierIdx],
            score: scoreMatrix[orderIdx][courierIdx]
        })),
        totalScore: best.totalScore
    };
}

/**
 * Greedy best-match (büyük matrisler için).
 * Her iterasyonda matrisin minimum hücresi bulunur, o sipariş-kurye atanır, satır+sütun çıkarılır.
 */
function greedyMatch(orderIds, courierIds, scoreMatrix) {
    const n = orderIds.length;
    const m = courierIds.length;
    const usedOrders = new Set();
    const usedCouriers = new Set();
    const assignments = [];
    let totalScore = 0;

    const limit = Math.min(n, m);
    for (let iter = 0; iter < limit; iter++) {
        let minScore = Infinity, minI = -1, minJ = -1;
        for (let i = 0; i < n; i++) {
            if (usedOrders.has(i)) continue;
            for (let j = 0; j < m; j++) {
                if (usedCouriers.has(j)) continue;
                if (scoreMatrix[i][j] < minScore) {
                    minScore = scoreMatrix[i][j];
                    minI = i; minJ = j;
                }
            }
        }
        if (minI === -1) break;
        usedOrders.add(minI);
        usedCouriers.add(minJ);
        totalScore += minScore;
        assignments.push({
            orderId: orderIds[minI],
            courierId: courierIds[minJ],
            score: minScore
        });
    }

    // Atanamayan siparişleri ekle (courier=null)
    for (let i = 0; i < n; i++) {
        if (!usedOrders.has(i)) {
            assignments.push({ orderId: orderIds[i], courierId: null, score: Infinity });
        }
    }

    return { assignments, totalScore };
}

/**
 * Ana entry point. Boyuta göre algoritma seçer.
 * @param {MatchInput} input
 * @returns {MatchResult}
 */
function solveAssignment(input) {
    const startMs = Date.now();
    const { orderIds, courierIds, scoreMatrix, maxBruteForceSize } = input;

    if (!Array.isArray(orderIds) || !Array.isArray(courierIds) || !Array.isArray(scoreMatrix)) {
        return { assignments: [], totalScore: 0, method: 'invalid_input', elapsedMs: 0 };
    }

    if (orderIds.length === 0 || courierIds.length === 0) {
        return { assignments: [], totalScore: 0, method: 'empty', elapsedMs: 0 };
    }

    const limit = maxBruteForceSize || DEFAULT_MAX_BRUTE;
    const useBrute = orderIds.length <= limit && courierIds.length <= limit;
    const result = useBrute
        ? bruteForceMatch(orderIds, courierIds, scoreMatrix)
        : greedyMatch(orderIds, courierIds, scoreMatrix);

    return {
        assignments: result.assignments,
        totalScore: result.totalScore,
        method: useBrute ? 'brute_force' : 'greedy',
        elapsedMs: Date.now() - startMs
    };
}

module.exports = {
    solveAssignment,
    bruteForceMatch,
    greedyMatch
};
