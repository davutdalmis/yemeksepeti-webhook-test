// ==================================================================================
// Shared Firestore Admin — idempotent Firebase Admin SDK init
// ==================================================================================
// 3-kademeli credential lookup (server-v4.js parite):
//   1) FIREBASE_SERVICE_ACCOUNT_JSON env (tek satir JSON; Railway prod)
//   2) GOOGLE_APPLICATION_CREDENTIALS env (uretim/standart)
//   3) <process.cwd()>/firebase-credentials.json (lokal dev)
// ==================================================================================

const admin = require('firebase-admin');
const path = require('path');

let db = null;
let firebaseInitialized = false;

function initializeFirebase() {
    if (admin.apps && admin.apps.length > 0) {
        if (!db) db = admin.firestore();
        firebaseInitialized = true;
        return true;
    }

    try {
        const firebaseCredentials = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

        if (firebaseCredentials) {
            const serviceAccount = JSON.parse(firebaseCredentials);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            console.log('[Firebase] Initialized from environment variable');
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            admin.initializeApp({
                credential: admin.credential.applicationDefault(),
            });
            console.log('[Firebase] Initialized from GOOGLE_APPLICATION_CREDENTIALS');
        } else {
            try {
                const localPath = path.resolve(process.cwd(), 'firebase-credentials.json');
                const serviceAccount = require(localPath);
                admin.initializeApp({
                    credential: admin.credential.cert(serviceAccount),
                });
                console.log(`[Firebase] Initialized from local ${localPath}`);
            } catch (e) {
                console.warn('[Firebase] No credentials found — Firebase features disabled');
                return false;
            }
        }

        db = admin.firestore();
        firebaseInitialized = true;
        console.log('[Firebase] Firestore connected successfully');
        return true;
    } catch (error) {
        console.error('[Firebase] Initialization error:', error.message);
        return false;
    }
}

initializeFirebase();

module.exports = {
    admin,
    get db() { return db; },
    get firebaseInitialized() { return firebaseInitialized; },
    initializeFirebase,
};
