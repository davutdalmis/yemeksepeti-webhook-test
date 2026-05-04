try { require('dotenv').config(); } catch (e) { }

const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
    res.json({
        ok: true,
        service: 'invoicing-engine',
        version: require('./package.json').version,
        node: process.version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`[invoicing-engine] Listening on port ${PORT}`);
});
