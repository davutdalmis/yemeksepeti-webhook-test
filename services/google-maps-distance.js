// ==================================================================================
// GOOGLE MAPS DISTANCE MATRIX SERVICE
// ==================================================================================
// Kurye mesafe/süre hesaplamalarında gerçek yol verisi sağlar
// API key yoksa veya hata olursa geolib (Haversine) fallback kullanır
// ==================================================================================

const axios = require('axios');
const geolib = require('geolib');

const API_BASE_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const MAX_ORIGINS_PER_REQUEST = 25;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 dakika
const CACHE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 dakika
const MOTORCYCLE_SPEED_KMH = 25;

class GoogleMapsDistanceService {
    constructor() {
        this.apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
        this.cache = new Map();
        this.httpClient = axios.create({ timeout: 10000 });

        // Cache cleanup interval
        this._cleanupInterval = setInterval(() => this._cleanupCache(), CACHE_CLEANUP_INTERVAL_MS);
    }

    /**
     * Google Maps API yapılandırılmış mı?
     */
    get isConfigured() {
        return !!this.apiKey;
    }

    /**
     * Birden fazla kuryenin tek bir hedefe olan mesafe/süresini toplu hesaplar
     * @param {Array} couriers - [{id, latitude, longitude, name}]
     * @param {{latitude: number, longitude: number}} destination
     * @returns {Map<string, {distanceMeters, distanceKm, durationSeconds, durationMinutes, isSuccess, isFallback, source}>}
     */
    async getBatchDistances(couriers, destination) {
        const results = new Map();
        let fallbackCount = 0;

        if (!couriers || couriers.length === 0) {
            return { results, isSuccess: true, fallbackCount: 0 };
        }

        // Geçerli koordinatlı kuryeleri filtrele
        const validCouriers = [];
        for (const courier of couriers) {
            if (this._isValidCoordinate(courier.latitude, courier.longitude)) {
                validCouriers.push(courier);
            } else {
                results.set(courier.id, this._createFallback(courier, destination));
                fallbackCount++;
            }
        }

        if (validCouriers.length === 0 ||
            !this._isValidCoordinate(destination.latitude, destination.longitude)) {
            // Geçersiz hedef - tüm fallback
            for (const courier of validCouriers) {
                results.set(courier.id, this._createFallback(courier, destination));
                fallbackCount++;
            }
            return { results, isSuccess: true, fallbackCount };
        }

        // Cache kontrolü
        const uncachedCouriers = [];
        for (const courier of validCouriers) {
            const cacheKey = this._buildCacheKey(courier.latitude, courier.longitude,
                destination.latitude, destination.longitude);
            const cached = this.cache.get(cacheKey);

            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
                results.set(courier.id, { ...cached.data, source: 'cache' });
            } else {
                uncachedCouriers.push(courier);
            }
        }

        // API key yoksa fallback
        if (!this.isConfigured) {
            for (const courier of uncachedCouriers) {
                results.set(courier.id, this._createFallback(courier, destination));
                fallbackCount++;
            }
            return { results, isSuccess: true, fallbackCount };
        }

        // API'den al (25'lik gruplar halinde)
        const batches = this._splitIntoBatches(uncachedCouriers, MAX_ORIGINS_PER_REQUEST);
        for (const batch of batches) {
            try {
                await this._fetchFromApi(batch, destination, results);
            } catch (error) {
                console.error('[GoogleMaps] API batch error:', error.message);
                for (const courier of batch) {
                    if (!results.has(courier.id)) {
                        results.set(courier.id, this._createFallback(courier, destination));
                        fallbackCount++;
                    }
                }
            }
        }

        return { results, isSuccess: true, fallbackCount };
    }

    /**
     * Google Distance Matrix API'ye istek gönderir
     */
    async _fetchFromApi(couriers, destination, results) {
        const origins = couriers
            .map(c => `${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`)
            .join('|');
        const dest = `${destination.latitude.toFixed(6)},${destination.longitude.toFixed(6)}`;

        const response = await this.httpClient.get(API_BASE_URL, {
            params: {
                origins,
                destinations: dest,
                mode: 'driving',
                departure_time: 'now',
                traffic_model: 'best_guess',
                key: this.apiKey
            }
        });

        const data = response.data;

        if (!data || data.status !== 'OK') {
            console.warn(`[GoogleMaps] API error status: ${data?.status || 'null'}`);
            for (const courier of couriers) {
                results.set(courier.id, this._createFallback(courier, destination));
            }
            return;
        }

        for (let i = 0; i < couriers.length && i < data.rows.length; i++) {
            const courier = couriers[i];
            const row = data.rows[i];

            if (row.elements && row.elements[0] && row.elements[0].status === 'OK') {
                const element = row.elements[0];
                const duration = element.duration_in_traffic || element.duration;
                const distance = element.distance;

                if (duration && distance) {
                    const info = {
                        distanceMeters: distance.value,
                        distanceKm: distance.value / 1000,
                        durationSeconds: duration.value,
                        durationMinutes: duration.value / 60,
                        isSuccess: true,
                        isFallback: false,
                        source: 'api'
                    };

                    results.set(courier.id, info);

                    // Cache'e yaz
                    const cacheKey = this._buildCacheKey(
                        courier.latitude, courier.longitude,
                        destination.latitude, destination.longitude);
                    this.cache.set(cacheKey, { data: info, timestamp: Date.now() });

                    console.log(`[GoogleMaps] ${courier.name || courier.id}: ${info.distanceKm.toFixed(1)}km, ${info.durationMinutes.toFixed(1)}dk (source: api)`);
                    continue;
                }
            }

            // Element hatası - fallback
            results.set(courier.id, this._createFallback(courier, destination));
        }
    }

    /**
     * Haversine tabanlı fallback mesafe bilgisi oluşturur
     */
    _createFallback(courier, destination) {
        if (!this._isValidCoordinate(courier.latitude, courier.longitude) ||
            !this._isValidCoordinate(destination.latitude, destination.longitude)) {
            return {
                distanceMeters: 0,
                distanceKm: 0,
                durationSeconds: 0,
                durationMinutes: 0,
                isSuccess: false,
                isFallback: true,
                source: 'fallback'
            };
        }

        const distanceMeters = geolib.getDistance(
            { latitude: courier.latitude, longitude: courier.longitude },
            { latitude: destination.latitude, longitude: destination.longitude }
        );
        const distanceKm = distanceMeters / 1000;
        const durationMinutes = Math.max(2, (distanceKm / MOTORCYCLE_SPEED_KMH) * 60);

        return {
            distanceMeters,
            distanceKm,
            durationSeconds: Math.round(durationMinutes * 60),
            durationMinutes,
            isSuccess: true,
            isFallback: true,
            source: 'fallback'
        };
    }

    /**
     * Cache key oluşturur (3 ondalığa yuvarla)
     */
    _buildCacheKey(fromLat, fromLon, toLat, toLon) {
        return `dm:${fromLat.toFixed(3)},${fromLon.toFixed(3)}->${toLat.toFixed(3)},${toLon.toFixed(3)}`;
    }

    /**
     * Koordinat geçerli mi?
     */
    _isValidCoordinate(lat, lon) {
        return lat && lon && lat !== 0 && lon !== 0 &&
            lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    }

    /**
     * Listeyi gruplara ayırır
     */
    _splitIntoBatches(arr, size) {
        const batches = [];
        for (let i = 0; i < arr.length; i += size) {
            batches.push(arr.slice(i, i + size));
        }
        return batches;
    }

    /**
     * Süresi dolmuş cache entry'lerini temizler
     */
    _cleanupCache() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, value] of this.cache) {
            if (now - value.timestamp > CACHE_TTL_MS) {
                this.cache.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[GoogleMaps] Cache cleanup: ${cleaned} entries removed, ${this.cache.size} remaining`);
        }
    }

    /**
     * Cleanup interval'ı durdurur (graceful shutdown)
     */
    destroy() {
        if (this._cleanupInterval) {
            clearInterval(this._cleanupInterval);
        }
    }
}

module.exports = GoogleMapsDistanceService;
