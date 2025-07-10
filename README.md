<p align="center">
<img src="https://placehold.co/1200x400/111827/7c3aed?text=DaemonClient&font=raleway" alt="DaemonClient Banner">
</p>

<p align="center">
<strong>Your Files. Your Cloud. Your Control.</strong>
</p>

<p align="center">
<a href="https://daemonclient-c0625.web.app"><strong>➡️ Launch Web App</strong></a>
</p>

<p align="center">
<img src="https://img.shields.io/badge/status-active-success.svg" alt="Status">
<img src="https://img.shields.io/badge/version-1.0.0-blue.svg" alt="Version">
<img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License">
</p>

DaemonClient is a secure, private, and virtually unlimited cloud storage solution that ingeniously leverages the Telegram API as a file storage backend. It provides a user-friendly interface to upload, download, and manage your files in a space that only you can access.

✨ Features
🔐 Zero-Knowledge Storage: Your files are uploaded directly to a private Telegram channel that only you control.

🚀 Blazing Fast Transfers: Utilizes concurrent chunking for both uploads and downloads to maximize speed.

♾️ Virtually Unlimited Storage: Leverage Telegram's generous file storage limits for free.

💻 Cross-Platform: Modern web interface works on any browser, on desktop or mobile.

🤖 Fully Automated Setup: A simple, one-time setup process automatically creates and configures your personal bot and private storage channel.

✏️ File Management: Rename, delete, and search your stored files with ease.

<h3>
<details>
<summary>Screenshots</summary>
<p align="center">
<img src='https://github.com/myrosama/DaemonClient/blob/main/screenshots/DashboardView.png' width='70%'>
<br><em>The main file dashboard.</em><br><br>
<img src='https://github.com/myrosama/DaemonClient/blob/main/screenshots/SignUp.png' width='70%'>
<br><em>The simple one-time setup process.</em>
</p>
</details>
</h3>

🚀 Get Started
The easiest way to use DaemonClient is through the official, hosted web application. No installation is required.

<p align="center">
<a href="https://daemonclient-c0625.web.app" style="display: inline-block; padding: 12px 24px; background-color: #4f46e5; color: white; text-decoration: none; font-weight: bold; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
Launch DaemonClient Web App
</a>
</p>

<br>

<details>
<summary><strong>For Developers: Self-Hosting Guide</strong></summary>
<br>
For advanced users who wish to run their own instance of the entire stack.

Clone the Repository:

git clone https://github.com/myrosama/DaemonClient.git

Frontend: Deploy the /public directory using Firebase Hosting.

Download Proxy: Deploy the TypeScript function in the /firebase-functions directory using the Firebase CLI.

Backend Server: The Python Flask server in /backend-server requires an "always-on" hosting provider (e.g., a paid plan on Render or PythonAnywhere) to function correctly. You must also provide your own Telegram userbot credentials in a .env file.

</details>

🛠️ Technology Stack
Frontend: React, Tailwind CSS

Backend (Setup Service): Python, Flask, Telethon

Backend (Download Proxy): TypeScript, Firebase Cloud Functions

Database & Auth: Google Firebase (Firestore, Authentication, Hosting)

Core Infrastructure: Telegram API

❤️ Support the Project
Enjoying DaemonClient? A small donation helps keep the public services running and supports future development.

Available donation methods here. (link to your donation page)

🙏 Credits & Acknowledgements
Inspiration
The concept of using Telegram as a private, unlimited cloud storage backend.

A project by @myrosama.
Based on https://github.com/myrosama/telegram-cloud-backup
