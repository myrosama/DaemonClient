const fetch = require('node-fetch');
const FormData = require('form-data');

async function run() {
  const idToken = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IjNiMDk1NzQ3YmY4MzMxZWE0YWQ1M2YzNzBjNjMyNjAxNzliMGQyM2EiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vZGFlbW9uY2xpZW50LWMwNjI1IiwiYXVkIjoiZGFlbW9uY2xpZW50LWMwNjI1IiwiYXV0aF90aW1lIjoxNzc3MDU0NDU0LCJ1c2VyX2lkIjoia1Y1MU44cGwzOWMwMnc4VzhpS2MyS0xWRzN5MiIsInN1YiI6ImtWNTFOOHBsMzljMDJ3OFc4aUtjMktMVkczeTIiLCJpYXQiOjE3NzcwNTQ0NTQsImV4cCI6MTc3NzA1ODA1NCwiZmlyZWJhc2UiOnsiaWRlbnRpdGllcyI6e30sInNpZ25faW5fcHJvdmlkZXIiOiJjdXN0b20ifX0.x3EQnJG8rSaP2DQZ8MVx1UDmYfKFG8HyWL-ucz5FjLxwYlwzG6TsRO6FqbMuOpF5I8BWpozSGo8jyYGIz5Ww3fRyNWo6LWI1PRMBnO2tQruFWLqxN641hAjHWr6L_UXpN2IZCbuniGKpG-WVknHJyVKslTmSvERHXFCy9wHjMi8vz9nPj_XFOQF2rd_2ejzjI9o4KxAaVqvKT0lZG0S_XaNrTT3cSyJgqD1NyE_F5m39U7bQafWVP83xg6XFpqw_PQkFAcpAhuVf0QvTv_Ny4nj6g7Tsvum6qI9vkcJeANKMbuZbvp9XxwFit37fMMnpF-WksvNJfyuI3aDgq1ce2g';

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
      'Authorization': `Bearer ${idToken}`,
      ...fd.getHeaders()
    },
    body: fd
  });
  console.log('CF Worker Response:', res1.status, await res1.text());

  const fd2 = new FormData();
  fd2.append('assetData', Buffer.from('fake image data'), { filename: 'test.jpg', contentType: 'image/jpeg' });
  fd2.append('deviceAssetId', 'test-123');
  fd2.append('deviceId', 'WEB');
  fd2.append('fileCreatedAt', new Date().toISOString());
  fd2.append('fileModifiedAt', new Date().toISOString());
  fd2.append('isFavorite', 'false');

  console.log('Sending to Firebase Cloud Function Proxy...');
  const res2 = await fetch('https://immichapiproxy-7q2qt7uweq-uc.a.run.app', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${idToken}`,
      ...fd2.getHeaders()
    },
    body: fd2
  });
  console.log('Firebase Proxy Response:', res2.status, await res2.text());
}
run().catch(console.error).then(() => process.exit(0));
