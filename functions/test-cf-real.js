const fetch = require('node-fetch');
const admin = require('firebase-admin');
const FormData = require('form-data');
const serviceAccount = require('./serviceAccountsKey.json');

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const uid = 'kV51N8pl39c02w8W8iKc2KLVG3y2';
  const customToken = await admin.auth().createCustomToken(uid);
  const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8';
  
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true })
  });
  
  const data = await res.json();
  const idToken = data.idToken;

  const sessionData = {
    uid: uid,
    email: 'test@example.com',
    idToken: idToken, 
    refreshToken: 'fake',
    exp: Date.now() + 1000000
  };
  const sessionToken = Buffer.from(JSON.stringify(sessionData)).toString('base64');

  const fd = new FormData();
  fd.append('assetData', Buffer.from('fake image data'), { filename: 'test.jpg', contentType: 'image/jpeg' });
  fd.append('deviceAssetId', 'test-123');
  fd.append('deviceId', 'WEB');
  fd.append('fileCreatedAt', new Date().toISOString());
  fd.append('fileModifiedAt', new Date().toISOString());
  fd.append('isFavorite', 'false');

  console.log('Sending direct to Cloudflare Worker...');
  const res1 = await fetch('https://immich-api.sadrikov49.workers.dev/api/assets', {
    method: 'POST',
    headers: {
      'Cookie': `__session=${sessionToken}`,
      ...fd.getHeaders()
    },
    body: fd
  });
  console.log('CF Worker Response:', res1.status, await res1.text());
}
run().catch(console.error).then(() => process.exit(0));
