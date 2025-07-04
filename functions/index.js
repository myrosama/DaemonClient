// functions/index.js

const functions = require("firebase-functions");
const fetch = require("node-fetch"); // You'll need to install this
const cors = require("cors")({ origin: true }); // Use the cors library

/**
 * A proxy function to safely download files from the Telegram API,
 * avoiding client-side CORS issues.
 *
 * Expects query parameters:
 * - botToken: Your Telegram bot token.
 * - filePath: The file_path obtained from the getFile method.
 */
exports.telegramDownloadProxy = functions.https.onRequest((req, res) => {
  // Use the cors middleware to automatically handle CORS headers
  cors(req, res, async () => {
    // 1. Get parameters from the request query
    const { botToken, filePath } = req.query;

    if (!botToken || !filePath) {
      res.status(400).send("Missing 'botToken' or 'filePath' query parameters.");
      return;
    }

    // 2. Construct the actual Telegram file URL
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    try {
      // 3. Fetch the file from Telegram's server (server-to-server)
      const telegramResponse = await fetch(fileUrl);

      if (!telegramResponse.ok) {
        // Pass through Telegram's error status if something went wrong
        const errorText = await telegramResponse.text();
        res.status(telegramResponse.status).send(`Telegram API Error: ${errorText}`);
        return;
      }

      // 4. Stream the file back to the client that called this function
      // Set the proper headers so the browser knows it's a file download
      res.setHeader("Content-Type", telegramResponse.headers.get("content-type"));
      res.setHeader("Content-Length", telegramResponse.headers.get("content-length"));
      
      // Pipe the response body from Telegram directly to our response
      telegramResponse.body.pipe(res);

    } catch (error) {
      console.error("Proxy Error:", error);
      res.status(500).send("An error occurred in the proxy function.");
    }
  });
});