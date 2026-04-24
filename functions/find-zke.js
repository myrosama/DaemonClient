const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountsKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const db = admin.firestore();
  const zkeQuery = await db.collectionGroup('config').get();
  for (const doc of zkeQuery.docs) {
    if (doc.id === 'zke') {
      console.log('Found zke at:', doc.ref.path, doc.data());
    }
  }
}
run().catch(console.error).then(() => process.exit(0));
