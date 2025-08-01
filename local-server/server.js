// server.js - Your local download proxy

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors'); // Very important!

const app = express();
const port = 4000; // You can change this port if you want

// This allows your web app (on your main PC) to make requests to this server.
app.use(cors());

// We are creating an endpoint named '/telegramDownloadProxy'
// It will listen for GET requests at http://[Your-Second-PC-IP]:4000/telegramDownloadProxy
app.get('/telegramDownloadProxy', async (req, res) => {
    // Get the botToken and filePath from the URL query (e.g., ?botToken=...&filePath=...)
    const { botToken, filePath } = req.query;

    console.log(`Received request for: ${filePath}`);

    // --- This is the core logic from your cloud function ---
    if (!botToken || !filePath) {
        console.error("Missing botToken or filePath");
        return res.status(400).send("Missing 'botToken' or 'filePath' query parameters.");
    }

    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;

    try {
        const telegramResponse = await fetch(fileUrl);

        if (!telegramResponse.ok) {
            const errorText = await telegramResponse.text();
            console.error(`Telegram API Error: ${errorText}`);
            return res.status(telegramResponse.status).send(`Telegram API Error: ${errorText}`);
        }

        // Set the headers to make the browser treat this as a file download
        res.setHeader('Content-Type', telegramResponse.headers.get('content-type'));
        res.setHeader('Content-Length', telegramResponse.headers.get('content-length'));

        // This is the cool part: it "pipes" the download stream from Telegram directly
        // to your browser, which is very efficient.
        telegramResponse.body.pipe(res);

    } catch (error) {
        console.error('Proxy Error:', error);
        res.status(500).send('An error occurred in the local proxy server.');
    }
    // --- End of core logic ---
});

// Start the server and listen for requests
app.listen(port, () => {
    console.log(`✅ Local proxy server is running!`);
    console.log(`   Listening on port: ${port}`);
    console.log(`   Now go to your React app and change the fetch URL.`);
});