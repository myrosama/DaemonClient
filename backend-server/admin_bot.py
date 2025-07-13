import os
import json
import logging
from functools import wraps

import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv

from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

# --- Basic Setup ---
logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s", level=logging.INFO
)
load_dotenv()

# --- Initialize Firebase Admin SDK ---
print("▶️ Initializing connection to Firebase...")
try:
    firebase_creds_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
    cred = credentials.Certificate(json.loads(firebase_creds_json))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase initialized successfully.")
except Exception as e:
    print(f"❌ FATAL: Could not initialize Firebase. Error: {e}")
    exit()

# --- Get Admin Bot Credentials ---
try:
    ADMIN_BOT_TOKEN = os.getenv("ADMIN_BOT_TOKEN")
    ADMIN_CHAT_ID = int(os.getenv("YOUR_TELEGRAM_CHAT_ID"))
    if not ADMIN_BOT_TOKEN or not ADMIN_CHAT_ID:
        raise ValueError("ADMIN_BOT_TOKEN or YOUR_TELEGRAM_CHAT_ID not found in environment.")
except (ValueError, TypeError) as e:
    print(f"❌ FATAL: Check your admin bot environment variables. Error: {e}")
    exit()

# --- Authorization Decorator ---
def restricted(func):
    @wraps(func)
    async def wrapped(update: Update, context: ContextTypes.DEFAULT_TYPE, *args, **kwargs):
        user_id = update.effective_user.id
        # If the user's ID does not match the admin's ID, send a rejection message and stop.
        if user_id != ADMIN_CHAT_ID:
            print(f"🚫 Unauthorized access denied for {user_id}.")
            await update.message.reply_text("Sorry, you are not authorized to use this bot.")
            return
        # If the user is authorized, run the original command function (e.g., start or stats).
        return await func(update, context, *args, **kwargs)
    return wrapped

# --- Bot Command Handlers ---

@restricted  # Apply the authorization check to this command
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Sends a welcome message when the /start command is issued by the admin."""
    user_name = update.effective_user.first_name
    await update.message.reply_text(
        f"👋 Hello, Admin {user_name}!\n\n"
        "I'm the DaemonClient Analytics Bot. I'm ready to serve you.\n\n"
        "You can use the /stats command to get the latest usage data."
    )

@restricted  # Apply the authorization check here too
async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Fetches and sends application statistics from Firestore."""
    await update.message.reply_text("⏳ Fetching latest stats from the database, please wait...")

    try:
        # 1. Get total users by counting documents in the 'users' collection
        users_ref = db.collection(f'artifacts/default-daemon-client/users').stream()
        user_count = len(list(users_ref))

        # 2. Get total storage size using a collection group query.
        # This powerful query gets all documents from all 'files' sub-collections across all users.
        all_files_ref = db.collection_group('files').stream()

        total_size_bytes = 0
        file_count = 0
        for file_doc in all_files_ref:
            total_size_bytes += file_doc.to_dict().get('fileSize', 0)
            file_count += 1
        
        # Convert bytes to a more readable format (Gigabytes)
        total_size_gb = total_size_bytes / (1024**3)

        # 3. Format the final message
        message = (
            f"📊 **DaemonClient Analytics** 📊\n\n"
            f"👥 **Total Users:** {user_count}\n"
            f"🗂️ **Total Files Stored:** {file_count}\n"
            f"💾 **Total Storage Used:** {total_size_gb:.3f} GB"
        )
        await update.message.reply_text(message, parse_mode='Markdown')

    except Exception as e:
        print(f"Error fetching stats: {e}")
        await update.message.reply_text(f"Sorry, an error occurred while fetching stats: {e}")

# --- Main Bot Execution Logic ---
def main():
    """Start the bot."""
    print("▶️ Starting Admin Bot...")
    application = Application.builder().token(ADMIN_BOT_TOKEN).build()

    # Register the command handlers
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("stats", stats))

    # Start the bot and wait for commands
    application.run_polling()
    print("⏹️ Admin Bot has stopped.")

if __name__ == "__main__":
    main()