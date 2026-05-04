# YemiGO Platform Hub Server v4.0.0

## Mimari Genel Bakis

Platform Hub, modüler connector mimarisi ile tüm yemek delivery platformlarini tek bir merkezi sistemden yönetir.

```
                    +-------------------+
                    |  Railway Server   |
                    |  (Platform Hub)   |
                    +--------+----------+
                             |
        +--------------------+--------------------+
        |                    |                    |
   +---------+         +---------+         +---------+
   |YemekSepeti|       |GetirYemek|         |TrendyolGo|
   |Connector |        |Connector |         |Connector |
   +---------+         +---------+         +---------+
        |                    |                    |
        v                    v                    v
   [YS API]           [Getir API]          [TY API]
        |                    |                    |
        +--------------------+--------------------+
                             |
                    +--------v----------+
                    |     Firebase      |
                    |   (Firestore)     |
                    +-------------------+
                             ^
        +--------------------+--------------------+
        |                    |                    |
   +---------+         +---------+         +---------+
   |   WPF   |         |   Web   |         | Kurye   |
   |   POS   |         |   POS   |         |   App   |
   +---------+         +---------+         +---------+
```

## Dosya Yapisi

```
yemigo-webhook/
├── server-v4.js                    # Ana Platform Hub server (YENİ)
├── server.js                       # Legacy server (geriye uyumluluk)
├── services/
│   ├── platforms/
│   │   ├── platform-registry.js    # Platform tanımlarını yönetir
│   │   ├── base-connector.js       # Tüm connectorlar için base class
│   │   └── connectors/
│   │       ├── yemeksepeti-connector.js
│   │       ├── getiryemek-connector.js
│   │       └── trendyolgo-connector.js
│   └── api/
│       ├── orders-api.js           # Unified sipariş komutları API
│       └── platforms-api.js        # Platform yönetim API
└── package.json
```

## API Endpoints

### Unified Orders API (v2)

```
POST /api/v2/orders/:platformId/:orderId/accept    # Sipariş kabul
POST /api/v2/orders/:platformId/:orderId/reject    # Sipariş reddet
POST /api/v2/orders/:platformId/:orderId/ready     # Sipariş hazır
POST /api/v2/orders/:platformId/:orderId/pickup    # Kurye aldı
POST /api/v2/orders/:platformId/:orderId/deliver   # Teslim edildi
POST /api/v2/orders/:platformId/:orderId/assign-courier  # Kurye ata
GET  /api/v2/orders/:platformId/:orderId           # Sipariş detay
GET  /api/v2/orders/active                         # Tüm aktif siparişler
GET  /api/v2/orders/active/:platformId             # Platform aktif siparişleri
```

**Headers:**
- `x-api-key`: API anahtarı (zorunlu)
- `x-branch-id`: Şube ID (opsiyonel)

### Platforms Admin API

```
GET  /api/v2/platforms                              # Tüm platformlar
GET  /api/v2/platforms/:platformId                  # Platform detay
GET  /api/v2/platforms/branch/:branchId             # Şube platformları
POST /api/v2/platforms/definitions                  # Yeni platform (admin)
PUT  /api/v2/platforms/definitions/:platformId      # Platform güncelle
DELETE /api/v2/platforms/definitions/:platformId    # Platform sil
PUT  /api/v2/platforms/branch/:branchId/:platformId # Şube config
POST /api/v2/platforms/branch/:branchId/:platformId/toggle  # Aktif/Pasif
POST /api/v2/platforms/:platformId/test-connection  # Bağlantı test
```

**Headers:**
- `x-admin-key`: Admin API anahtarı (zorunlu)

### Legacy Endpoints (Geriye Uyumluluk)

YemekSepeti polling:
```
GET /api/yemeksepeti/pending-orders
DELETE /api/yemeksepeti/orders/:orderId
GET /api/yemeksepeti/cancellations
DELETE /api/yemeksepeti/cancellations/:cancellationId
```

GetirYemek polling:
```
GET /poll/webhooks
DELETE /api/getiryemek/webhooks/:webhookId
```

## Environment Variables

```env
# Firebase
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

# API Keys
YEMEKSEPETI_POLLING_API_KEY=your-yemeksepeti-key
GETIRYEMEK_POLLING_API_KEY=your-getiryemek-key
UNIFIED_API_KEY=your-unified-api-key      # v2 API için
ADMIN_API_KEY=your-admin-key              # Admin işlemleri için

# YemekSepeti API
YEMEKSEPETI_BASE_URL=https://integration-middleware.stg.restaurant-partners.com
YEMEKSEPETI_CHAIN_CODE=your-chain-code
YEMEKSEPETI_USERNAME=your-username
YEMEKSEPETI_PASSWORD=your-password

# GetirYemek
GETIRYEMEK_API_URL=https://food-external-api.getir.com
GETIRYEMEK_DEFAULT_RESTAURANT_SECRET=your-secret

# TrendyolGo
TRENDYOLGO_API_URL=https://api.trendyol.com/sapigw/suppliers
TRENDYOLGO_SUPPLIER_ID=your-supplier-id
TRENDYOLGO_API_KEY=your-api-key
TRENDYOLGO_API_SECRET=your-api-secret

# General
DEFAULT_BRANCH_ID=default-branch-id
PORT=3000
```

## WPF/Web Entegrasyonu

### Sipariş Kabul Etme (Yeni API)

```csharp
// WPF örneği
public async Task AcceptOrderAsync(string platformId, string orderId)
{
    var client = new HttpClient();
    client.DefaultRequestHeaders.Add("x-api-key", _apiKey);
    client.DefaultRequestHeaders.Add("x-branch-id", _branchId);

    var response = await client.PostAsync(
        $"{_railwayUrl}/api/v2/orders/{platformId}/{orderId}/accept",
        null
    );

    if (response.IsSuccessStatusCode)
    {
        // Başarılı
    }
}
```

### JavaScript/Web örneği

```typescript
// Web örneği
async function acceptOrder(platformId: string, orderId: string) {
    const response = await fetch(
        `${RAILWAY_URL}/api/v2/orders/${platformId}/${orderId}/accept`,
        {
            method: 'POST',
            headers: {
                'x-api-key': API_KEY,
                'x-branch-id': BRANCH_ID
            }
        }
    );

    return response.json();
}
```

## Yeni Platform Ekleme

### 1. Connector Oluştur

```javascript
// services/platforms/connectors/newplatform-connector.js
const BasePlatformConnector = require('../base-connector');

class NewPlatformConnector extends BasePlatformConnector {
    constructor(db, registry) {
        super('newplatform', db, registry);
    }

    transformOrder(rawOrder, branchId) {
        return {
            OrderId: rawOrder.id,
            Customer: { ... },
            Items: [ ... ],
            TotalAmount: rawOrder.total,
            // ...
        };
    }

    async acceptOrder(orderId, branchConfig) {
        // Platform API'sine kabul bildirimi
    }

    // Diğer metodlar...
}

module.exports = NewPlatformConnector;
```

### 2. Registry'ye Kaydet

```javascript
// server-v4.js içinde
const NewPlatformConnector = require('./services/platforms/connectors/newplatform-connector');

async function initializePlatformHub() {
    // ...
    const newplatformConnector = new NewPlatformConnector(db, platformRegistry);
    platformRegistry.registerConnector('newplatform', newplatformConnector);
}
```

### 3. Webhook Endpoint Ekle

```javascript
app.post('/webhook/newplatform/order', async (req, res) => {
    const order = req.body;
    const branchId = req.headers['x-branch-id'];

    const connector = platformRegistry.getConnector('newplatform');
    const transformedOrder = connector.transformOrder(order, branchId);

    await writeOrderToFirebaseUnified(transformedOrder, 'newplatform', branchId);

    res.status(200).json({ success: true });
});
```

### 4. Admin Panelde Tanımla

Admin panelden veya API ile:
```json
POST /api/v2/platforms/definitions
{
    "id": "newplatform",
    "name": "New Platform",
    "type": "webhook",
    "enabled": true,
    "webhookEndpoint": "/webhook/newplatform/order",
    "authType": "api_key",
    "features": ["orders", "cancellations"],
    "color": "#FF5722"
}
```

## Çalıştırma

```bash
# v4 (Platform Hub)
npm start
# veya
npm run dev

# Legacy (eski sistem)
npm run start:legacy
```

## Notlar

1. **Geriye Uyumluluk**: v4 server, eski WPF polling endpoint'lerini desteklemeye devam eder
2. **Firebase Realtime**: Siparişler hem queue'ya hem Firebase'e yazılır
3. **Smart Dispatch**: Kurye ataması otomatik yapılır
4. **Push Notifications**: Kuryeye FCM bildirimi gönderilir
5. **Platform Registry**: Dinamik platform tanımları Firebase'den yüklenir
