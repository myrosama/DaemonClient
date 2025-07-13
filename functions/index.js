// functions/index.js (FINAL - .env Version)

// Explicit Imports
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const functions = require("firebase-functions");

// Common Imports
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const fetch = require("node-fetch");

// This line automatically loads the variables from your 'functions/.env' file
// into process.env for you when you deploy.
require("dotenv").config();

admin.initializeApp();

// =========================================================================
// --- CONFIGURATION - Read from process.env ---
// =========================================================================
const ADMIN_BOT_TOKEN = process.env.TELEGRAM_ADMIN_BOT_TOKEN;
const YOUR_CHAT_ID = process.env.TELEGRAM_YOUR_CHAT_ID;

// =========================================================================
// --- YOUR CRUCIAL FUNCTION ---
// =========================================================================
exports.telegramDownloadProxy = onRequest({ cors: true }, async (req, res) => {
  const { botToken, filePath } = req.query;
  if (!botToken || !filePath) {
    logger.error("Missing botToken or filePath");
    res.status(400).send("Missing 'botToken' or 'filePath' query parameters.");
    return;
  }
  const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  try {
    const telegramResponse = await fetch(fileUrl);
    if (!telegramResponse.ok) {
      const errorText = await telegramResponse.text();
      logger.error(`Telegram API Error: ${errorText}`);
      res.status(telegramResponse.status).send(`Telegram API Error: ${errorText}`);
      return;
    }
    res.setHeader("Content-Type", telegramResponse.headers.get("content-type"));
    res.setHeader("Content-Length", telegramResponse.headers.get("content-length"));
    telegramResponse.body.pipe(res);
  } catch (error) {
    logger.error("Proxy Error:", error);
    res.status(500).send("An error occurred in the proxy function.");
  }
});

// =========================================================================
// --- HELPER & ALERT FUNCTIONS ---
// =========================================================================
const sendTelegramMessage = (message) => {
    if (!ADMIN_BOT_TOKEN || !YOUR_CHAT_ID) {
      logger.error("Telegram admin bot credentials are not defined in the environment.");
      return Promise.resolve();
    }
    const url = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`;
    return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: YOUR_CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
};

// Auth trigger (Gen 1)
exports.onUserSignedUp = functions.auth.user().onCreate(async (user) => {
  const email = user.email;
  const message = `👋 *New User Signup*!\n\nAn account was just created for:\n\`${email}\``;
  try {
    await sendTelegramMessage(message);
    logger.info(`Successfully sent new user alert for ${email}`);
  } catch (error) {
    logger.error("Failed to send new user alert:", error);
  }
});

// Firestore trigger (Gen 2)
exports.onSetupComplete = onDocumentCreated("artifacts/default-daemon-client/users/{userId}/config/telegram", async (event) => {
  const userId = event.params.userId;
  const userDocRef = admin.firestore().collection("artifacts/default-daemon-client/users").doc(userId);
  let userEmail = "unknown";
  try {
    const userDoc = await userDocRef.get();
    if (userDoc.exists) {
        userEmail = userDoc.data().email || "email not set";
    }
  } catch (e) {
    logger.error("Could not fetch user email for alert", e);
  }
  const message = `✅ *Setup Complete!*\n\nUser \`${userEmail}\` (ID: \`${userId}\`) has just successfully completed the automated setup.`;
  try {
    await sendTelegramMessage(message);
    logger.info(`Successfully sent setup complete alert for ${userId}`);
  } catch (error) {
    logger.error("Failed to send setup complete alert:", error);
  }
});