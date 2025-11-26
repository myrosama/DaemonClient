import os
import asyncio
import traceback
import re
import json
import time
import hashlib
from functools import wraps

from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore, auth as firebase_auth
from dotenv import load_dotenv
from google.cloud.firestore_v1.base_query import FieldFilter

# Telethon imports
from telethon import TelegramClient, events
from telethon.sessions import StringSession
from telethon.tl.functions.channels import (
    CreateChannelRequest,
    EditAdminRequest,
    EditCreatorRequest,
    GetParticipantsRequest,
)
from telethon.tl.functions.messages import ExportChatInviteRequest
from telethon.tl.functions.account import GetPasswordRequest
from telethon.tl.types import (
    ChannelParticipantsSearch,
    ChatAdminRights,
    InputCheckPasswordSRP,
    MessageEntityBold
)
from telethon.errors.rpcerrorlist import (
    UserDeactivatedBanError,
    FloodWaitError,
    UserNotParticipantError,
    PasswordHashInvalidError,
)
from telethon.errors import SessionPasswordNeededError
from telethon.password import compute_check

import telethon
print(f"✅ Telethon version currently in use: {telethon.__version__}")

# --- Load Environment Variables ---
load_dotenv()

# --- Initialize Flask App ---
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# --- Initialize Firebase Admin SDK ---
try:
    firebase_creds_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
    if not firebase_creds_json:
        raise ValueError("FIREBASE_CREDENTIALS_JSON environment variable not set.")
    cred = credentials.Certificate(json.loads(firebase_creds_json))
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase initialized successfully.")
except Exception as e:
    print(f"FATAL: Could not initialize Firebase. Error: {e}")

# 2FA password
TELETHON_2FA_PASSWORD = os.getenv("TELETHON_2FA_PASSWORD")
ASSET_CHANNEL_ID = int(os.getenv("ASSET_CHANNEL_ID", 0))
BOT_PIC_MESSAGE_ID = int(os.getenv("BOT_PIC_MESSAGE_ID", 0))

# --- Bot Pool Management ---
def get_available_bots():
    print("Fetching available userbots from Firestore...")
    try:
        bots_ref = (
            db.collection("userbots")
            .where(filter=FieldFilter("is_active", "==", True))
            .order_by("last_used", direction=firestore.Query.ASCENDING)
            .stream()
        )
        bots_list = [{"doc_id": bot.id, **bot.to_dict()} for bot in bots_ref]
        print(f"Found {len(bots_list)} active bots.")
        return bots_list
    except Exception as e:
        print(f"Error fetching bots from Firestore: {e}")
        return []

# --- Helper Functions ---
async def wait_for_message_with_buttons(client: TelegramClient, chat: str, timeout: int = 15):
    start = time.time()
    while time.time() - start < timeout:
        msgs = await client.get_messages(chat, limit=4)
        if not msgs:
            await asyncio.sleep(0.4)
            continue
        for m in msgs:
            if getattr(m, "buttons", None):
                return m
        await asyncio.sleep(0.4)
    return None

async def click_button_containing_text_in_msg(msg, text, retries=5, delay=2, password=None):
    for attempt in range(retries):
        if msg and getattr(msg, "buttons", None):
            for row in msg.buttons:
                for button in row:
                    if text.lower() in button.text.lower():
                        print(f"✅ Found button: {button.text} (attempt {attempt+1})")
                        return await button.click(password=password)
        print(f"🔄 Retry {attempt+1}/{retries}: waiting for buttons to appear...")
        await asyncio.sleep(delay)
        try:
            msg = await msg.client.get_messages(msg.chat_id, ids=msg.id)
        except Exception:
             pass 
    if msg and getattr(msg, "buttons", None):
        print("⚠️ Available buttons:", [b.text for row in msg.buttons for b in row])
    return None

async def _create_resources_with_userbot(client, user_id, user_email):
    print(f"[{user_id}] Starting resource creation...")
    bot_name = f"{user_email.split('@')[0]}'s DaemonClient"
    bot_username, bot_token = "", ""
    
    async with client.conversation("BotFather", timeout=120) as conv:
        await conv.send_message("/newbot")
        await conv.get_response()
        await conv.send_message(bot_name)
        await conv.get_response()

        for i in range(5):
            bot_username = f"dc_{user_id[:7]}_{os.urandom(4).hex()}_bot"
            await conv.send_message(bot_username)
            response = await conv.get_response()
            if "Done! Congratulations" in response.text:
                token_match = re.search(r"(\d+:[A-Za-z0-9\-_]+)", response.text)
                if not token_match: raise Exception("Could not find bot token")
                bot_token = token_match.group(1)
                break
            if "username is already taken" in response.text and i < 4: continue
            if i == 4: 
                raise Exception(f"Failed to create bot username. Last response: {response.text}")
        
        if not bot_token: raise Exception("Failed to create a bot")
        
        # Set Description
        description_text = (
            "👇 Click START below, then return to the website to finalize the setup.\n\n"
            "_(Note: This bot will not reply after you press Start.)_"
        )
        await conv.send_message(f"/setdescription")
        await conv.get_response()
        await conv.send_message(f"@{bot_username}")
        await conv.get_response()
        await conv.send_message(description_text)
        await conv.get_response()

        # Set Profile Pic
        if ASSET_CHANNEL_ID and BOT_PIC_MESSAGE_ID:
            try:
                await conv.send_message("/setuserpic")
                await conv.get_response()
                await conv.send_message(f"@{bot_username}")
                await conv.get_response()
                photo_message = await client.get_messages(ASSET_CHANNEL_ID, ids=BOT_PIC_MESSAGE_ID)
                await conv.send_file(photo_message.photo)
                await conv.get_response(timeout=30)
            except Exception as e:
                print(f"⚠️ Could not set bot profile picture: {e}")
    
    # Create Channel
    channel_title = f"DaemonClient Storage - {user_id[:6]}"
    result = await client(CreateChannelRequest(title=channel_title, about="Private storage.", megagroup=True))
    new_channel = result.chats[0]
    channel_id = f"-100{new_channel.id}"

    # Add Bot as Admin
    await client(
        EditAdminRequest(
            channel=new_channel.id,
            user_id=bot_username,
            admin_rights=ChatAdminRights(post_messages=True, edit_messages=True, delete_messages=True),
            rank="bot",
        )
    )

    # Generate Invite Link
    invite_link_result = await client(ExportChatInviteRequest(int(channel_id)))
    invite_link = invite_link_result.link

    await client.send_message(bot_username, "/start")

    # Clean up service messages
    try:
        messages_to_delete = []
        async for message in client.iter_messages(int(channel_id), limit=10):
            if message.action:
                messages_to_delete.append(message.id)
        if messages_to_delete:
            await client.delete_messages(int(channel_id), messages_to_delete)
    except Exception as e:
        print(f"⚠️ Could not clean up service messages: {e}")

    # Send Sentinel Message
    welcome_text = """🚨 **Welcome to Your DaemonClient Secure Storage** 🚨

This private channel is the heart of your personal cloud. All files you upload through the web interface are stored here as encrypted message chunks.

**❗️ CRITICAL: DO NOT INTERFERE WITH THIS CHANNEL ❗️**

To ensure your data integrity, please follow these rules:

-   **DO NOT** delete any messages.
-   **DO NOT** send your own messages, files, or media.
-   **DO NOT** change channel settings or permissions.
-   **DO NOT** remove the bot (`@{bot_username}`).

Interfering with this channel **will permanently corrupt your file index and lead to data loss.**

🔒 **All file management should be done exclusively through the official DaemonClient web application.**

Thank you for understanding. Happy storing!
"""
    try:
        sent_message = await client.send_message(
            entity=int(channel_id),
            message=welcome_text.format(bot_username=bot_username),
            parse_mode='md'
        )
        await client.pin_message(int(channel_id), sent_message)
    except Exception as e:
        print(f"⚠️ Could not send welcome message: {e}")

    return bot_token, bot_username, channel_id, invite_link

async def _transfer_ownership(worker_client, bot_username, channel_id, target_user_id, target_user_username):
    results = {
        "bot_transfer_status": "pending", "bot_transfer_message": "",
        "channel_transfer_status": "pending", "channel_transfer_message": "",
    }
    password_2fa = os.getenv("TELETHON_2FA_PASSWORD")
    
    # Bot Transfer
    try:
        async with worker_client.conversation("BotFather", timeout=120) as conv:
            await conv.send_message("/mybots")
            resp_bot_list = await wait_for_message_with_buttons(worker_client, "BotFather")
            await click_button_containing_text_in_msg(resp_bot_list, bot_username)
            resp_bot_menu = await wait_for_message_with_buttons(worker_client, "BotFather")
            await click_button_containing_text_in_msg(resp_bot_menu, "Transfer Ownership")
            resp_recipient_menu = await wait_for_message_with_buttons(worker_client, "BotFather")
            await click_button_containing_text_in_msg(resp_recipient_menu, "Choose recipient")
            await conv.get_response()
            await conv.send_message(f"@{target_user_username}")
            resp_final_confirm = await conv.wait_event(events.NewMessage(from_users="BotFather", incoming=True), timeout=20)
            
            clicked = await click_button_containing_text_in_msg(resp_final_confirm, "Yes, I am sure", password=password_2fa)
            if not clicked:
                clicked = await click_button_containing_text_in_msg(resp_final_confirm, "proceed", password=password_2fa)
            if not clicked: raise Exception("Could not find final confirmation button.")
            await conv.get_response(timeout=15)

        results["bot_transfer_status"] = "success"
        results["bot_transfer_message"] = "Bot ownership successfully transferred."

    except Exception as e:
        print(f"❌ Bot transfer FAILED: {e}")
        results["bot_transfer_status"] = "failed"
        results["bot_transfer_message"] = f"Bot transfer failed: {e}"

    # Channel Transfer
    if results["bot_transfer_status"] == "success":
        try:
            account_password = await worker_client(GetPasswordRequest())
            srp_check = compute_check(account_password, password_2fa)
            await worker_client(EditCreatorRequest(channel=int(channel_id), user_id=target_user_id, password=srp_check))
            results["channel_transfer_status"] = "success"
            results["channel_transfer_message"] = "Channel ownership successfully transferred."
        except Exception as e:
            print(f"❌ Channel transfer FAILED: {e}")
            results["channel_transfer_status"] = "failed"
            results["channel_transfer_message"] = f"Channel transfer failed: {e}"

    return results

# ============================================================================
# --- NEW CLI API ---
# ============================================================================

# --- AUTH MIDDLEWARE ---
def check_auth(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Missing or invalid Authorization header'}), 401
        
        id_token = auth_header.split('Bearer ')[1]
        try:
            decoded_token = firebase_auth.verify_id_token(id_token)
            request.user_uid = decoded_token['uid']
            request.user_email = decoded_token['email']
        except Exception as e:
            return jsonify({'error': f'Invalid token: {str(e)}'}), 401
            
        return f(*args, **kwargs)
    return decorated_function

@app.route('/api/list', methods=['GET'])
@check_auth
def list_files():
    """Returns a JSON list of all files for the authenticated user."""
    try:
        files_ref = db.collection(f"artifacts/default-daemon-client/users/{request.user_uid}/files")
        docs = files_ref.stream()
        
        files = []
        for doc in docs:
            d = doc.to_dict()
            # Convert timestamps to ISO strings for JSON serialization
            if 'uploadedAt' in d and d['uploadedAt']:
                d['uploadedAt'] = d['uploadedAt'].isoformat()
            d['id'] = doc.id
            files.append(d)
            
        return jsonify({'files': files})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/delete', methods=['POST'])
@check_auth
def delete_file():
    data = request.get_json()
    file_id = data.get('file_id')
    if not file_id: return jsonify({'error': 'Missing file_id'}), 400

    try:
        file_ref = db.collection(f"artifacts/default-daemon-client/users/{request.user_uid}/files").document(file_id)
        file_ref.delete()
        return jsonify({'status': 'success', 'message': f'File {file_id} deleted from registry.'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/config', methods=['GET'])
@check_auth
def get_upload_config():
    """Returns the Bot Token and Channel ID so the CLI can upload directly."""
    try:
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{request.user_uid}/config").document("telegram")
        config = config_ref.get()
        if not config.exists:
            return jsonify({'error': 'Configuration not found. Please complete setup on web.'}), 404
        data = config.to_dict()
        return jsonify({
            'bot_token': data.get('botToken'),
            'channel_id': data.get('channelId')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ============================================================================
# --- EXISTING ENDPOINTS ---
# ============================================================================

@app.route("/")
def index():
    return "DaemonClient API is running."

@app.route("/startSetup", methods=["POST"])
def start_setup_endpoint():
    data = request.get_json().get("data", {})
    user_id, user_email = data.get("uid"), data.get("email")
    if not user_id or not user_email:
        return jsonify({"error": "Missing uid or email in request body."}), 400
    
    available_bots = get_available_bots()
    if not available_bots:
        return jsonify({"error": {"message": "No available worker bots to process the request."}}), 500

    async def run_setup_flow():
        for bot_creds in available_bots:
            bot_doc_id = bot_creds["doc_id"]
            client = TelegramClient(StringSession(bot_creds["session_string"]), bot_creds["api_id"], bot_creds["api_hash"])
            try:
                await client.start(password=lambda: TELETHON_2FA_PASSWORD)
                bot_token, bot_username, channel_id, invite_link = await _create_resources_with_userbot(client, user_id, user_email)

                user_config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
                user_config_ref.set({
                    "botToken": bot_token,
                    "botUsername": bot_username,
                    "channelId": channel_id,
                    "invite_link": invite_link,
                    "ownership_transferred": False,
                    "createdBy": bot_doc_id
                })
                db.collection("userbots").document(bot_doc_id).update({'last_used': firestore.SERVER_TIMESTAMP, 'status': 'healthy'})
                return jsonify({"status": "success"})

            except UserDeactivatedBanError as e:
                db.collection("userbots").document(bot_doc_id).update({'is_active': False, 'status': 'banned'})
                continue
            except Exception as e:
                db.collection("userbots").document(bot_doc_id).update({'status': f'error: {str(e)[:200]}', 'error_count': firestore.Increment(1)})
                continue
            finally:
                if client.is_connected(): await client.disconnect()

        return jsonify({"error": {"message": "All available worker bots failed."}}), 500

    return asyncio.run(run_setup_flow())

@app.route("/finalizeTransfer", methods=["POST"])
def finalize_transfer_endpoint():
    data = request.get_json().get("data", {})
    user_id = data.get("uid")
    if not user_id: return jsonify({"error": {"message": "Missing uid."}}), 400

    async def run_finalization():
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        config_doc = config_ref.get()
        if not config_doc.exists: return jsonify({"error": {"message": "Configuration not found."}}), 404
        config_data = config_doc.to_dict()
        
        worker_bot_id = config_data.get("createdBy")
        worker_bot_ref = db.collection("userbots").document(worker_bot_id).get()
        if not worker_bot_ref.exists: return jsonify({"error": {"message": "Worker bot not found."}}), 500
        
        bot_creds = worker_bot_ref.to_dict()
        worker_client = TelegramClient(StringSession(bot_creds["session_string"]), bot_creds["api_id"], bot_creds["api_hash"])
        
        try:
            await worker_client.start(password=lambda: TELETHON_2FA_PASSWORD)
            me = await worker_client.get_me()
            participants = await worker_client(GetParticipantsRequest(channel=int(config_data.get("channelId")), filter=ChannelParticipantsSearch(''), offset=0, limit=200, hash=0))
            target_user = next((p for p in participants.users if p.id != me.id and not p.bot), None)
            
            if not target_user: raise Exception("Could not find you in the channel.")
            if not target_user.username: raise Exception("You must set a public Telegram @username.")

            transfer_results = await _transfer_ownership(worker_client, config_data.get("botUsername"), config_data.get("channelId"), target_user.id, target_user.username)
            config_ref.update({'ownership_transferred': True, 'finalization_status': transfer_results})
            db.collection('userbots').document(worker_bot_id).update({'last_used': firestore.SERVER_TIMESTAMP})
            return jsonify(transfer_results)
        except Exception as e:
            return jsonify({"error": {"message": f"{e}"}}), 500
        finally:
            if worker_client.is_connected(): await worker_client.disconnect()

    return asyncio.run(run_finalization())

if __name__ == "__main__":
    print("Starting local development server...")
    app.run(host="0.0.0.0", port=8080, debug=True, use_reloader=False)