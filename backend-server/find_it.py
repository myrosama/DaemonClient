# =================================================================
# --- FINAL VERSION - WITH SELF-CONTAINED FIX ---
# =================================================================
print("--- EXECUTING THE FINAL, SELF-CONTAINED main.py ---")

import os
import asyncio
import traceback
import re
import json
from pathlib import Path
import hashlib
import hmac

# --- CUSTOM FUNCTION TO LOAD .env FILE ---
def load_env_manually():
    """Manually loads environment variables from a .env file in the same directory."""
    current_dir = Path(__file__).parent
    env_path = current_dir / '.env'
    print(f"--- Attempting to load environment variables from: {env_path} ---")
    if not env_path.exists():
        print(f"!!! .env file not found at {env_path}. Skipping. !!!")
        return
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ[key] = value
    print("--- Finished loading environment variables. ---")

# --- Load Environment Variables FIRST ---
load_env_manually()

# --- IMPORTS ---
from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.channels import CreateChannelRequest, EditAdminRequest, EditCreatorRequest
from telethon.tl.functions.account import GetPasswordRequest
from telethon.tl.types import ChatAdminRights, InputCheckPasswordSRP
from telethon.errors.rpcerrorlist import UsernameNotOccupiedError, PasswordHashInvalidError, FloodWaitError
from google.cloud.firestore_v1.base_query import FieldFilter
from telethon.tl.helpers import get_bytes

# ================================================================
# --- SELF-CONTAINED SRP FIX (COPIED FROM TELETHON SOURCE CODE) ---
# This block of code makes our script work even with a broken
# Telethon installation by including the missing functions directly.
# ================================================================
async def get_srp_password_check(password, srp):
    p, g = int.from_bytes(srp.p, 'big'), srp.g
    g_b = int.from_bytes(srp.g_b, 'big')

    x_b = get_bytes(password)
    x = int.from_bytes(hashlib.sha256(srp.salt1 + x_b + srp.salt1).digest(), 'big')
    v = pow(g, x, p)

    k = int.from_bytes(hashlib.sha256(get_bytes(p) + get_bytes(g)).digest(), 'big')
    k_v = (k * v)

    a = int.from_bytes(os.urandom(256), 'big')
    g_a = pow(g, a, p)

    u = int.from_bytes(hashlib.sha256(get_bytes(g_a) + get_bytes(g_b)).digest(), 'big')
    if u == 0:
        # Retry with a new `a`
        return await get_srp_password_check(password, srp)

    s_a = pow(g_b - k_v, a + u * x, p)
    k1 = hashlib.sha256(get_bytes(s_a)).digest()

    m1_c = hashlib.sha256(
        hashlib.sha256(get_bytes(p)).digest()
        + hashlib.sha256(get_bytes(g)).digest()
        + hashlib.sha256(srp.salt1).digest()
        + hashlib.sha256(srp.salt2).digest()
        + hashlib.sha256(get_bytes(g_a)).digest()
        + hashlib.sha256(get_bytes(g_b)).digest()
        + k1
    ).digest()
    return InputCheckPasswordSRP(srp.srp_id, get_bytes(g_a), m1_c)
# --- END OF SELF-CONTAINED FIX ---

# --- Flask App & Firebase Initialization ---
app = Flask(__name__)
CORS(app)

try:
    firebase_creds_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
    if not firebase_creds_json:
        raise ValueError("FIREBASE_CREDENTIALS_JSON not set.")
    firebase_creds_dict = json.loads(firebase_creds_json)
    cred = credentials.Certificate(firebase_creds_dict)
    app_name = f'daemonclient-flask-{os.getpid()}'
    firebase_admin.initialize_app(cred, name=app_name)
    db = firestore.client(app=firebase_admin.get_app(name=app_name))
    print("✅ Firebase initialized successfully.")
except Exception as e:
    if 'already exists' in str(e):
        print("Firebase app already initialized.")
        db = firestore.client()
    else:
        print(f"FATAL: Could not initialize Firebase. Error: {e}")
        exit(1)

TELETHON_2FA_PASSWORD = os.getenv("TELETHON_2FA_PASSWORD")
if TELETHON_2FA_PASSWORD:
    print("✅ TELETHON_2FA_PASSWORD loaded.")
else:
    print("⚠️ WARNING: TELETHON_2FA_PASSWORD not set.")

# --- Bot Pool Management ---
def get_available_bots():
    print("Fetching available worker bots...")
    try:
        bots_ref = db.collection('userbots').where(filter=FieldFilter('is_active', '==', True)).order_by('last_used', direction=firestore.Query.ASCENDING).stream()
        bots_list = [{'doc_id': bot.id, **bot.to_dict()} for bot in bots_ref]
        print(f"Found {len(bots_list)} active bots.")
        return bots_list
    except Exception as e:
        print(f"Error fetching bots from Firestore: {e}")
        return []

# --- Core Telethon Logic ---
async def _create_resources(client, user_id, user_email):
    print(f"[{user_id}] Starting resource creation...")
    bot_name = f"{user_email.split('@')[0].replace('.', '_')}_Daemon"
    bot_username, bot_token = "", ""
    async with client.conversation('BotFather', timeout=120) as conv:
        await conv.send_message('/newbot')
        await conv.get_response()
        await conv.send_message(bot_name)
        await conv.get_response()
        for i in range(5):
            bot_username = f"dc_{user_id[:6]}_{os.urandom(3).hex()}_bot"
            await conv.send_message(bot_username)
            response = await conv.get_response()
            if "Done! Congratulations" in response.text:
                token_match = re.search(r'(\d+:[A-Za-z0-9\-_]+)', response.text)
                if token_match:
                    bot_token = token_match.group(1)
                break
            if i == 4:
                raise Exception("Failed to create a unique bot username after 5 attempts.")
    print(f"[{user_id}] Bot created: @{bot_username}")
    channel_title = f"DaemonClient Storage - {user_id[:8]}"
    result = await client(CreateChannelRequest(title=channel_title, about="Private storage for DaemonClient.", megagroup=True))
    channel_id = int(f"-100{result.chats[0].id}")
    print(f"[{user_id}] Channel created with ID: {channel_id}")
    await client(EditAdminRequest(
        channel=channel_id,
        user_id=bot_username,
        admin_rights=ChatAdminRights(post_messages=True, edit_messages=True, delete_messages=True),
        rank='DaemonBot'
    ))
    print(f"[{user_id}] Bot added as admin to the channel.")
    return bot_token, bot_username, channel_id

async def _transfer_ownership(client, target_username, bot_username, channel_id):
    """Transfers ownership of the channel and bot to the end-user."""
    print(f"Starting ownership transfer to @{target_username}...")
    try:
        target_entity = await client.get_entity(target_username)
    except (UsernameNotOccupiedError, ValueError):
        raise Exception(f"Username '{target_username}' not found or is invalid.")

    # 1. Transfer Channel Ownership
    print(f"Transferring channel {channel_id} to {target_entity.id}...")
    
    password_info = await client(GetPasswordRequest())
    
    # WE ARE NOW CALLING OUR OWN, SELF-CONTAINED FUNCTION
    srp_check = await get_srp_password_check(
        password=TELETHON_2FA_PASSWORD,
        srp=password_info
    )

    await client(EditCreatorRequest(
        channel=channel_id,
        user_id=target_entity,
        password=srp_check
    ))
    print(f"✅ Channel ownership transferred to @{target_username}")

    # 2. Transfer Bot Ownership
    print(f"Starting BotFather conversation for @{bot_username}...")
    async with client.conversation('BotFather', timeout=120) as conv:
        await conv.send_message('/mybots')
        resp = await conv.get_response()
        await resp.click(text=f"@{bot_username}")
        
        resp = await conv.get_response()
        await resp.click(text="Transfer Ownership")
        
        resp = await conv.get_response()
        if "Choose new owner" not in resp.text:
            raise Exception("BotFather flow error: Did not ask to choose a new owner.")
        
        await conv.send_message(target_username)
        
        resp = await conv.get_response()
        if not resp.buttons:
            raise Exception("BotFather flow error: Did not provide a confirmation button.")
            
        await resp.click(0)
        
        resp = await conv.get_response()
        if "Success" not in resp.text:
            raise Exception(f"BotFather did not confirm transfer. Final message: {resp.text}")

    print(f"✅ Bot ownership transferred to @{target_username}")

# --- API Endpoints ---
@app.route('/')
def index():
    return "DaemonClient Backend is alive!"

@app.route('/startSetup', methods=['POST'])
def start_setup_endpoint():
    data = request.get_json().get('data', {})
    user_id, user_email = data.get('uid'), data.get('email')
    if not user_id or not user_email:
        return jsonify({"error": {"message": "Missing uid or email."}}), 400
    print(f"Received setup request for user: {user_id}")
    available_bots = get_available_bots()
    if not available_bots:
        return jsonify({"error": {"message": "No available worker bots."}}), 503
    async def run_setup():
        for bot_creds in available_bots:
            client = TelegramClient(StringSession(bot_creds['session_string']), bot_creds['api_id'], bot_creds['api_hash'])
            try:
                print(f"Attempting with bot: {bot_creds['doc_id']}")
                await client.start(password=lambda: TELETHON_2FA_PASSWORD)
                bot_token, bot_username, channel_id = await _create_resources(client, user_id, user_email)
                config_path = f"artifacts/default-daemon-client/users/{user_id}/config"
                user_config_ref = db.collection(config_path).document("telegram")
                user_config_ref.set({
                    "botToken": bot_token,
                    "botUsername": bot_username,
                    "channelId": str(channel_id),
                    "ownership_transferred": False,
                    "setupTimestamp": firestore.SERVER_TIMESTAMP,
                    "createdBy": bot_creds['doc_id']
                })
                print(f"✅ Resources created for {user_id}. Disconnecting client.")
                return jsonify({"status": "success", "message": "Resources created."})
            except PasswordHashInvalidError:
                print(f"❌ Bot {bot_creds['doc_id']} failed: INCORRECT 2FA PASSWORD.")
                await client.disconnect()
                return jsonify({"error": {"message": "Server configuration error (2FA)."}}), 500
            except FloodWaitError as e:
                print(f"⚠️ Bot {bot_creds['doc_id']} is rate-limited. Waiting for {e.seconds}s.")
                await asyncio.sleep(e.seconds)
                continue
            except Exception as e:
                print(f"⚠️ Bot {bot_creds['doc_id']} failed. Error: {e}")
                traceback.print_exc()
                if client.is_connected():
                    await client.disconnect()
                continue
            finally:
                if client.is_connected():
                    await client.disconnect()
        return jsonify({"error": {"message": "All available worker bots failed."}}), 503
    return asyncio.run(run_setup())

@app.route('/confirmOwnership', methods=['POST'])
def confirm_ownership_endpoint():
    data = request.get_json().get('data', {})
    user_id, target_username = data.get('uid'), data.get('telegramUsername')
    if not user_id or not target_username:
        return jsonify({"error": {"message": "Missing uid or telegramUsername."}}), 400
    async def run_transfer():
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        config_doc = config_ref.get()
        if not config_doc.exists:
            return jsonify({"error": {"message": "Configuration not found for this user."}}), 404
        config_data = config_doc.to_dict()
        worker_bot_id = config_data.get("createdBy")
        bot_username = config_data.get("botUsername")
        channel_id = int(config_data.get("channelId"))
        worker_bot_ref = db.collection('userbots').document(worker_bot_id).get()
        if not worker_bot_ref.exists:
            return jsonify({"error": {"message": "The original worker bot could not be found."}}), 500
        bot_creds = worker_bot_ref.to_dict()
        client = TelegramClient(StringSession(bot_creds['session_string']), bot_creds['api_id'], bot_creds['api_hash'])
        try:
            await client.start(password=lambda: TELETHON_2FA_PASSWORD)
            await _transfer_ownership(client, target_username, bot_username, channel_id)
            config_ref.update({'ownership_transferred': True})
            db.collection('userbots').document(worker_bot_id).update({'last_used': firestore.SERVER_TIMESTAMP})
            print(f"✅✅ Ownership transfer successful for {user_id} to @{target_username}")
            return jsonify({"status": "success"})
        except Exception as e:
            print(f"❌❌ Ownership transfer FAILED for {user_id}. Error: {e}")
            traceback.print_exc()
            return jsonify({"error": {"message": f"{e}"}}), 500
        finally:
            if client.is_connected():
                await client.disconnect()
    return asyncio.run(run_transfer())

if __name__ == "__main__":
    print("Starting DaemonClient Backend Server...")
    app.run(host='0.0.0.0', port=8080, debug=True, use_reloader=False)