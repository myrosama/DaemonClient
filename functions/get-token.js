const admin = require('firebase-admin');
const fetch = require('node-fetch');
const serviceAccount = require('./serviceAccountsKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const uid = 'kV51N8pl39c02w8W8iKc2KLVG3y2';
  const customToken = await admin.auth().createCustomToken(uid);
  
  const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8'; // Grabbed from wrangler output earlier
  
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  
  const data = await res.json();
  console.log(data.idToken);
}
run().catch(console.error).then(() => process.exit(0));
