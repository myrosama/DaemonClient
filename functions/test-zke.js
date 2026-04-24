const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountsKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const users = await admin.firestore().collection('artifacts/default-daemon-client/users').get();
  for (const doc of users.docs) {
    const zke = await doc.ref.collection('config').doc('zke').get();
    if (zke.exists) {
        console.log('User:', doc.id, zke.data());
    }
  }
}
run().catch(console.error).then(() => process.exit(0));
