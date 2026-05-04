const CredentialVault = require('../secrets/CredentialVault');

const KEY = 'a'.repeat(64); // 32 bytes hex
const KEY2 = 'b'.repeat(64);

describe('CredentialVault', () => {
    test('encrypt/decrypt round-trip', () => {
        const v = new CredentialVault({ masterKeyHex: KEY });
        const ct = v.encrypt('super-secret', 'tenant-A');
        expect(ct).toMatch(/^v1:/);
        expect(v.decrypt(ct, 'tenant-A')).toBe('super-secret');
    });

    test('different tenants -> different ciphertexts for same plaintext', () => {
        const v = new CredentialVault({ masterKeyHex: KEY });
        const a = v.encrypt('hello', 'tenant-A');
        const b = v.encrypt('hello', 'tenant-B');
        expect(a).not.toBe(b);
        expect(v.decrypt(a, 'tenant-A')).toBe('hello');
        expect(v.decrypt(b, 'tenant-B')).toBe('hello');
    });

    test('cross-tenant decrypt fails (per-tenant key isolation)', () => {
        const v = new CredentialVault({ masterKeyHex: KEY });
        const ct = v.encrypt('cred', 'tenant-A');
        expect(() => v.decrypt(ct, 'tenant-B')).toThrow(/integrity check failed/);
    });

    test('tampered ciphertext fails authTag check', () => {
        const v = new CredentialVault({ masterKeyHex: KEY });
        const ct = v.encrypt('cred', 'tenant-A');
        const parts = ct.split(':');
        // flip last byte of ciphertext
        const ctBuf = Buffer.from(parts[3], 'base64');
        ctBuf[ctBuf.length - 1] ^= 0x01;
        parts[3] = ctBuf.toString('base64');
        const tampered = parts.join(':');
        expect(() => v.decrypt(tampered, 'tenant-A')).toThrow(/integrity check failed/);
    });

    test('different master key -> decrypt fails', () => {
        const v1 = new CredentialVault({ masterKeyHex: KEY });
        const v2 = new CredentialVault({ masterKeyHex: KEY2 });
        const ct = v1.encrypt('x', 'tenant-A');
        expect(() => v2.decrypt(ct, 'tenant-A')).toThrow(/integrity check failed/);
    });

    test('rejects malformed master key', () => {
        expect(() => new CredentialVault({ masterKeyHex: 'tooshort' })).toThrow(/64 hex/);
        expect(() => new CredentialVault({ masterKeyHex: 'g'.repeat(64) })).toThrow(/64 hex/);
    });

    test('rejects malformed envelope', () => {
        const v = new CredentialVault({ masterKeyHex: KEY });
        expect(() => v.decrypt('not-an-envelope', 'tenant-A')).toThrow(/malformed envelope/);
        expect(() => v.decrypt('v9:a:b:c', 'tenant-A')).toThrow(/unknown version/);
    });

    test('encryptFields/decryptFields helpers', () => {
        const v = new CredentialVault({ masterKeyHex: KEY });
        const enc = v.encryptFields(
            { clientId: 'CID', clientSecret: 'CSE', username: 'U', password: 'P', companyId: '12345' },
            ['clientId', 'clientSecret', 'username', 'password'],
            'tenant-X'
        );
        expect(enc.companyId).toBe('12345');
        expect(enc.clientId).toBeUndefined();
        expect(enc.encryptedClientId).toMatch(/^v1:/);
        expect(enc.encryptedPassword).toMatch(/^v1:/);

        const dec = v.decryptFields(enc, ['clientId', 'clientSecret', 'username', 'password'], 'tenant-X');
        expect(dec.clientId).toBe('CID');
        expect(dec.password).toBe('P');
        expect(dec.encryptedClientId).toBeUndefined();
    });

    test('rotation: v1 ciphertext still decryptable after adding v2 key', () => {
        const v1 = new CredentialVault({ masterKeyHex: KEY });
        const ct = v1.encrypt('legacy', 'tenant-A');
        // Simulate rotation environment: v2 is current, v1 is old
        const rotated = new CredentialVault({ versionedKeys: { v1: KEY } });
        expect(rotated.decrypt(ct, 'tenant-A')).toBe('legacy');
    });
});
