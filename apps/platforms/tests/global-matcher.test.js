// Plan 29 Faz 4.1 — Global matcher testleri

const { solveAssignment, bruteForceMatch, greedyMatch } = require('../services/dispatch/global-matcher');

describe('Global Matcher (Plan 29 Faz 4.1)', () => {

    describe('Empty/invalid input', () => {
        test('boş orderIds → empty', () => {
            const r = solveAssignment({ orderIds: [], courierIds: ['A'], scoreMatrix: [] });
            expect(r.method).toBe('empty');
            expect(r.assignments).toEqual([]);
        });

        test('boş courierIds → empty', () => {
            const r = solveAssignment({ orderIds: ['o1'], courierIds: [], scoreMatrix: [[]] });
            expect(r.method).toBe('empty');
        });

        test('invalid input → invalid_input', () => {
            const r = solveAssignment({ orderIds: null, courierIds: null, scoreMatrix: null });
            expect(r.method).toBe('invalid_input');
        });
    });

    describe('Brute-force optimal (≤6×6)', () => {
        test('1 sipariş × 1 kurye', () => {
            const r = solveAssignment({
                orderIds: ['o1'],
                courierIds: ['A'],
                scoreMatrix: [[15]]
            });
            expect(r.method).toBe('brute_force');
            expect(r.assignments).toEqual([{ orderId: 'o1', courierId: 'A', score: 15 }]);
            expect(r.totalScore).toBe(15);
        });

        test('2×2: optimal cross-assignment', () => {
            // Greedy yanlış sonuç verebilir: o1→A (10) + o2→B (yok) ama o2→A (5) + o1→B (8) daha iyi
            const r = solveAssignment({
                orderIds: ['o1', 'o2'],
                courierIds: ['A', 'B'],
                scoreMatrix: [
                    [10, 8],   // o1: A=10, B=8
                    [5, 100]   // o2: A=5, B=100
                ]
            });
            expect(r.method).toBe('brute_force');
            // Optimal: o2→A(5) + o1→B(8) = 13. Greedy yanlış: o2→A(5) + o1→B(8) = 13 aslında doğru. Test daha karmaşık matriksle.
            expect(r.totalScore).toBe(13);
        });

        test('3x3 brute-force greedy karsi optimum bulur', () => {
            // Greedy: en küçük=1 (o3,B), sonra (o1,A=2), (o2,C=10) = 13
            // Optimal: (o1,A=2) + (o2,B=3) + (o3,C=4) = 9
            const r = solveAssignment({
                orderIds: ['o1', 'o2', 'o3'],
                courierIds: ['A', 'B', 'C'],
                scoreMatrix: [
                    [2, 9, 9],
                    [9, 3, 9],
                    [9, 1, 4]
                ]
            });
            expect(r.method).toBe('brute_force');
            expect(r.totalScore).toBe(2 + 3 + 4); // 9 (optimal)
        });

        test('n > m: bazı siparişler atanmaz', () => {
            const r = solveAssignment({
                orderIds: ['o1', 'o2', 'o3'],
                courierIds: ['A'],
                scoreMatrix: [
                    [10],
                    [5],
                    [20]
                ]
            });
            // 1 kurye var, en iyi sipariş seçilir
            const assigned = r.assignments.filter(a => a.courierId !== null);
            expect(assigned.length).toBe(1);
            expect(assigned[0].score).toBe(5); // o2 en düşük skor
            const unassigned = r.assignments.filter(a => a.courierId === null);
            expect(unassigned.length).toBe(2);
        });
    });

    describe('Greedy fallback (>6×6)', () => {
        test('7×7 → greedy', () => {
            const n = 7;
            const matrix = Array.from({ length: n }, () => Array(n).fill(50));
            // Diagonal en düşük
            for (let i = 0; i < n; i++) matrix[i][i] = 10;
            const r = solveAssignment({
                orderIds: Array.from({ length: n }, (_, i) => `o${i}`),
                courierIds: Array.from({ length: n }, (_, i) => `c${i}`),
                scoreMatrix: matrix
            });
            expect(r.method).toBe('greedy');
            expect(r.totalScore).toBe(70); // 7 × 10 (diagonal)
        });
    });

    describe('Performance', () => {
        test('6×6 brute force <100ms', () => {
            const matrix = Array.from({ length: 6 }, () => Array(6).fill(0).map(() => Math.random() * 100));
            const r = solveAssignment({
                orderIds: ['o1','o2','o3','o4','o5','o6'],
                courierIds: ['c1','c2','c3','c4','c5','c6'],
                scoreMatrix: matrix
            });
            expect(r.elapsedMs).toBeLessThan(100);
            expect(r.method).toBe('brute_force');
        });
    });
});
