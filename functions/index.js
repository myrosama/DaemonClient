// functions/index.js (FINAL MASTER VERSION - v1 Auth Trigger)

// Explicit v2 Imports
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");

// V1 Imports (for the Auth trigger)
const functions = require("firebase-functions");

// Common Imports
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const fetch = require("node-fetch");

require("dotenv").config();
admin.initializeApp();

// =========================================================================
// --- IMMICH API PROXY (same-origin proxy to Cloudflare Worker) ---
// =========================================================================
const WORKER_URL = "https://immich-api.sadrikov49.workers.dev";

exports.immichApiProxy = onRequest({ cors: false }, async (req, res) => {
    const targetUrl = WORKER_URL + req.path;
    const url = new URL(targetUrl);
    // Forward query params
    for (const [key, value] of Object.entries(req.query)) {
        url.searchParams.set(key, value);
    }

    const headers = {};
    // Forward relevant headers
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers['authorization']) headers['Authorization'] = req.headers['authorization'];
    if (req.headers['cookie']) headers['Cookie'] = req.headers['cookie'];
    // Forward Origin so the Worker can validate CORS
    if (req.headers['origin']) headers['Origin'] = req.headers['origin'];

    try {
        logger.info(`Proxying ${req.method} ${url.toString()}, content-type: ${headers['Content-Type']}, rawBody length: ${req.rawBody ? req.rawBody.length : 'undefined'}`);
        const workerRes = await fetch(url.toString(), {
            method: req.method,
            headers,
            // Pipe the raw request stream directly to preserve multipart/form-data
            // and avoid memory limits with large files
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        });

        const contentType = workerRes.headers.get('content-type') || '';

        // Forward Set-Cookie from Worker — strip Domain= so the browser
        // stores cookies on the hosting domain (photos.daemonclient.uz)
        // instead of the Worker domain (workers.dev)
        const setCookie = workerRes.headers.raw()['set-cookie'];
        if (setCookie) {
            for (const cookie of setCookie) {
                const cleaned = cookie.replace(/;\s*Domain=[^;]*/gi, '');
                res.append('Set-Cookie', cleaned);
            }
        }

        res.status(workerRes.status);
        res.set('Content-Type', contentType);

        if (contentType.includes('image') || contentType.includes('video') || contentType.includes('octet-stream')) {
            const buffer = await workerRes.buffer();
            res.send(buffer);
        } else {
            const text = await workerRes.text();
            res.send(text);
        }
    } catch (error) {
        logger.error("immichApiProxy error:", error);
        res.status(502).json({ message: "Proxy error", error: error.message });
    }
});



// =========================================================================
// --- CONFIGURATION ---
// =========================================================================
const ADMIN_BOT_TOKEN = process.env.TELEGRAM_ADMIN_BOT_TOKEN;
const YOUR_CHAT_ID = process.env.TELEGRAM_YOUR_CHAT_ID;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

// =========================================================================
// --- 1. PUBLIC HTTP ENDPOINTS (V2) ---
// =========================================================================

/*
 *
 * DELETED: The 'telegramDownloadProxy' function was here. 
 * It has been removed as it costs money (bandwidth egress) and is not 
 * used by the main web app, which uses the sw.js Service Worker instead.
 *
 */

exports.telegramWebhook = onRequest(async (req, res) => {
    // ... (This code is perfect, no changes needed)
    if (req.path !== `/${WEBHOOK_SECRET}`) {
        logger.warn(`Webhook: Unauthorized access attempt on path: ${req.path}`);
        res.status(403).send("Forbidden");
        return;
    }
    if (req.body.message?.text === "/stats") {
        const chatId = req.body.message.chat.id;
        const initialMessage = await sendTelegramMessage("⏳ Calculating statistics, please wait...", chatId);
        const messageId = initialMessage.result.message_id;
        try {
            const [totalUsers, totalSetups, totalTransfers, totalStorageBytes] = await Promise.all([
                admin.auth().listUsers().then(result => result.users.length),
                admin.firestore().collectionGroup("config").where("botToken", "!=", null).count().get().then(snap => snap.data().count),
                admin.firestore().collectionGroup("config").where("ownership_transferred", "==", true).count().get().then(snap => snap.data().count),
                admin.firestore().collectionGroup("files").get().then(snap => snap.docs.reduce((sum, doc) => sum + (doc.data().fileSize || 0), 0))
            ]);
            const statsMessage = `📊 *DaemonClient Platform Statistics*\n\n*Total Registered Users:* \`${totalUsers}\`\n*Setups Initialized:* \`${totalSetups}\`\n*Ownership Transfers Complete:* \`${totalTransfers}\`\n\n*Total Storage Used:* \`${formatBytes(totalStorageBytes)}\``;
            await editTelegramMessage(statsMessage, chatId, messageId);
            res.status(200).send("Stats sent.");
        } catch (error) {
            logger.error("Webhook: Error calculating stats:", error);
            await editTelegramMessage("❌ An error occurred while calculating statistics.", chatId, messageId);
            res.status(500).send("Error processing stats.");
        }
    } else {
        res.status(200).send("Command not recognized.");
    }
});

// =========================================================================
// --- 2. EVENT-DRIVEN NOTIFICATION FUNCTIONS ---
// =========================================================================

/**
 * THE FIX: Reverted to the ultra-reliable V1 Auth Trigger.
 */
exports.onUserSignedUp = functions.auth.user().onCreate(async (user) => {
  const email = user.email;
  const message = `👋 *New User Signup*!\n\nAn account was just created for:\n\`${email}\``;
  try {
    await sendTelegramMessage(message, YOUR_CHAT_ID);
    logger.info(`Successfully processed new user alert for ${email}`);
  } catch (error) {
    logger.error(`Failed to process new user alert for ${email}.`);
  }
});

/**
 * V2 Firestore trigger for setup complete. (This is perfect)
 */
exports.onsetupcomplete = onDocumentCreated("artifacts/default-daemon-client/users/{userId}/config/telegram", async (event) => {
    const userId = event.params.userId;
    const userDocRef = admin.firestore().collection("artifacts/default-daemon-client/users").doc(userId);
    let userEmail = await getUserEmail(userDocRef);
    const message = `✅ *Setup Complete!*\n\nUser \`${userEmail}\` (ID: \`${userId}\`) has just successfully completed the automated setup.`;
    try {
        await sendTelegramMessage(message, YOUR_CHAT_ID);
        logger.info(`Successfully processed setup complete alert for ${userId}`);
    } catch (error) {
        logger.error(`Failed to process setup complete alert for ${userId}.`);
    }
});

/**
 * V2 Firestore trigger for transfer complete. (This is perfect)
 */
exports.ontransfercomplete = onDocumentUpdated("artifacts/default-daemon-client/users/{userId}/config/telegram", async (event) => {
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data();
    if (beforeData.ownership_transferred !== true && afterData.ownership_transferred === true) {
        const userId = event.params.userId;
        const userDocRef = admin.firestore().collection("artifacts/default-daemon-client/users").doc(userId);
        let userEmail = await getUserEmail(userDocRef);
        const message = `🚀 *Ownership Transferred!*\n\nUser \`${userEmail}\` (ID: \`${userId}\`) is now fully onboarded and in control of their resources.`;
        try {
            await sendTelegramMessage(message, YOUR_CHAT_ID);
            logger.info(`Successfully processed ownership transfer alert for ${userId}`);
        } catch (error) {
            logger.error(`Failed to process ownership transfer alert for ${userId}.`);
        }
    }
});

// =========================================================================
// --- 3. HELPER FUNCTIONS ---
// =========================================================================
// ... (All helper functions: sendTelegramMessage, editTelegramMessage, getUserEmail, formatBytes are perfect, no changes needed) ...
const sendTelegramMessage = async (message, chatId) => {
    if (!ADMIN_BOT_TOKEN || !chatId) {
        logger.error("CRITICAL: Telegram admin bot credentials are not configured.");
        throw new Error("Admin bot credentials not configured.");
    }
    const url = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
    if (!response.ok) {
        const errorBody = await response.json();
        throw new Error(`Telegram API Error: ${errorBody.description}`);
    }
    return await response.json();
};
const editTelegramMessage = async (newMessage, chatId, messageId) => {
    if (!ADMIN_BOT_TOKEN || !chatId || !messageId) {
        throw new Error("Admin bot credentials or message details missing.");
    }
    const url = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/editMessageText`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: newMessage, parse_mode: "Markdown" }),
    });
    if (!response.ok) {
        const errorBody = await response.json();
        throw new Error(`Telegram API Error: ${errorBody.description}`);
    }
    return await response.json();
};
const getUserEmail = async (userDocRef) => {
    try {
        const userDocSnap = await userDocRef.get();
        return userDocSnap.exists ? (userDocSnap.data().email || "email not set") : "unknown user";
    } catch (e) {
        logger.error("Could not fetch user email for alert", e);
        return "unknown (db error)";
    }
};
const formatBytes = (bytes, decimals = 2) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};