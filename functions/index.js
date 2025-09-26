// functions/index.js (FINAL - With Robust Error Checking)

// Explicit v2 Imports
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore"); // Added onDocumentUpdated
const functions = require("firebase-functions"); // For v1 auth trigger

// Common Imports
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const fetch = require("node-fetch");

// Loads variables from 'functions/.env' for local emulation.
// On Firebase, these are set as environment variables.
require("dotenv").config();

admin.initializeApp();

// =========================================================================
// --- CONFIGURATION - Read from environment variables ---
// =========================================================================
const ADMIN_BOT_TOKEN = process.env.TELEGRAM_ADMIN_BOT_TOKEN;
const YOUR_CHAT_ID = process.env.TELEGRAM_YOUR_CHAT_ID;

// =========================================================================
// --- The Public Download Proxy ---
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
// --- Admin Alert Functions (NOW WITH ROBUST ERROR CHECKING) ---
// =========================================================================
const sendTelegramMessage = async (message) => {
    if (!ADMIN_BOT_TOKEN || !YOUR_CHAT_ID) {
      logger.error("CRITICAL: Telegram admin bot credentials are not defined in environment variables.");
      // We throw an error so the calling function knows it failed.
      throw new Error("Admin bot credentials not configured.");
    }
    const url = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}/sendMessage`;
    
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: YOUR_CHAT_ID, text: message, parse_mode: "Markdown" }),
        });

        // This is the critical new logic: check if Telegram accepted the message.
        if (!response.ok) {
            const errorBody = await response.json();
            logger.error("Telegram API returned an error:", {
                statusCode: response.status,
                statusText: response.statusText,
                errorBody: errorBody,
            });
            throw new Error(`Telegram API Error: ${errorBody.description || "Unknown error"}`);
        }

        logger.info("Successfully sent message request to Telegram API.");

    } catch (error) {
        logger.error("Failed inside sendTelegramMessage function:", error);
        // Re-throw the error so the main function's catch block is aware of the failure.
        throw error;
    }
};

// 1. New User Signup Alert (Auth Trigger, v1)
exports.onUserSignedUp = functions.auth.user().onCreate(async (user) => {
  const email = user.email;
  const message = `👋 *New User Signup*!\n\nAn account was just created for:\n\`${email}\``;
  try {
    await sendTelegramMessage(message);
    logger.info(`Successfully processed new user alert for ${email}`);
  } catch (error) {
    logger.error(`Failed to process new user alert for ${email}. The error originated in sendTelegramMessage.`);
  }
});

// 2. Setup Complete Alert (Firestore Create Trigger, v2)
exports.onSetupComplete = onDocumentCreated("artifacts/default-daemon-client/users/{userId}/config/telegram", async (event) => {
  logger.info(`onSetupComplete triggered for userId: ${event.params.userId}. Function has started.`);
  const userId = event.params.userId;
  const userDocRef = admin.firestore().collection("artifacts/default-daemon-client/users").doc(userId);
  let userEmail = "unknown";
  try {
    const userDocSnap = await userDocRef.get();
    if (userDocSnap.exists) {
        userEmail = userDocSnap.data().email || "email not set";
    }
  } catch (e) {
    logger.error("Could not fetch user email for alert", e);
  }
  const message = `✅ *Setup Complete!*\n\nUser \`${userEmail}\` (ID: \`${userId}\`) has just successfully completed the automated setup.`;
  try {
    await sendTelegramMessage(message);
    logger.info(`Successfully processed setup complete alert for ${userId}`);
  } catch (error) {
    logger.error(`Failed to process setup complete alert for ${userId}. The error originated in sendTelegramMessage.`);
  }
});

// 3. Ownership Transfer Alert (Firestore Update Trigger, v2)
exports.onTransferComplete = onDocumentUpdated("artifacts/default-daemon-client/users/{userId}/config/telegram", async (event) => {
  logger.info(`onTransferComplete triggered for userId: ${event.params.userId}. Function has started.`);
    const beforeData = event.data.before.data();
    const afterData = event.data.after.data(); // Corrected from .xdata() to .data()

    // The key condition: Trigger only when 'ownership_transferred' changes to 'true'.
    if (beforeData.ownership_transferred !== true && afterData.ownership_transferred === true) {
        const userId = event.params.userId;
        const userDocRef = admin.firestore().collection("artifacts/default-daemon-client/users").doc(userId);
        let userEmail = "unknown";
        try {
            const userDocSnap = await userDocRef.get();
            if (userDocSnap.exists) {
                userEmail = userDocSnap.data().email || "email not set";
            }
        } catch (e) {
            logger.error("Could not fetch user email for alert", e);
        }

        const message = `🚀 *Ownership Transferred!*\n\nUser \`${userEmail}\` (ID: \`${userId}\`) is now fully onboarded and in control of their resources.`;
        try {
            await sendTelegramMessage(message);
            logger.info(`Successfully processed ownership transfer alert for ${userId}`);
        } catch (error) {
            logger.error(`Failed to process ownership transfer alert for ${userId}. The error originated in sendTelegramMessage.`);
        }
    }
});