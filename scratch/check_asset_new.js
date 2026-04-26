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
    console.log('Asset not found in users/sadrikov49/photos/' + assetId);
    return;
  }
  console.log(JSON.stringify(doc.data(), null, 2));
}

checkAsset('c900fef3-cbd8-4d08-a02d-d6b6a7f624a0');
