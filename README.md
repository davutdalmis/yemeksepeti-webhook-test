# YemekSepeti Webhook Test Server

Simple webhook receiver to test YemekSepeti order integration.

## Deployment

1. Push to GitHub
2. Deploy to Railway
3. Copy Railway URL
4. Send URL to Birtan Bey (YemekSepeti Integration Contact)

## Webhook URL Format

```
https://your-railway-url.up.railway.app/order/BAFETTO-TEST-001
```

## Test

After deployment, YemekSepeti will send test orders to this endpoint.
Check Railway logs to see incoming order payloads.
