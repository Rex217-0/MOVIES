import admin from 'firebase-admin';

const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || '';
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || '';

let firestoreDb: admin.firestore.Firestore | null = null;

export function firebaseStatus() {
  const configured = Boolean(projectId && clientEmail && privateKey);
  return {
    configured,
    projectId,
    storageBucket,
    hasServiceAccount: configured,
  };
}

export function getFirestore(): admin.firestore.Firestore | null {
  if (firestoreDb) return firestoreDb;

  if (!projectId || !clientEmail || !privateKey) {
    return null;
  }

  try {
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
          }),
          storageBucket: storageBucket || undefined,
        });

    firestoreDb = admin.firestore(app);
    return firestoreDb;
  } catch (error) {
    console.error('[FIREBASE] Failed to initialize Firestore:', error);
    return null;
  }
}

export async function saveMovieRecord(record: Record<string, unknown>) {
  const db = getFirestore();
  if (!db) {
    throw new Error('Firebase Firestore is not configured. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.');
  }

  const id = String(record.id ?? crypto.randomUUID());
  const payload = {
    ...record,
    id,
    createdAt: new Date().toISOString(),
  };

  await db.collection('movie_history').doc(id).set(payload);
  return { id };
}

export async function listMovieRecords(limit = 20) {
  const db = getFirestore();
  if (!db) {
    return [];
  }

  const snap = await db.collection('movie_history').orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}
