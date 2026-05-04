// ==================================================================================
// CredentialVault — AES-256-GCM ile per-tenant secret encrypt/decrypt
// ==================================================================================
// Plan 27 1.4.
// Format: "v1:<base64(iv)>:<base64(authTag)>:<base64(ciphertext)>"
// Master key: process.env.INVOICING_AES_MASTER_KEY (32 byte = 64 hex char).
// Per-tenant key: HMAC-SHA256(masterKey, tenantId) -> 32 byte derived key.
// Tampering detection: authTag mismatch -> decrypt throws.
// Key rotation: yeni surum yazilirken "v2:" prefix; decrypt eski "v1:"i de cozer.
// ==================================================================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const CURRENT_VERSION = 'v1';
const SUPPORTED_VERSIONS = ['v1'];

class CredentialVault {
    /**
     * @param {object} [opts]
     * @param {string} [opts.masterKeyHex]  64-char hex; default: process.env.INVOICING_AES_MASTER_KEY
     * @param {Object<string,string>} [opts.versionedKeys]  Rotation: { v1: hex, v2: hex }
     */
    constructor(opts = {}) {
        const versioned = opts.versionedKeys || {};
        const fromEnv = process.env.INVOICING_AES_MASTER_KEY;
        const primary = opts.masterKeyHex || versioned[CURRENT_VERSION] || fromEnv;
        if (!primary) {
            throw new Error('CredentialVault: master key required (INVOICING_AES_MASTER_KEY env or masterKeyHex option)');
        }
        if (!/^[0-9a-fA-F]{64}$/.test(primary)) {
            throw new Error('CredentialVault: master key must be 64 hex characters (32 bytes)');
        }

        this.versionedKeys = { ...versioned, [CURRENT_VERSION]: primary };
        for (const [v, h] of Object.entries(this.versionedKeys)) {
            if (!SUPPORTED_VERSIONS.includes(v)) {
                throw new Error(`CredentialVault: unsupported key version "${v}"`);
            }
            if (!/^[0-9a-fA-F]{64}$/.test(h)) {
                throw new Error(`CredentialVault: key for "${v}" must be 64 hex chars`);
            }
        }
    }

    encrypt(plaintext, tenantId) {
        if (typeof plaintext !== 'string') throw new Error('CredentialVault.encrypt: plaintext must be string');
        if (!tenantId) throw new Error('CredentialVault.encrypt: tenantId required');

        const masterKey = Buffer.from(this.versionedKeys[CURRENT_VERSION], 'hex');
        const derivedKey = this._derive(masterKey, tenantId);
        const iv = crypto.randomBytes(IV_LEN);
        const cipher = crypto.createCipheriv(ALGO, derivedKey, iv);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();

        return `${CURRENT_VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
    }

    decrypt(envelope, tenantId) {
        if (typeof envelope !== 'string') throw new Error('CredentialVault.decrypt: envelope must be string');
        if (!tenantId) throw new Error('CredentialVault.decrypt: tenantId required');

        const parts = envelope.split(':');
        if (parts.length !== 4) throw new Error('CredentialVault.decrypt: malformed envelope');
        const [version, ivB64, tagB64, ctB64] = parts;

        const keyHex = this.versionedKeys[version];
        if (!keyHex) throw new Error(`CredentialVault.decrypt: unknown version "${version}"`);

        const masterKey = Buffer.from(keyHex, 'hex');
        const derivedKey = this._derive(masterKey, tenantId);
        const iv = Buffer.from(ivB64, 'base64');
        const tag = Buffer.from(tagB64, 'base64');
        const ct = Buffer.from(ctB64, 'base64');

        if (iv.length !== IV_LEN) throw new Error('CredentialVault.decrypt: bad IV length');

        const decipher = crypto.createDecipheriv(ALGO, derivedKey, iv);
        decipher.setAuthTag(tag);
        try {
            const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
            return pt.toString('utf8');
        } catch (e) {
            // GCM authTag mismatch → tampering or wrong key
            const err = new Error('CredentialVault.decrypt: integrity check failed');
            err.code = 'DECRYPT_INTEGRITY';
            err.cause = e;
            throw err;
        }
    }

    /**
     * Helper for credential bundles. Encrypts each string field, leaves others alone.
     * @param {object} record  flat object with string secrets
     * @param {string[]} fields  which keys to encrypt
     * @param {string} tenantId
     */
    encryptFields(record, fields, tenantId) {
        const out = { ...record };
        for (const f of fields) {
            if (record[f] != null && record[f] !== '') {
                out[`encrypted${capitalize(f)}`] = this.encrypt(String(record[f]), tenantId);
                delete out[f];
            }
        }
        return out;
    }

    decryptFields(record, fields, tenantId) {
        const out = { ...record };
        for (const f of fields) {
            const enc = record[`encrypted${capitalize(f)}`];
            if (enc) {
                out[f] = this.decrypt(enc, tenantId);
                delete out[`encrypted${capitalize(f)}`];
            }
        }
        return out;
    }

    _derive(masterKey, tenantId) {
        return crypto.createHmac('sha256', masterKey).update(String(tenantId)).digest().subarray(0, KEY_LEN);
    }
}

function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = CredentialVault;
