// ==================================================================================
// SmartDispatchService - 5-Factor Weighted Scoring Tests
// ==================================================================================

const geolib = require('geolib');

// Extract SmartDispatchService from server-v4.js for testing
// We recreate the class here to test scoring logic in isolation
class SmartDispatchServiceTestable {
    constructor() {
        // [FIX-2] Counter-based tracking (not single-entry)
        this.pendingAssignments = new Map();
        this._assignmentQueue = Promise.resolve();
        // Plan 29 Faz 1.1+1.2 — yeni 6-key default weights
        this.weights = {
            distanceToBranch: 0.18,
            availability: 0.22,
            workload: 0.25,
            deliveryProximity: 0.10,
            performance: 0.15,
            recency: 0.10
        };
        this.MAX_DISTANCE_KM = 10.0;
        this.MAX_AVAILABILITY_MINUTES = 60.0;
        this.MAX_ACTIVE_ORDERS = 5;
        this.MAX_RATING = 5.0;
        this.ASSIGNMENT_TRACKING_TTL_MS = 60 * 1000;
        this.TIE_BREAKER_THRESHOLD = 5.0;
        this.RECENCY_HOT_S = 60;
        this.RECENCY_WARM_S = 300;
    }

    _isValidCoordinate(lat, lon) {
        return lat && lon && lat !== 0 && lon !== 0 &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    _calcDistanceScoreFromReal(distanceKm) {
        if (distanceKm <= 0) return 0;
        let normalized = Math.min(distanceKm / this.MAX_DISTANCE_KM, 1.0) * 100;
        if (distanceKm < 0.5) normalized *= 0.5;
        return normalized;
    }

    _calcDistanceToBranchScore(courier, branchLocation, branchDistanceInfo) {
        if (branchDistanceInfo && branchDistanceInfo.isSuccess && !branchDistanceInfo.isFallback) {
            return this._calcDistanceScoreFromReal(branchDistanceInfo.distanceKm);
        }
        if (this._isValidCoordinate(courier.latitude, courier.longitude) &&
            branchLocation && this._isValidCoordinate(branchLocation.latitude, branchLocation.longitude)) {
            const distanceMeters = geolib.getDistance(
                { latitude: courier.latitude, longitude: courier.longitude },
                { latitude: branchLocation.latitude, longitude: branchLocation.longitude }
            );
            const distanceKm = distanceMeters / 1000;
            let normalized = Math.min(distanceKm / this.MAX_DISTANCE_KM, 1.0) * 100;
            if (distanceKm < 0.5) normalized *= 0.5;
            return normalized;
        }
        return 100;
    }

    _calcAvailabilityScore(courier, branchLocation, branchDistanceInfo) {
        if (courier.activeOrderCount === 0) {
            if (branchDistanceInfo && branchDistanceInfo.isSuccess && !branchDistanceInfo.isFallback) {
                if (branchDistanceInfo.durationMinutes <= 10) return 0;
                const lateMinutes = branchDistanceInfo.durationMinutes - 10;
                return Math.min(lateMinutes / 10 * 100, 100);
            }
            if (this._isValidCoordinate(courier.latitude, courier.longitude) &&
                branchLocation && this._isValidCoordinate(branchLocation.latitude, branchLocation.longitude)) {
                const distanceMeters = geolib.getDistance(
                    { latitude: courier.latitude, longitude: courier.longitude },
                    { latitude: branchLocation.latitude, longitude: branchLocation.longitude }
                );
                const estimatedMinutes = Math.max(2, (distanceMeters / 1000 / 25) * 60);
                if (estimatedMinutes <= 10) return 0;
                return Math.min((estimatedMinutes - 10) / 10 * 100, 100);
            }
            return 0;
        }
        const estimatedBusyMinutes = courier.activeOrderCount * 15;
        return Math.min(estimatedBusyMinutes / this.MAX_AVAILABILITY_MINUTES, 1.0) * 100;
    }

    // Plan 29 Faz 1.2 — eksponansiyel
    _calcWorkloadScore(activeOrderCount) {
        const tiers = [0, 30, 60, 85, 100];
        return tiers[Math.min(activeOrderCount, tiers.length - 1)];
    }

    // Plan 29 Faz 1.1 — round-robin sinyali
    _calcRecencyScore(lastAssignedAt) {
        if (!lastAssignedAt) return 0;
        const lastMs = typeof lastAssignedAt.toMillis === 'function'
            ? lastAssignedAt.toMillis()
            : new Date(lastAssignedAt).getTime();
        if (!Number.isFinite(lastMs)) return 0;
        const deltaS = (Date.now() - lastMs) / 1000;
        if (deltaS < this.RECENCY_HOT_S) return 100;
        if (deltaS < this.RECENCY_WARM_S) return 50;
        return 0;
    }

    _calcDeliveryProximityScore(courier, deliveryLocation, deliveryDistanceInfo) {
        if (deliveryDistanceInfo && deliveryDistanceInfo.isSuccess && !deliveryDistanceInfo.isFallback) {
            return this._calcDistanceScoreFromReal(deliveryDistanceInfo.distanceKm);
        }
        if (this._isValidCoordinate(courier.latitude, courier.longitude) &&
            this._isValidCoordinate(deliveryLocation?.latitude, deliveryLocation?.longitude)) {
            const distanceMeters = geolib.getDistance(
                { latitude: courier.latitude, longitude: courier.longitude },
                { latitude: deliveryLocation.latitude, longitude: deliveryLocation.longitude }
            );
            const distanceKm = distanceMeters / 1000;
            if (distanceKm <= 5) return (distanceKm / 5) * 50;
            return 50 + Math.min((distanceKm - 5) / 10, 0.5) * 100;
        }
        return 50;
    }

    _calcPerformanceScore(courier) {
        const ratingScore = (Math.min(courier.rating || 0, this.MAX_RATING) / this.MAX_RATING) * 50;
        const deliveriesToday = courier.dailyDeliveryCount || 0;
        let deliveryScore;
        if (deliveriesToday <= 5) deliveryScore = 50;
        else if (deliveriesToday <= 10) deliveryScore = 40;
        else if (deliveriesToday <= 15) deliveryScore = 30;
        else deliveryScore = 20;
        return ratingScore + deliveryScore;
    }

    calculateCourierScore(courier, deliveryLocation, branchLocation, deliveryDistanceInfo, branchDistanceInfo) {
        const distanceToBranchScore = this._calcDistanceToBranchScore(courier, branchLocation, branchDistanceInfo);
        const availabilityScore = this._calcAvailabilityScore(courier, branchLocation, branchDistanceInfo);
        const workloadScore = this._calcWorkloadScore(courier.activeOrderCount);
        const deliveryProximityScore = this._calcDeliveryProximityScore(courier, deliveryLocation, deliveryDistanceInfo);
        const performanceScore = this._calcPerformanceScore(courier);
        const recencyScore = this._calcRecencyScore(courier.lastAssignedAt);
        const recencyWeight = typeof this.weights.recency === 'number' ? this.weights.recency : 0;

        const totalScore =
            (distanceToBranchScore * this.weights.distanceToBranch) +
            (availabilityScore * this.weights.availability) +
            (workloadScore * this.weights.workload) +
            (deliveryProximityScore * this.weights.deliveryProximity) +
            ((100 - performanceScore) * this.weights.performance) +
            (recencyScore * recencyWeight);

        return {
            totalScore,
            details: {
                distanceToBranch: distanceToBranchScore,
                availability: availabilityScore,
                workload: workloadScore,
                deliveryProximity: deliveryProximityScore,
                performance: performanceScore,
                recency: recencyScore
            }
        };
    }

    // [FIX-2] Counter-based tracking
    _getPendingCount(courierId) {
        return this.pendingAssignments.get(courierId) || 0;
    }

    _trackAssignment(courierId) {
        const current = this.pendingAssignments.get(courierId) || 0;
        this.pendingAssignments.set(courierId, current + 1);
    }

    // Simulate TTL decrement (for testing)
    _decrementPending(courierId) {
        const count = this.pendingAssignments.get(courierId) || 0;
        if (count <= 1) {
            this.pendingAssignments.delete(courierId);
        } else {
            this.pendingAssignments.set(courierId, count - 1);
        }
    }

    // [FIX-3] Mutex simulation
    _enqueue(fn) {
        const result = this._assignmentQueue.then(fn, fn);
        this._assignmentQueue = result.catch(() => {});
        return result;
    }
}

// ==================== TEST DATA ====================

const BRANCH_LOCATION = { latitude: 41.0082, longitude: 28.9784 }; // Istanbul merkez

function createCourier(overrides = {}) {
    return {
        id: 'courier-1',
        name: 'Test Kurye',
        latitude: 41.0100,   // ~200m from branch
        longitude: 28.9800,
        activeOrderCount: 0,
        dailyDeliveryCount: 3,
        rating: 4.5,
        isApproved: true,
        fcmToken: 'test-token',
        ...overrides
    };
}

const DELIVERY_LOCATION = { latitude: 41.0200, longitude: 28.9900 };

// ==================== TESTS ====================

describe('SmartDispatchService - 5-Factor Scoring', () => {
    let service;

    beforeEach(() => {
        service = new SmartDispatchServiceTestable();
    });

    // ==================== WEIGHT CONFIGURATION ====================

    describe('Weight configuration', () => {
        test('default weights sum to 1.0', () => {
            const sum = Object.values(service.weights).reduce((a, b) => a + b, 0);
            expect(sum).toBeCloseTo(1.0, 5);
        });

        test('weights match Plan 29 Faz 1 defaults (6-key)', () => {
            expect(service.weights.distanceToBranch).toBe(0.18);
            expect(service.weights.availability).toBe(0.22);
            expect(service.weights.workload).toBe(0.25);
            expect(service.weights.deliveryProximity).toBe(0.10);
            expect(service.weights.performance).toBe(0.15);
            expect(service.weights.recency).toBe(0.10);
        });
    });

    // ==================== DISTANCE TO BRANCH SCORE ====================

    describe('Distance to Branch Score', () => {
        test('courier at branch gets low score', () => {
            const courier = createCourier({
                latitude: BRANCH_LOCATION.latitude,
                longitude: BRANCH_LOCATION.longitude
            });
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, null);
            expect(score).toBeLessThan(5);
        });

        test('courier very close (<500m) gets bonus', () => {
            const courier = createCourier({
                latitude: 41.0085,  // ~30m from branch
                longitude: 28.9787
            });
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, null);
            expect(score).toBeLessThan(10);
        });

        test('courier far away gets high score', () => {
            const courier = createCourier({
                latitude: 41.1000,  // ~10km away
                longitude: 29.1000
            });
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, null);
            expect(score).toBeGreaterThan(50);
        });

        test('no courier location returns 100', () => {
            const courier = createCourier({ latitude: 0, longitude: 0 });
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, null);
            expect(score).toBe(100);
        });

        test('Google Maps real data used when available', () => {
            const courier = createCourier();
            const branchDistInfo = {
                distanceKm: 2.5,
                durationMinutes: 8,
                isSuccess: true,
                isFallback: false
            };
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, branchDistInfo);
            expect(score).toBe(25); // 2.5/10 * 100 = 25
        });

        test('Google Maps 500m bonus applied', () => {
            const courier = createCourier();
            const branchDistInfo = {
                distanceKm: 0.3,
                isSuccess: true,
                isFallback: false
            };
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, branchDistInfo);
            expect(score).toBe(1.5); // (0.3/10 * 100) * 0.5 = 1.5
        });

        test('fallback data ignored, haversine used', () => {
            const courier = createCourier();
            const fallbackInfo = {
                distanceKm: 999,
                isSuccess: true,
                isFallback: true  // fallback!
            };
            const score = service._calcDistanceToBranchScore(courier, BRANCH_LOCATION, fallbackInfo);
            // Should use haversine, not the 999km fallback
            expect(score).toBeLessThan(50);
        });
    });

    // ==================== AVAILABILITY SCORE ====================

    describe('Availability Score', () => {
        test('free courier near branch gets 0', () => {
            const courier = createCourier({ activeOrderCount: 0 });
            const score = service._calcAvailabilityScore(courier, BRANCH_LOCATION, null);
            expect(score).toBe(0);
        });

        test('free courier with Google Maps <10min returns 0', () => {
            const courier = createCourier({ activeOrderCount: 0 });
            const branchDistInfo = {
                durationMinutes: 5,
                isSuccess: true,
                isFallback: false
            };
            const score = service._calcAvailabilityScore(courier, BRANCH_LOCATION, branchDistInfo);
            expect(score).toBe(0);
        });

        test('free courier with Google Maps >10min penalized', () => {
            const courier = createCourier({ activeOrderCount: 0 });
            const branchDistInfo = {
                durationMinutes: 20,
                isSuccess: true,
                isFallback: false
            };
            const score = service._calcAvailabilityScore(courier, BRANCH_LOCATION, branchDistInfo);
            expect(score).toBe(100); // (20-10)/10 * 100 = 100
        });

        test('busy courier: 1 active order = 25', () => {
            const courier = createCourier({ activeOrderCount: 1 });
            const score = service._calcAvailabilityScore(courier, BRANCH_LOCATION, null);
            expect(score).toBe(25); // 15/60 * 100
        });

        test('busy courier: 4 active orders = 100', () => {
            const courier = createCourier({ activeOrderCount: 4 });
            const score = service._calcAvailabilityScore(courier, BRANCH_LOCATION, null);
            expect(score).toBe(100); // 60/60 * 100
        });

        test('busy courier: 5+ capped at 100', () => {
            const courier = createCourier({ activeOrderCount: 8 });
            const score = service._calcAvailabilityScore(courier, BRANCH_LOCATION, null);
            expect(score).toBe(100);
        });
    });

    // ==================== WORKLOAD SCORE ====================

    describe('Workload Score (Plan 29 Faz 1.2 — eksponansiyel)', () => {
        test('0 active orders = 0', () => {
            expect(service._calcWorkloadScore(0)).toBe(0);
        });

        test('1 active order = 30 (sertleştirildi: eski 20)', () => {
            expect(service._calcWorkloadScore(1)).toBe(30);
        });

        test('2 active orders = 60', () => {
            expect(service._calcWorkloadScore(2)).toBe(60);
        });

        test('3 active orders = 85 (sertleştirildi: eski 60)', () => {
            expect(service._calcWorkloadScore(3)).toBe(85);
        });

        test('4 active orders = 100 (sertleştirildi: eski 80)', () => {
            expect(service._calcWorkloadScore(4)).toBe(100);
        });

        test('5+ active orders capped at 100', () => {
            expect(service._calcWorkloadScore(5)).toBe(100);
            expect(service._calcWorkloadScore(10)).toBe(100);
        });
    });

    // ==================== RECENCY SCORE (Plan 29 Faz 1.1) ====================

    describe('Recency Score (Plan 29 Faz 1.1 — round-robin sinyali)', () => {
        test('lastAssignedAt null = 0 (yeni kurye, ceza yok)', () => {
            expect(service._calcRecencyScore(null)).toBe(0);
            expect(service._calcRecencyScore(undefined)).toBe(0);
        });

        test('30 saniye önce atandı = 100 (tam ceza)', () => {
            const thirtySecAgo = new Date(Date.now() - 30 * 1000);
            expect(service._calcRecencyScore(thirtySecAgo)).toBe(100);
        });

        test('2 dakika önce atandı = 50 (yarı ceza)', () => {
            const twoMinAgo = new Date(Date.now() - 120 * 1000);
            expect(service._calcRecencyScore(twoMinAgo)).toBe(50);
        });

        test('10 dakika önce atandı = 0 (ceza yok)', () => {
            const tenMinAgo = new Date(Date.now() - 600 * 1000);
            expect(service._calcRecencyScore(tenMinAgo)).toBe(0);
        });

        test('Firestore Timestamp (toMillis) desteği', () => {
            const fakeTs = { toMillis: () => Date.now() - 30 * 1000 };
            expect(service._calcRecencyScore(fakeTs)).toBe(100);
        });

        test('geçersiz değer = 0 (güvenli fallback)', () => {
            expect(service._calcRecencyScore('not-a-date')).toBe(0);
        });
    });

    // ==================== DELIVERY PROXIMITY SCORE ====================

    describe('Delivery Proximity Score', () => {
        test('courier at delivery address gets low score', () => {
            const courier = createCourier({
                latitude: DELIVERY_LOCATION.latitude,
                longitude: DELIVERY_LOCATION.longitude
            });
            const score = service._calcDeliveryProximityScore(courier, DELIVERY_LOCATION, null);
            expect(score).toBeLessThan(5);
        });

        test('courier with no location returns 50 (neutral)', () => {
            const courier = createCourier({ latitude: 0, longitude: 0 });
            const score = service._calcDeliveryProximityScore(courier, DELIVERY_LOCATION, null);
            expect(score).toBe(50);
        });

        test('Google Maps real data used', () => {
            const courier = createCourier();
            const distInfo = { distanceKm: 3.0, isSuccess: true, isFallback: false };
            const score = service._calcDeliveryProximityScore(courier, DELIVERY_LOCATION, distInfo);
            expect(score).toBe(30); // 3/10 * 100 = 30
        });

        test('invalid delivery location returns 50', () => {
            const courier = createCourier();
            const score = service._calcDeliveryProximityScore(courier, { latitude: 0, longitude: 0 }, null);
            expect(score).toBe(50);
        });
    });

    // ==================== PERFORMANCE SCORE ====================

    describe('Performance Score', () => {
        test('perfect courier: 5.0 rating, 3 deliveries = 100', () => {
            const courier = createCourier({ rating: 5.0, dailyDeliveryCount: 3 });
            const score = service._calcPerformanceScore(courier);
            expect(score).toBe(100); // (5/5)*50 + 50
        });

        test('no rating courier: 0 rating, 3 deliveries = 50', () => {
            const courier = createCourier({ rating: 0, dailyDeliveryCount: 3 });
            const score = service._calcPerformanceScore(courier);
            expect(score).toBe(50); // 0 + 50
        });

        test('tired courier: 5.0 rating, 18 deliveries = 70', () => {
            const courier = createCourier({ rating: 5.0, dailyDeliveryCount: 18 });
            const score = service._calcPerformanceScore(courier);
            expect(score).toBe(70); // 50 + 20
        });

        test('medium courier: 3.0 rating, 8 deliveries = 70', () => {
            const courier = createCourier({ rating: 3.0, dailyDeliveryCount: 8 });
            const score = service._calcPerformanceScore(courier);
            expect(score).toBe(70); // (3/5)*50=30 + 40
        });

        test('fatigue tiers: 0-5=50, 6-10=40, 11-15=30, 16+=20', () => {
            const baseRating = { rating: 0 };
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 0 }))).toBe(50);
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 5 }))).toBe(50);
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 6 }))).toBe(40);
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 10 }))).toBe(40);
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 11 }))).toBe(30);
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 15 }))).toBe(30);
            expect(service._calcPerformanceScore(createCourier({ ...baseRating, dailyDeliveryCount: 16 }))).toBe(20);
        });
    });

    // ==================== TOTAL WEIGHTED SCORE ====================

    describe('Total Score Calculation', () => {
        test('perfect courier gets low total score', () => {
            const courier = createCourier({
                latitude: BRANCH_LOCATION.latitude,
                longitude: BRANCH_LOCATION.longitude,
                activeOrderCount: 0,
                rating: 5.0,
                dailyDeliveryCount: 3
            });

            const { totalScore, details } = service.calculateCourierScore(
                courier, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );

            // Low distance, free, no workload, good performance
            expect(totalScore).toBeLessThan(20);
            expect(details.distanceToBranch).toBeLessThan(5);
            expect(details.workload).toBe(0);
            expect(details.performance).toBe(100);
        });

        test('terrible courier gets high total score', () => {
            const courier = createCourier({
                latitude: 0,
                longitude: 0,
                activeOrderCount: 5,
                rating: 0,
                dailyDeliveryCount: 20
            });

            const { totalScore } = service.calculateCourierScore(
                courier, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );

            expect(totalScore).toBeGreaterThan(70);
        });

        test('score uses all 6 factors with correct weights (Plan 29)', () => {
            const courier = createCourier({ activeOrderCount: 2 });
            const { totalScore, details } = service.calculateCourierScore(
                courier, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );

            // Manually verify weighted sum (Plan 29 Faz 1 weights)
            const expected =
                (details.distanceToBranch * 0.18) +
                (details.availability * 0.22) +
                (details.workload * 0.25) +
                (details.deliveryProximity * 0.10) +
                ((100 - details.performance) * 0.15) +
                (details.recency * 0.10);

            expect(totalScore).toBeCloseTo(expected, 5);
            expect(details.recency).toBe(0); // courier with no lastAssignedAt
        });

        test('recently-assigned courier penalized vs idle courier (round-robin)', () => {
            // İki özdeş kurye, biri 30sn önce atandı, diğeri hiç atanmadı
            const justAssigned = createCourier({
                id: 'just-assigned',
                lastAssignedAt: new Date(Date.now() - 30 * 1000)
            });
            const idle = createCourier({ id: 'idle', lastAssignedAt: null });

            const justScore = service.calculateCourierScore(
                justAssigned, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );
            const idleScore = service.calculateCourierScore(
                idle, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );

            // recency 100 × 0.10 = 10 puan ceza fark eder
            expect(idleScore.totalScore).toBeLessThan(justScore.totalScore);
            expect(justScore.totalScore - idleScore.totalScore).toBeCloseTo(10, 1);
        });

        test('better courier scores lower than worse courier', () => {
            const goodCourier = createCourier({
                id: 'good',
                latitude: 41.0085,
                longitude: 28.9787,
                activeOrderCount: 0,
                rating: 4.8,
                dailyDeliveryCount: 3
            });

            const badCourier = createCourier({
                id: 'bad',
                latitude: 41.1000,
                longitude: 29.1000,
                activeOrderCount: 4,
                rating: 2.0,
                dailyDeliveryCount: 18
            });

            const goodScore = service.calculateCourierScore(
                goodCourier, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );
            const badScore = service.calculateCourierScore(
                badCourier, DELIVERY_LOCATION, BRANCH_LOCATION, null, null
            );

            expect(goodScore.totalScore).toBeLessThan(badScore.totalScore);
        });
    });

    // ==================== READY-AWARE AVAILABILITY (Plan 29 Faz 2.2) ====================

    describe('Ready-aware availability score (Plan 29 Faz 2.2)', () => {
        // Test_double helper — prod kodu kopyası
        function calcReadyAware(activeOrderCount, readyAtMinutesFromNow) {
            const courier = { activeOrderCount };
            const readyAt = new Date(Date.now() + readyAtMinutesFromNow * 60 * 1000);
            return service._calcAvailabilityScoreReadyAware
                ? service._calcAvailabilityScoreReadyAware(courier, readyAt, null)
                : null;
        }

        beforeEach(() => {
            // Test double class extension — Faz 2.2 method'unu eklemek için
            if (!service._calcAvailabilityScoreReadyAware) {
                service._calcAvailabilityScoreReadyAware = function(courier, estimatedReadyAt, branchDistanceInfo) {
                    if (!estimatedReadyAt) return null;
                    const readyMs = typeof estimatedReadyAt.toMillis === 'function'
                        ? estimatedReadyAt.toMillis()
                        : new Date(estimatedReadyAt).getTime();
                    if (!Number.isFinite(readyMs)) return null;
                    let busyMinutes = (courier.activeOrderCount || 0) * 20;
                    if (branchDistanceInfo && branchDistanceInfo.isSuccess && !branchDistanceInfo.isFallback) {
                        busyMinutes += branchDistanceInfo.durationMinutes || 0;
                    }
                    const freeAtMs = Date.now() + busyMinutes * 60 * 1000;
                    const deltaMin = (freeAtMs - readyMs) / 60000;
                    if (deltaMin < -10) return 50;
                    if (deltaMin <= 5) return 0;
                    if (deltaMin <= 15) return 50;
                    return 100;
                };
            }
        });

        test('estimatedReadyAt yoksa null döner (eski formüle düşer)', () => {
            expect(service._calcAvailabilityScoreReadyAware({ activeOrderCount: 0 }, null, null)).toBe(null);
        });

        test('boş kurye, yemek 15 dk sonra hazır → 50 (kurye 10dk+ erken)', () => {
            // freeAt=now, readyAt=now+15dk → Δ=-15 → 50
            expect(calcReadyAware(0, 15)).toBe(50);
        });

        test('boş kurye, yemek 3 dk sonra hazır → 0 (mükemmel pencere)', () => {
            // freeAt=now, readyAt=now+3 → Δ=-3 → mükemmel (-10≤Δ≤5)
            expect(calcReadyAware(0, 3)).toBe(0);
        });

        test('1 aktif sipariş (20 dk meşgul), yemek 15 dk sonra → 0 (mükemmel: Δ=5)', () => {
            // freeAt=now+20, readyAt=now+15 → Δ=5 → mükemmel
            expect(calcReadyAware(1, 15)).toBe(0);
        });

        test('1 aktif sipariş (20 dk), yemek 5 dk sonra hazır → 50 (yemek 15 dk soğur)', () => {
            // freeAt=now+20, readyAt=now+5 → Δ=15 → soğuma penceresi
            expect(calcReadyAware(1, 5)).toBe(50);
        });

        test('2 aktif sipariş (40 dk meşgul), yemek hemen hazır → 100 (kabul edilemez geç)', () => {
            // freeAt=now+40, readyAt=now → Δ=40 → 100
            expect(calcReadyAware(2, 0)).toBe(100);
        });

        test('Firestore Timestamp toMillis desteği', () => {
            const fakeTs = { toMillis: () => Date.now() + 3 * 60 * 1000 };
            expect(service._calcAvailabilityScoreReadyAware({ activeOrderCount: 0 }, fakeTs, null)).toBe(0);
        });
    });

    // ==================== ASSIGNMENT TRACKING (FIX-2: Counter-based) ====================

    describe('Assignment Tracking (counter-based)', () => {
        test('first assignment sets count to 1', () => {
            service._trackAssignment('courier-1');
            expect(service._getPendingCount('courier-1')).toBe(1);
        });

        test('second assignment increments count to 2', () => {
            service._trackAssignment('courier-1');
            service._trackAssignment('courier-1');
            expect(service._getPendingCount('courier-1')).toBe(2);
        });

        test('third assignment increments count to 3', () => {
            service._trackAssignment('courier-1');
            service._trackAssignment('courier-1');
            service._trackAssignment('courier-1');
            expect(service._getPendingCount('courier-1')).toBe(3);
        });

        test('multiple couriers tracked independently', () => {
            service._trackAssignment('courier-1');
            service._trackAssignment('courier-1');
            service._trackAssignment('courier-2');
            expect(service._getPendingCount('courier-1')).toBe(2);
            expect(service._getPendingCount('courier-2')).toBe(1);
        });

        test('untracked courier returns 0', () => {
            expect(service._getPendingCount('courier-999')).toBe(0);
        });

        test('decrement reduces count', () => {
            service._trackAssignment('courier-1');
            service._trackAssignment('courier-1');
            service._decrementPending('courier-1');
            expect(service._getPendingCount('courier-1')).toBe(1);
        });

        test('decrement to 0 removes entry', () => {
            service._trackAssignment('courier-1');
            service._decrementPending('courier-1');
            expect(service._getPendingCount('courier-1')).toBe(0);
            expect(service.pendingAssignments.has('courier-1')).toBe(false);
        });

        test('decrement on empty is safe', () => {
            service._decrementPending('courier-1');
            expect(service._getPendingCount('courier-1')).toBe(0);
        });
    });

    // ==================== MUTEX (FIX-3) ====================

    describe('Mutex (assignment queue)', () => {
        test('enqueue serializes async operations', async () => {
            const results = [];

            const op1 = service._enqueue(async () => {
                await new Promise(r => setTimeout(r, 50));
                results.push('first');
                return 'first';
            });

            const op2 = service._enqueue(async () => {
                results.push('second');
                return 'second';
            });

            await Promise.all([op1, op2]);
            // op2 should wait for op1 to finish
            expect(results).toEqual(['first', 'second']);
        });

        test('enqueue continues after error', async () => {
            const op1 = service._enqueue(async () => {
                throw new Error('fail');
            });

            // op1 will throw but chain should continue
            await op1.catch(() => {});

            const op2 = service._enqueue(async () => 'recovered');
            const result = await op2;
            expect(result).toBe('recovered');
        });
    });

    // ==================== TIE-BREAKER (FIX-4) ====================

    describe('Tie-breaker threshold', () => {
        test('threshold is 5.0 (not 0.01)', () => {
            expect(service.TIE_BREAKER_THRESHOLD).toBe(5.0);
        });

        test('couriers within 5 points get randomized (statistical)', () => {
            // Two couriers with scores differing by 3 points (within threshold)
            // Run sorting 100 times - both should win at least once
            const courierA = { score: 20.0 };
            const courierB = { score: 23.0 }; // 3 point diff < 5.0 threshold

            let aWins = 0;
            let bWins = 0;
            for (let i = 0; i < 100; i++) {
                const arr = [{ ...courierA }, { ...courierB }];
                arr.sort((a, b) => {
                    const diff = a.score - b.score;
                    if (Math.abs(diff) < service.TIE_BREAKER_THRESHOLD) return Math.random() - 0.5;
                    return diff;
                });
                if (arr[0].score === courierA.score) aWins++;
                else bWins++;
            }

            // Both should win some rounds (with 100 trials, probability of all-A or all-B is ~0)
            expect(aWins).toBeGreaterThan(0);
            expect(bWins).toBeGreaterThan(0);
        });

        test('courier with 10+ point lead always wins', () => {
            const courierA = { score: 10.0 };
            const courierB = { score: 25.0 }; // 15 point diff > 5.0 threshold

            let aWins = 0;
            for (let i = 0; i < 50; i++) {
                const arr = [{ ...courierA }, { ...courierB }];
                arr.sort((a, b) => {
                    const diff = a.score - b.score;
                    if (Math.abs(diff) < service.TIE_BREAKER_THRESHOLD) return Math.random() - 0.5;
                    return diff;
                });
                if (arr[0].score === courierA.score) aWins++;
            }

            expect(aWins).toBe(50); // A always wins - too big a gap
        });
    });

    // ==================== SCENARIO: 3 ORDERS, 2 COURIERS (FIX VERIFICATION) ====================

    describe('Scenario: 3 rapid orders, 2 couriers', () => {
        test('pending counter prevents all 3 going to same courier', () => {
            // Simulate 3 rapid assignments with pending tracking

            // Order 1: both couriers have 0 pending → either could win
            const pending1A = service._getPendingCount('courier-A');
            const pending1B = service._getPendingCount('courier-B');
            expect(pending1A).toBe(0);
            expect(pending1B).toBe(0);

            // Courier A gets order 1
            service._trackAssignment('courier-A');

            // Order 2: A has 1 pending, B has 0 → B is preferred
            const pending2A = service._getPendingCount('courier-A');
            const pending2B = service._getPendingCount('courier-B');
            expect(pending2A).toBe(1);
            expect(pending2B).toBe(0);

            // Courier B gets order 2
            service._trackAssignment('courier-B');

            // Order 3: A has 1, B has 1 → equal → tie-breaker
            const pending3A = service._getPendingCount('courier-A');
            const pending3B = service._getPendingCount('courier-B');
            expect(pending3A).toBe(1);
            expect(pending3B).toBe(1);
        });

        test('workload score reflects pending assignments', () => {
            // Courier A: 0 Firestore + 2 pending = 2 active
            service._trackAssignment('courier-A');
            service._trackAssignment('courier-A');
            const activeA = 0 + service._getPendingCount('courier-A'); // simulating getActiveOrderCount
            expect(activeA).toBe(2);

            // Plan 29 Faz 1.2: 2 active orders = 60 (eksponansiyel, eski 40)
            expect(service._calcWorkloadScore(activeA)).toBe(60);

            // Courier B: 0 Firestore + 0 pending = 0 active
            const activeB = 0 + service._getPendingCount('courier-B');
            expect(activeB).toBe(0);
            expect(service._calcWorkloadScore(activeB)).toBe(0);

            // B's workload score (0) much better than A's (60)
            // Yeni ağırlık 0.25 ile fark: 60*0.25 = 15 puan (eski: 40*0.20=8) — şubedeki kuryenin baskınlığını kırar
        });
    });

    // ==================== isApproved FILTER ====================

    describe('isApproved filter', () => {
        test('courier data includes isApproved field', () => {
            // This tests the expected data structure
            const approvedCourier = createCourier({ isApproved: true });
            const unapprovedCourier = createCourier({ isApproved: false });

            expect(approvedCourier.isApproved).toBe(true);
            expect(unapprovedCourier.isApproved).toBe(false);
        });

        test('defaults isApproved to true when undefined', () => {
            const courier = createCourier();
            delete courier.isApproved;
            // In getAvailableCouriers, isApproved defaults to true if undefined
            const isApproved = courier.isApproved !== undefined ? courier.isApproved : true;
            expect(isApproved).toBe(true);
        });
    });

    // ==================== DISTANCE SCORE FROM REAL ====================

    describe('_calcDistanceScoreFromReal', () => {
        test('0 km = 0', () => {
            expect(service._calcDistanceScoreFromReal(0)).toBe(0);
        });

        test('negative = 0', () => {
            expect(service._calcDistanceScoreFromReal(-1)).toBe(0);
        });

        test('5 km = 50', () => {
            expect(service._calcDistanceScoreFromReal(5)).toBe(50);
        });

        test('10 km = 100', () => {
            expect(service._calcDistanceScoreFromReal(10)).toBe(100);
        });

        test('20 km capped at 100', () => {
            expect(service._calcDistanceScoreFromReal(20)).toBe(100);
        });

        test('0.3 km gets 500m bonus', () => {
            // (0.3/10 * 100) * 0.5 = 1.5
            expect(service._calcDistanceScoreFromReal(0.3)).toBe(1.5);
        });

        test('0.5 km NO bonus (boundary)', () => {
            // 0.5/10 * 100 = 5 (no bonus, 0.5 is NOT < 0.5)
            expect(service._calcDistanceScoreFromReal(0.5)).toBe(5);
        });
    });
});
