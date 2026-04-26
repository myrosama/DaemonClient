const admin = require('firebase-admin');
const fetch = require('node-fetch');
const serviceAccount = require('./serviceAccountsKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

const args = process.argv.slice(2);

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const exact = `--${name}`;
  const found = args.find((arg) => arg.startsWith(prefix) || arg === exact);
  if (!found) {
    return fallback;
  }
  if (found === exact) {
    return 'true';
  }
  return found.slice(prefix.length);
}

const DRY_RUN = getArg('dry-run', 'false') === 'true';
const USER_ID = getArg('user-id', null);
const LIMIT = Number.parseInt(getArg('limit', '0'), 10) || 0;
const MIN_DELAY_MS = Number.parseInt(getArg('min-delay-ms', '250'), 10) || 250;
const APP_ID = getArg('app-id', 'default-daemon-client');
const MAX_ATTEMPTS = Number.parseInt(getArg('max-attempts', '5'), 10) || 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function isImageEligible(photo) {
  const mimeType = photo.mimeType || '';
  const isImage = mimeType.startsWith('image/');
  const isHeic = photo.isHeic === true || mimeType === 'image/heic' || mimeType === 'image/heif';
  const isEncrypted = photo.encryptionMode === 'server' || photo.encryptionMode === 'client' || photo.encrypted === true;
  return isImage && !isHeic && !isEncrypted;
}

async function getTelegramConfig(userRef) {
  const configSnap = await userRef.collection('config').doc('telegram').get();
  if (!configSnap.exists) {
    return null;
  }
  const data = configSnap.data() || {};
  const botToken = data.botToken || data.bot_token;
  const channelId = data.channelId || data.channel_id;
  if (!botToken || !channelId) {
    return null;
  }
  return { botToken, channelId };
}

async function callTelegram(botToken, method, payload, isFormData = false) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const options = {
    method: 'POST',
    body: payload,
  };
  if (!isFormData) {
    options.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(url, options);
  const data = await res.json();
  if (!data.ok) {
    const retryAfter = data.parameters && data.parameters.retry_after ? Number(data.parameters.retry_after) : null;
    const err = new Error(data.description || `Telegram API failed: ${method}`);
    err.code = data.error_code || 500;
    err.retryAfter = retryAfter;
    throw err;
  }
  return data.result;
}

async function fetchTelegramFile(botToken, fileId) {
  const result = await callTelegram(botToken, 'getFile', JSON.stringify({ file_id: fileId }));
  const filePath = result.file_path;
  if (!filePath) {
    throw new Error('Telegram file path missing');
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`Failed downloading original file: ${fileRes.status}`);
  }
  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function generateThumbId(botToken, channelId, originalFileId, fileName) {
  const imageBuffer = await fetchTelegramFile(botToken, originalFileId);
  const formData = new (require('form-data'))();
  formData.append('chat_id', channelId);
  formData.append('photo', imageBuffer, { filename: fileName || 'thumb.jpg', contentType: 'image/jpeg' });

  const sendPhotoUrl = `https://api.telegram.org/bot${botToken}/sendPhoto`;
  const res = await fetch(sendPhotoUrl, {
    method: 'POST',
    headers: formData.getHeaders(),
    body: formData,
  });
  const data = await res.json();
  if (!data.ok) {
    const retryAfter = data.parameters && data.parameters.retry_after ? Number(data.parameters.retry_after) : null;
    const err = new Error(data.description || 'Failed to send photo for thumbnail generation');
    err.code = data.error_code || 500;
    err.retryAfter = retryAfter;
    throw err;
  }
  const sizes = data.result && data.result.photo ? data.result.photo : [];
  if (!sizes.length || !sizes[0].file_id) {
    throw new Error('sendPhoto succeeded but no thumbnail file_id returned');
  }
  return sizes[0].file_id;
}

async function markStatus(photoRef, update) {
  if (DRY_RUN) {
    return;
  }
  await photoRef.set(update, { merge: true });
}

function buildStatus(status, attempts, error = null) {
  return {
    thumbnailBackfill: {
      status,
      attempts,
      lastAttemptAt: nowIso(),
      error,
    },
  };
}

async function processPhoto(userId, telegramConfig, photoDoc) {
  const photo = photoDoc.data() || {};
  const photoRef = photoDoc.ref;
  const photoId = photoDoc.id;
  const attempts = Number(photo.thumbnailBackfill && photo.thumbnailBackfill.attempts ? photo.thumbnailBackfill.attempts : 0);

  if (photo.telegramThumbId) {
    return { skipped: true, reason: 'already-has-thumb' };
  }
  if (!photo.telegramOriginalId) {
    await markStatus(photoRef, buildStatus('skipped', attempts, 'missing telegramOriginalId'));
    return { skipped: true, reason: 'missing-original-id' };
  }
  if (!isImageEligible(photo)) {
    await markStatus(photoRef, buildStatus('skipped', attempts, 'ineligible image/encryption format'));
    return { skipped: true, reason: 'ineligible' };
  }
  if (attempts >= MAX_ATTEMPTS) {
    return { skipped: true, reason: 'max-attempts-reached' };
  }

  await markStatus(photoRef, buildStatus('processing', attempts + 1, null));

  try {
    const thumbId = await generateThumbId(
      telegramConfig.botToken,
      telegramConfig.channelId,
      photo.telegramOriginalId,
      photo.fileName || 'thumb.jpg',
    );

    await markStatus(photoRef, {
      telegramThumbId: thumbId,
      ...buildStatus('done', attempts + 1, null),
    });
    return { updated: true, thumbId };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    await markStatus(photoRef, buildStatus('failed', attempts + 1, message));
    if (error && error.retryAfter) {
      await sleep((error.retryAfter + 1) * 1000);
    }
    return { failed: true, error: message };
  }
}

async function runForUser(userDoc) {
  const userId = userDoc.id;
  const userRef = userDoc.ref;
  const tgConfig = await getTelegramConfig(userRef);
  if (!tgConfig) {
    console.log(`[${userId}] skipped: no valid telegram config`);
    return { processed: 0, updated: 0, failed: 0, skipped: 0 };
  }

  const photosSnap = await userRef.collection('photos').get();
  let processed = 0;
  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const photoDoc of photosSnap.docs) {
    if (LIMIT > 0 && processed >= LIMIT) {
      break;
    }

    const result = await processPhoto(userId, tgConfig, photoDoc);
    processed += 1;

    if (result.updated) {
      updated += 1;
      console.log(`[${userId}] ${photoDoc.id}: updated thumb (${result.thumbId})`);
    } else if (result.failed) {
      failed += 1;
      console.log(`[${userId}] ${photoDoc.id}: failed (${result.error})`);
    } else {
      skipped += 1;
    }

    await sleep(MIN_DELAY_MS);
  }

  console.log(`[${userId}] done: processed=${processed}, updated=${updated}, failed=${failed}, skipped=${skipped}`);
  return { processed, updated, failed, skipped };
}

async function run() {
  console.log('Starting thumbnail backfill with config:', {
    DRY_RUN,
    USER_ID,
    LIMIT,
    MIN_DELAY_MS,
    APP_ID,
    MAX_ATTEMPTS,
  });

  const usersRoot = db.collection(`artifacts/${APP_ID}/users`);
  let userDocs = [];
  if (USER_ID) {
    const userSnap = await usersRoot.doc(USER_ID).get();
    if (!userSnap.exists) {
      throw new Error(`User not found: ${USER_ID}`);
    }
    userDocs = [userSnap];
  } else {
    const usersSnap = await usersRoot.get();
    userDocs = usersSnap.docs;
  }

  const totals = { users: 0, processed: 0, updated: 0, failed: 0, skipped: 0 };
  for (const userDoc of userDocs) {
    const stats = await runForUser(userDoc);
    totals.users += 1;
    totals.processed += stats.processed;
    totals.updated += stats.updated;
    totals.failed += stats.failed;
    totals.skipped += stats.skipped;
  }

  console.log('Backfill complete:', totals);
}

run()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await admin.app().delete();
  });
