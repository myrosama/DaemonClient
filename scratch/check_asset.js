import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT!);

initializeApp({
  credential: cert(serviceAccount),
  projectId: 'daemonclient-c0625'
});

const db = getFirestore();

async function checkAsset(assetId: string) {
  const doc = await db.collection('users').doc('sadrikov49').collection('photos').doc(assetId).get();
  if (!doc.exists) {
    console.log('Asset not found');
    return;
  }
  console.log(JSON.stringify(doc.data(), null, 2));
}

checkAsset('6142d7bc-1c6b-417d-9aab-16a27a8b5d97');
