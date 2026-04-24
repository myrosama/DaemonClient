const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountsKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const users = await admin.auth().listUsers();
  users.users.forEach(u => console.log(u.uid, u.email));
}
run().catch(console.error).then(() => process.exit(0));
