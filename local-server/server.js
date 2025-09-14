// local-server/server.js
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const FormData = require('form-data');
const multer = require('multer'); // To handle file uploads

const app = express();
const port = 3000;
const upload = multer(); // Use multer to parse multipart/form-data

app.use(cors());

// Your existing download proxy route
app.get('/proxy', async (req, res) => {
    const { botToken, filePath } = req.query;
    if (!botToken || !filePath) {
        return res.status(400).send("Missing 'botToken' or 'filePath' query parameters.");
    }
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    try {
        const telegramResponse = await fetch(fileUrl);
        if (!telegramResponse.ok) {
            const errorText = await telegramResponse.text();
            return res.status(telegramResponse.status).send(`Telegram API Error: ${errorText}`);
        }
        telegramResponse.body.pipe(res);
    } catch (error) {
        res.status(500).send("An error occurred in the proxy function.");
    }
});

// +++ THE NEW UPLOAD PROXY ROUTE +++
app.post('/proxy/sendDocument', upload.single('document'), async (req, res) => {
    const { botToken } = req.query;
    if (!botToken) {
        return res.status(400).send("Missing 'botToken' query parameter.");
    }

    try {
        const form = new FormData();
        // Forward the chat_id from the original request
        form.append('chat_id', req.body.chat_id);
        // Re-attach the file buffer from multer
        form.append('document', req.file.buffer, { filename: req.file.originalname });

        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendDocument`;
        
        const telegramResponse = await fetch(telegramUrl, {
            method: 'POST',
            body: form
        });

        const result = await telegramResponse.json();
        res.status(telegramResponse.status).json(result);

    } catch (error) {
        console.error("Error in upload proxy:", error);
        res.status(500).json({ ok: false, description: "An error occurred in the proxy function." });
    }
});


app.listen(port, '127.0.0.1', () => {
    console.log(`Local proxy server listening at http://127.0.0.1:${port}`);
});