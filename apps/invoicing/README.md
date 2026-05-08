# invoicing-engine

YemiGO Plan 27 — provider-agnostic e-Invoice / e-Despatch service.

**Status:** Faz 1.1 skeleton (sadece /health endpoint). Faz 1.2'den itibaren Parasut provider, token cache, queue ve worker eklenecek.

## Local

```bash
cd apps/invoicing
npm install
cp .env.example .env   # PORT yeterli; digerleri Faz 1.2+
npm start
curl http://localhost:3001/health
```

## Railway

- Service name: `invoicing-engine`
- Repo: `davutdalmis/yemigo-webhook`
- Root Directory: `apps/invoicing`
- Branch: `main`

## Mimari

Bkz. `PARASUT_INTEGRATION_PLAN.md` (workspace root). Bu service `shared/` altindaki firestore-admin + redis-client + sentry-init modullerini tuketir.

## Plan 28 — invoiceDocuments status genisleme (2026-05-06)

Yeni statuler: `pending_approval`, `approved`. Akis:

```
draft (sevkiyat anında, listener)
  -> pending_approval (yetkili panelde duzenlemeye basladi)
  -> approved (yetkili "Onayla" butonuna bastı; engine endpoint /invoicing/draft/:id/approve trigger)
  -> queued -> sending -> sent
```

### Geriye donuk uyumluluk

- StockTransferListener artik 'auto' modda dahi otomatik queue.add CAGIRMAZ. Onay endpoint'i tek tetikleyici.
- InvoiceWorker yalnizca `approved` veya retry'da `queued` status'taki dokumanlari isler. `draft` / `pending_approval` -> skip.
- Bafetto pilotunda Plan 28 oncesi yazilmis canli `invoiceDocuments` yoktur (listener kapaliydi). Ileride baska tenant gelirse:

### Migrasyon (opsiyonel — yalniz Plan 28 oncesi `draft` doc'lari varsa)

```js
// scripts/migrate-plan28-status.js (gerekirse yazilir)
// Eski 'draft' doc'lari: yeni semantikte 'draft' = sevkiyat anı, 'pending_approval' = yetkili dokunduktan sonra.
// Plan 28 oncesi 'draft' doc'lari halen yetkili dokunmadigindan zaten dogru anlamda — degistirmeye gerek yok.
// Sadece 'queued' doc'lari (Plan 27 auto mode) engine restart sonrasi tekrar islenmeyecek;
// auto mode kalktigi icin geri 'approved' yapilip islenmesi gerekir VEYA elle Parasut'a gonderildigi
// dogrulanip 'sent' / 'cancelled' olarak isaretlenmelidir. Bafetto uretiminde 0 doc oldugundan no-op.
```

Bafetto'da bu durum yok — script yazilmasina gerek olmayinca opsiyonel.
