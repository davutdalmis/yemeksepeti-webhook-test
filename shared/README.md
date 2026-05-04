# shared/

Repo içindeki tüm Railway service'leri tarafından paylaşılan altyapı modülleri.

## Modüller

| Modül | Sorumluluk | Kullanan |
|---|---|---|
| `firestore-admin.js` | Firebase Admin SDK init (idempotent, 3-kademeli credential lookup) | `apps/platforms`, `apps/invoicing` |
| `redis-client.js` | ioredis wrapper + in-memory fallback (failover trackingli) | `apps/platforms`, `apps/invoicing` |
| `sentry-init.js` | DSN-parametreli Sentry init (DSN yoksa no-op) | `apps/platforms`, `apps/invoicing` |

## Kullanım

Her service `apps/<service>/` altında durur. shared'ı relative path ile import eder:

```js
// apps/platforms/server-v4.js
const { db, firebaseInitialized } = require('../../shared/firestore-admin');
const { getRedisClient, isRedisAvailable } = require('../../shared/redis-client');
const { initSentry } = require('../../shared/sentry-init');

initSentry({ dsn: process.env.SENTRY_DSN, service: 'platforms' });
```

```js
// apps/invoicing/server.js
const { db } = require('../../shared/firestore-admin');
const { getRedisClient } = require('../../shared/redis-client');
```

## Bagımlılıklar

shared/ kendi `package.json`'ı yoktur. Her tüketici app gerekli paketleri kendi `package.json`'ında tutar:

- `firestore-admin.js` → `firebase-admin`
- `redis-client.js` → `ioredis`
- `sentry-init.js` → `@sentry/node` (opsiyonel — yoksa no-op)

## Railway Build

Railway her service için tüm repo'yu clone'lar; rootDirectory sadece `npm install` ve `npm start`'ın nerede çalışacagını belirler. shared/ relative path ile her service'ten görünür.
