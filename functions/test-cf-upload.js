const fetch = require('node-fetch');
const FormData = require('form-data');

async function run() {
  const sessionData = {
    uid: 'kV51N8pl39c02w8W8iKc2KLVG3y2',
    email: 'test@example.com',
    idToken: 'fake', // Cloudflare worker doesn't strictly validate this in handleUpload unless it hits Firestore
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
