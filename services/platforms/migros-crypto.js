// ==================================================================================
// MIGROS YEMEK - Rijndael AES Encryption (Node.js)
// Migros API tüm POST body'lerin AES-256-ECB ile şifrelenmesini zorunlu kılar.
// Parametreler: ECB mode, PKCS7 padding, BlockSize=128, KeySize=256
// ==================================================================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-ecb';

/**
 * Secret Key'i 32 byte'a normalize eder (SHA-256 hash).
 * Eğer key zaten 32 byte ise doğrudan kullanır.
 */
function deriveKey(secretKey) {
    const keyBytes = Buffer.from(secretKey, 'utf8');
    if (keyBytes.length === 32) return keyBytes;
    return crypto.createHash('sha256').update(keyBytes).digest();
}

/**
 * Plaintext'i AES-256-ECB ile şifreler.
 * @param {string} plainText - Şifrelenecek metin (JSON body)
 * @param {string} secretKey - Migros Secret Key
 * @returns {string} Base64 encoded ciphertext
 */
function encrypt(plainText, secretKey) {
    const key = deriveKey(secretKey);
    const cipher = crypto.createCipheriv(ALGORITHM, key, null);
    cipher.setAutoPadding(true); // PKCS7
    let encrypted = cipher.update(plainText, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
}

/**
 * Base64 ciphertext'i AES-256-ECB ile çözer.
 * @param {string} cipherText - Base64 encoded şifreli metin
 * @param {string} secretKey - Migros Secret Key
 * @returns {string} Çözülmüş plaintext
 */
function decrypt(cipherText, secretKey) {
    const key = deriveKey(secretKey);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, null);
    decipher.setAutoPadding(true);
    let decrypted = decipher.update(cipherText, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * JSON body'yi şifreleyip Migros API formatına sarar.
 * @param {string} jsonBody - JSON string
 * @param {string} secretKey - Secret Key
 * @returns {object} { value: "encrypted_base64" }
 */
function wrapForPost(jsonBody, secretKey) {
    return { value: encrypt(jsonBody, secretKey) };
}

module.exports = { encrypt, decrypt, wrapForPost };
