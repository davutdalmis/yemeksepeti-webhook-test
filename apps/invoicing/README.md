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
