const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountsKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const users = await admin.firestore().collection('artifacts/default-daemon-client/users').get();
  for (const doc of users.docs) {
    const tg = await doc.ref.collection('config').doc('telegram').get();
    if (tg.exists) {
        console.log('User:', doc.id, tg.data());
    }
  }
}
run().catch(console.error).then(() => process.exit(0));
