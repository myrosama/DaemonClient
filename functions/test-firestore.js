const admin = require('firebase-admin');
const fs = require('fs');

// Initialize Firebase admin
const serviceAccount = JSON.parse(fs.readFileSync('/home/sadrikov49/Desktop/Daemonclient/DaemonClient/functions/service-account.json', 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function test() {
  const users = await db.collection('users').get();
  for (const user of users.docs) {
    const photos = await db.collection('users').doc(user.id).collection('photos').get();
    console.log(`User ${user.id} has ${photos.size} photos`);
    if (photos.size > 0) {
      const p = photos.docs[0].data();
      console.log('Sample photo:', JSON.stringify(p, null, 2));
    }
  }
}

test().catch(console.error);
