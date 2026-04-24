const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountsKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

async function run() {
  const source = await admin.firestore().doc('artifacts/default-daemon-client/users/kV51N8pl39c02w8W8iKc2KLVG3y2/config/telegram').get();
  
  // Set it for sadrikov49@gmail.com
  await admin.firestore().doc('artifacts/default-daemon-client/users/RxiHwTOHVySBYTwmdpJY9b3BzK22/config/telegram').set(source.data());
  console.log('Fixed sadrikov49@gmail.com');
  
  // Set it for test2404@gmail.com
  await admin.firestore().doc('artifacts/default-daemon-client/users/a61Kyz3lJ9S2KSmi74PxXgfAae52/config/telegram').set(source.data());
  console.log('Fixed test2404@gmail.com');

  // Set it for newuserpublictest@gmail.com
  await admin.firestore().doc('artifacts/default-daemon-client/users/HDQcbuumjIbaDWvDhNuB3BDPEmv2/config/telegram').set(source.data());
  console.log('Fixed newuserpublictest@gmail.com');

}
run().catch(console.error).then(() => process.exit(0));
