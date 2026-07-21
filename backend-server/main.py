import os
import asyncio
import traceback
import re
import json
import time
import hashlib
import threading
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
# Browser-facing endpoints are only ever called from the DaemonClient web apps.
# The old wildcard CORS combined with unauthenticated setup endpoints let ANY
# website drive bot/channel mutations for arbitrary uids from a visitor's
# browser. Server-to-server callers (the per-user worker's HEIC conversion)
# send no Origin header, so CORS does not affect them.
ALLOWED_ORIGINS = [
    "https://accounts.daemonclient.uz",
    "https://daemonclient.uz",
    "https://www.daemonclient.uz",
    "https://photos.daemonclient.uz",
    "https://drive.daemonclient.uz",
    "http://localhost:5173",
    "http://localhost:5174",
]
CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGINS}}, allow_headers=["Content-Type", "Authorization"])

# --- HEIC support ---
# Cloudflare Workers can't decode HEIC (libheif is too heavy for the 10ms free
# CPU budget) and Telegram won't auto-thumbnail HEIC documents. This real CPU
# (Render) can, via pillow-heif. The per-user worker POSTs raw HEIC bytes here
# and gets back a downscaled JPEG it then encrypts + stores as the thumbnail.
# Guarded so the server still boots if the dependency isn't installed yet.
try:
    import io
    import pillow_heif
    from PIL import Image
    pillow_heif.register_heif_opener()
    _HEIC_OK = True
    print("✅ pillow-heif registered — HEIC→JPEG conversion available")
except Exception as _heic_err:
    _HEIC_OK = False
    print(f"⚠️ HEIC conversion unavailable: {_heic_err}")

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
_last_bot_query_error: str | None = None

def get_available_bots():
    global _last_bot_query_error
    _last_bot_query_error = None
    print("Fetching available userbots from Firestore...")
    try:
        bots_ref = (
            db.collection("userbots")
            .where(filter=FieldFilter("is_active", "==", True))
            .order_by("last_used", direction=firestore.Query.ASCENDING)
            .stream()
        )
        bots_list = [{"doc_id": bot.id, **bot.to_dict()} for bot in bots_ref]
        # Skip userbots another process is mid-conversation with (best-effort
        # cross-process lease; in-process _userbot_lock is the hard guard).
        # Interleaving two BotFather conversations on one account corrupts both.
        now = time.time()
        leased = [b for b in bots_list if (b.get("busy_until") or 0) > now]
        if leased:
            print(f"Skipping {len(leased)} busy userbot(s): {[b['doc_id'] for b in leased]}")
        bots_list = [b for b in bots_list if (b.get("busy_until") or 0) <= now]
        print(f"Found {len(bots_list)} active bots.")
        return bots_list
    except Exception as e:
        err = f"{type(e).__name__}: {str(e)[:400]}"
        _last_bot_query_error = err
        print(f"Error fetching bots from Firestore: {err}")
        import traceback; traceback.print_exc()
        return []

def get_last_bot_query_error():
    return _last_bot_query_error

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

async def _create_resources_with_userbot(client, user_id, user_email, checkpoint=None, save=None):
    """Create (or RESUME creating) the user's bot + channel.

    Every external side effect is checkpointed to Firestore the moment it
    exists, and every step first checks the checkpoint. This is what stops the
    double-bot bug: previously ANY failure after /newbot (FloodWait on channel
    creation, a killed request, a BotFather hiccup on /setdescription) threw
    the whole attempt away, released the idempotency lock, and the retry —
    next pool userbot or the user clicking again — created a SECOND bot and
    channel, with the config doc keeping whichever finished last.
    """
    print(f"[{user_id}] Starting resource creation...")
    checkpoint = checkpoint or {}

    def _save(fields):
        if save:
            try:
                save(fields)
            except Exception as e:
                print(f"[{user_id}] checkpoint save failed (continuing): {e}")

    bot_name = f"{user_email.split('@')[0]}'s DaemonClient"
    bot_username = checkpoint.get("botUsername") or ""
    bot_token = checkpoint.get("botToken") or ""
    bot_created_now = False

    if bot_token and bot_username:
        print(f"[{user_id}] Resuming with existing bot @{bot_username} (checkpoint)")
    else:
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

        # The bot exists at BotFather from this moment — persist it BEFORE any
        # other step so no later failure can ever lead to a second /newbot.
        _save({"botToken": bot_token, "botUsername": bot_username, "setup_stage": "bot_created"})
        bot_created_now = True

    # Cosmetics (description + profile pic) — best-effort, never abort setup.
    if bot_created_now:
        try:
            description_text = (
                "👇 Click START below, then return to the website to finalize the setup.\n\n"
                "_(Note: This bot will not reply after you press Start.)_"
            )
            async with client.conversation("BotFather", timeout=60) as conv:
                await conv.send_message("/setdescription")
                await conv.get_response()
                await conv.send_message(f"@{bot_username}")
                await conv.get_response()
                await conv.send_message(description_text)
                await conv.get_response()

                if ASSET_CHANNEL_ID and BOT_PIC_MESSAGE_ID:
                    await conv.send_message("/setuserpic")
                    await conv.get_response()
                    await conv.send_message(f"@{bot_username}")
                    await conv.get_response()
                    photo_message = await client.get_messages(ASSET_CHANNEL_ID, ids=BOT_PIC_MESSAGE_ID)
                    await conv.send_file(photo_message.photo)
                    await conv.get_response(timeout=30)
        except Exception as e:
            print(f"⚠️ Bot cosmetics failed (non-fatal): {e}")

    # Create Channel (skipped on resume)
    channel_id = checkpoint.get("channelId") or ""
    channel_created_now = False
    if channel_id:
        print(f"[{user_id}] Resuming with existing channel {channel_id} (checkpoint)")
    else:
        channel_title = f"DaemonClient Storage - {user_id[:6]}"
        result = await client(CreateChannelRequest(title=channel_title, about="Private storage.", megagroup=True))
        new_channel = result.chats[0]
        channel_id = f"-100{new_channel.id}"
        _save({"channelId": channel_id, "setup_stage": "channel_created"})
        channel_created_now = True

    # Add Bot as Admin (idempotent — safe to repeat on resume)
    await client(
        EditAdminRequest(
            channel=int(channel_id),
            user_id=bot_username,
            admin_rights=ChatAdminRights(post_messages=True, edit_messages=True, delete_messages=True),
            rank="bot",
        )
    )

    # Generate Invite Link (a fresh link on resume is fine)
    invite_link_result = await client(ExportChatInviteRequest(int(channel_id)))
    invite_link = invite_link_result.link

    await client.send_message(bot_username, "/start")

    # Clean up service messages + send the pinned welcome only when the channel
    # was created in THIS run — a resume must not double-post/pin.
    if channel_created_now:
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
    if channel_created_now:
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

# ── Setup concurrency guards ─────────────────────────────────────────────────
# Atomic read+claim of the per-user telegram config doc. The old read-then-set
# pair had a race window: a Render cold start queues several /startSetup
# retries at the proxy and replays them near-simultaneously when the service
# boots — both pre-reads saw "no lock" and BOTH created a bot+channel.
def claim_setup_lock(user_config_ref):
    transaction = db.transaction()

    @firestore.transactional
    def _claim(tx):
        snap = user_config_ref.get(transaction=tx)
        data = snap.to_dict() if snap.exists else None
        if data:
            if data.get("botToken") and data.get("botUsername") and data.get("channelId"):
                return "already_configured", data
            started = data.get("setup_started_at")
            if started is not None:
                try:
                    age = time.time() - started.timestamp()
                except Exception:
                    age = 0
                if age < 240:
                    return "in_progress", data
        tx.set(user_config_ref, {"setup_started_at": firestore.SERVER_TIMESTAMP}, merge=True)
        return "claimed", data

    return _claim(transaction)

# One BotFather conversation per userbot at a time within this process.
_userbot_locks = {}
_userbot_locks_guard = threading.Lock()

def _userbot_lock(doc_id):
    with _userbot_locks_guard:
        if doc_id not in _userbot_locks:
            _userbot_locks[doc_id] = threading.Lock()
        return _userbot_locks[doc_id]

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

@app.route('/api/zke-config', methods=['GET'])
@check_auth
def get_zke_config():
    """Returns the ZKE config (password, salt, enabled) so the CLI can derive the key locally."""
    try:
        zke_ref = db.collection(f"artifacts/default-daemon-client/users/{request.user_uid}/config").document("zke")
        zke_doc = zke_ref.get()
        if not zke_doc.exists:
            return jsonify({'enabled': False})
        data = zke_doc.to_dict()
        return jsonify({
            'enabled': data.get('enabled', False),
            'mode': data.get('mode', 'auto'),
            'password': data.get('password', ''),
            'salt': data.get('salt', ''),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500
# --- EXISTING ENDPOINTS ---
# ============================================================================

@app.route("/")
def index():
    return "DaemonClient API is running."

@app.route("/convertHeicThumbnail", methods=["POST"])
@check_auth
def convert_heic_thumbnail():
    """Decode HEIC (raw bytes in the request body) and return a downscaled JPEG.
    Called by the per-user worker at upload time when a HEIC is uploaded from the
    mobile app — Telegram can't thumbnail HEIC and the Worker can't decode it.
    The worker then encrypts the returned JPEG and stores it as the thumbnail,
    so this server never persists anything (transient, in-memory only)."""
    if not _HEIC_OK:
        return jsonify({'error': 'HEIC conversion unavailable on server'}), 503
    data = request.get_data()
    if not data:
        return jsonify({'error': 'empty body'}), 400
    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
        # 720px longest edge: small enough for a fast grid thumbnail, sharp
        # enough to double as a preview. ThumbHash (computed in the worker from
        # this JPEG) provides the instant blur placeholder.
        img.thumbnail((720, 720))
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=80, optimize=True)
        return out.getvalue(), 200, {'Content-Type': 'image/jpeg'}
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': f'HEIC decode failed: {str(e)}'}), 500

@app.route("/startSetup", methods=["POST"])
@check_auth
def start_setup_endpoint():
    # uid/email come from the VERIFIED Firebase token. The old body-supplied
    # uid meant ANY caller could trigger bot/channel creation — or poison the
    # config doc — for an arbitrary victim uid, with no authentication at all.
    user_id = request.user_uid
    user_email = request.user_email or f"{user_id}@daemonclient.uz"

    # ── Idempotency guard (atomic) ───────────────────────────────────────────
    # Creating a bot+channel takes 30-90s (BotFather conversation) and Render's
    # free tier cold-starts for up to a minute on top. Users WILL click again.
    # Rules:
    #   - config already complete  -> report success, create nothing
    #   - setup started <4 min ago -> 202 "in progress", create nothing
    #   - otherwise                -> claim the lock transactionally and proceed
    user_config_ref = db.collection(
        f"artifacts/default-daemon-client/users/{user_id}/config"
    ).document("telegram")
    try:
        status, existing = claim_setup_lock(user_config_ref)
    except Exception as e:
        print(f"[startSetup] lock claim failed for {user_id}: {e}")
        return jsonify({"error": {"message": "Could not acquire the setup lock — please retry."}}), 500
    if status == "already_configured":
        return jsonify({"status": "already_configured"})
    if status == "in_progress":
        return jsonify({"status": "in_progress"}), 202

    available_bots = get_available_bots()
    if not available_bots:
        try:
            user_config_ref.update({"setup_started_at": firestore.DELETE_FIELD})
        except Exception:
            pass
        query_err = get_last_bot_query_error()
        return jsonify({"error": {
            "message": "No available worker bots to process the request.",
            "query_error": query_err,
            "hint": "If query_error mentions an index, Firestore needs a composite index on (is_active ASC, last_used ASC) for the userbots collection."
        }}), 500

    # Any partial progress from a previous failed attempt (bot already created,
    # channel missing, …) — resume from it instead of re-creating resources.
    checkpoint = dict(existing) if existing else {}

    async def run_setup_flow():
        failures = []
        resume_created_by = checkpoint.get("createdBy")
        has_bot_checkpoint = bool(checkpoint.get("botToken") and checkpoint.get("botUsername"))
        bots = list(available_bots)
        # A half-created bot belongs to the userbot that ran /newbot (only the
        # owner can transfer it later) — try that userbot first on resume.
        if has_bot_checkpoint and resume_created_by:
            bots.sort(key=lambda b: 0 if b["doc_id"] == resume_created_by else 1)

        for bot_creds in bots:
            bot_doc_id = bot_creds["doc_id"]
            is_resume = has_bot_checkpoint and bot_doc_id == resume_created_by
            if has_bot_checkpoint and not is_resume:
                print(f"[{user_id}] creator userbot {resume_created_by} unavailable — "
                      f"orphaning half-made bot @{checkpoint.get('botUsername')} and starting fresh with {bot_doc_id}")
                # Clear the stale partial fields so a crash mid-fresh-attempt
                # can never resume against the dead userbot's bot/channel.
                try:
                    user_config_ref.update({
                        "botToken": firestore.DELETE_FIELD,
                        "botUsername": firestore.DELETE_FIELD,
                        "channelId": firestore.DELETE_FIELD,
                        "invite_link": firestore.DELETE_FIELD,
                        "setup_stage": firestore.DELETE_FIELD,
                    })
                except Exception:
                    pass
            attempt_checkpoint = checkpoint if is_resume else {}

            lock = _userbot_lock(bot_doc_id)
            if not lock.acquire(timeout=300):
                failures.append({"bot": bot_doc_id, "error": "busy (another setup in progress)"})
                continue
            bot_ref = db.collection("userbots").document(bot_doc_id)
            try:
                bot_ref.update({"busy_until": time.time() + 300})
            except Exception:
                pass
            client = TelegramClient(StringSession(bot_creds["session_string"]), bot_creds["api_id"], bot_creds["api_hash"])
            try:
                await client.start(password=lambda: TELETHON_2FA_PASSWORD)

                def save_checkpoint(fields):
                    user_config_ref.set({**fields, "createdBy": bot_doc_id}, merge=True)

                bot_token, bot_username, channel_id, invite_link = await _create_resources_with_userbot(
                    client, user_id, user_email,
                    checkpoint=attempt_checkpoint, save=save_checkpoint,
                )

                user_config_ref.set({
                    "botToken": bot_token,
                    "botUsername": bot_username,
                    "channelId": channel_id,
                    "invite_link": invite_link,
                    "ownership_transferred": False,
                    "createdBy": bot_doc_id
                }, merge=True)
                try:
                    user_config_ref.update({
                        "setup_started_at": firestore.DELETE_FIELD,
                        "setup_stage": firestore.DELETE_FIELD,
                    })
                except Exception:
                    pass
                bot_ref.update({'last_used': firestore.SERVER_TIMESTAMP, 'status': 'healthy', 'busy_until': 0})
                print(f"[{user_id}] Setup complete: @{bot_username} / {channel_id}")
                return

            except UserDeactivatedBanError as e:
                bot_ref.update({'is_active': False, 'status': 'banned'})
                failures.append({"bot": bot_doc_id, "error": "banned"})
                print(f"[{bot_doc_id}] BANNED: {e}")
                continue
            except Exception as e:
                err_str = f"{type(e).__name__}: {str(e)[:300]}"
                bot_ref.update({'status': f'error: {err_str[:200]}', 'error_count': firestore.Increment(1)})
                failures.append({"bot": bot_doc_id, "error": err_str})
                print(f"[{bot_doc_id}] FAILED: {err_str}")
                traceback.print_exc()
                continue
            finally:
                try:
                    bot_ref.update({'busy_until': 0})
                except Exception:
                    pass
                if client.is_connected(): await client.disconnect()
                lock.release()

        # Every pool userbot failed. If a PARTIAL checkpoint exists (bot made,
        # channel not), KEEP the lock+checkpoint so the next attempt resumes
        # instead of creating a second bot; the lock's 4-min age gates retries.
        # Only a truly empty attempt releases the lock immediately.
        latest = user_config_ref.get()
        latest_data = latest.to_dict() if latest.exists else None
        if not (latest_data and latest_data.get("botToken")):
            try:
                user_config_ref.update({"setup_started_at": firestore.DELETE_FIELD})
            except Exception:
                pass
        print(f"[{user_id}] All worker bots failed: {failures}")

    # Run the slow Telethon flow in a background thread and answer 202 now.
    # Blocking the request for 30-90s starved the single web worker (health
    # checks + every other user 502'd), tripped proxy/worker timeouts mid-
    # creation (orphaning bots), and made the signup page hang for minutes —
    # which is exactly when users refresh and click again. The client already
    # polls Firestore for the finished config, so it needs no response body.
    threading.Thread(target=lambda: asyncio.run(run_setup_flow()), daemon=True).start()
    return jsonify({"status": "started"}), 202

@app.route("/finalizeTransfer", methods=["POST"])
@check_auth
def finalize_transfer_endpoint():
    # uid from the verified token — the body-supplied uid let anyone trigger an
    # ownership transfer of a victim's channel (to whichever human joined it).
    user_id = request.user_uid

    async def run_finalization():
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        config_doc = config_ref.get()
        if not config_doc.exists: return jsonify({"error": {"message": "Configuration not found."}}), 404
        config_data = config_doc.to_dict()

        # Idempotent: a double-click / retry after the transfer already
        # succeeded must not run a second transfer against Telegram (which
        # fails confusingly once ownership has moved).
        if config_data.get("ownership_transferred"):
            prev = config_data.get("finalization_status") or {}
            return jsonify({
                "bot_transfer_status": prev.get("bot_transfer_status", "success"),
                "bot_transfer_message": prev.get("bot_transfer_message", "Bot ownership already transferred."),
                "channel_transfer_status": prev.get("channel_transfer_status", "success"),
                "channel_transfer_message": prev.get("channel_transfer_message", "Channel ownership already transferred."),
            })
        
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

@app.route('/api/register', methods=['POST'])
@check_auth
def register_file():
    """Registers a completed upload in Firestore."""
    data = request.get_json()
    
    # Validate required fields
    required = ['fileName', 'fileSize', 'messages', 'parentId', 'type']
    if not all(k in data for k in required):
        return jsonify({'error': 'Missing metadata fields'}), 400

    try:
        # Create the new file document
        # We use the same path as the web app
        files_col = db.collection(f"artifacts/default-daemon-client/users/{request.user_uid}/files")
        new_doc = files_col.document()
        
        file_data = {
            'id': new_doc.id,
            'fileName': data['fileName'],
            'fileSize': data['fileSize'],
            'fileType': data.get('fileType', 'application/octet-stream'),
            'parentId': data['parentId'],
            'type': data['type'],
            'messages': data['messages'],
            'uploadedAt': firestore.SERVER_TIMESTAMP
        }
        
        new_doc.set(file_data)
        
        return jsonify({'status': 'success', 'file_id': new_doc.id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route("/addPhotosBot", methods=["POST"])
@check_auth
def add_photos_bot_endpoint():
    """
    Takes a user-provided bot token and adds it as admin to their existing channel.
    This gives the photos feature its own bot for rate-limit separation.

    uid from the verified token — the old body-supplied uid let an attacker add
    THEIR OWN bot as admin to a victim's storage channel (full read/delete of
    the victim's stored files) knowing nothing but the victim's uid.
    """
    data = (request.get_json(silent=True) or {}).get("data", {})
    user_id = request.user_uid
    photos_bot_token = data.get("bot_token")

    if not photos_bot_token:
        return jsonify({"error": {"message": "Missing bot_token."}}), 400

    # Validate the bot token format
    if ":" not in photos_bot_token:
        return jsonify({"error": {"message": "Invalid bot token format."}}), 400

    async def run_add_bot():
        # 1. Get user's existing channel config
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        config_doc = config_ref.get()
        if not config_doc.exists:
            return jsonify({"error": {"message": "No storage channel found. Complete the main setup first."}}), 404

        config_data = config_doc.to_dict()
        channel_id = config_data.get("channelId")
        if not channel_id:
            return jsonify({"error": {"message": "Channel ID not found in config."}}), 404

        # 2. Extract bot username from token via Telegram API
        import requests as http_requests
        try:
            bot_info_resp = http_requests.get(f"https://api.telegram.org/bot{photos_bot_token}/getMe", timeout=10)
            bot_info = bot_info_resp.json()
            if not bot_info.get("ok"):
                return jsonify({"error": {"message": "Invalid bot token — could not reach the bot."}}), 400
            photos_bot_username = bot_info["result"]["username"]
        except Exception as e:
            return jsonify({"error": {"message": f"Could not validate bot token: {e}"}}), 400

        # 3. Use a userbot to add the photos bot to the channel as admin
        available_bots = get_available_bots()
        if not available_bots:
            return jsonify({"error": {"message": "No available worker bots."}}), 500

        for bot_creds in available_bots:
            bot_doc_id = bot_creds["doc_id"]
            client = TelegramClient(StringSession(bot_creds["session_string"]), bot_creds["api_id"], bot_creds["api_hash"])
            try:
                await client.start(password=lambda: TELETHON_2FA_PASSWORD)

                # Add the photos bot as admin to the channel
                await client(
                    EditAdminRequest(
                        channel=int(channel_id),
                        user_id=photos_bot_username,
                        admin_rights=ChatAdminRights(
                            post_messages=True,
                            edit_messages=True,
                            delete_messages=True,
                        ),
                        rank="photos",
                    )
                )

                # Start the bot (so it can access the channel)
                await client.send_message(photos_bot_username, "/start")

                # 4. Save photos bot config to Firestore
                photos_config_ref = db.collection(
                    f"artifacts/default-daemon-client/users/{user_id}/config"
                ).document("photos_telegram")
                photos_config_ref.set({
                    "botToken": photos_bot_token,
                    "botUsername": photos_bot_username,
                    "channelId": channel_id,
                    "setupTimestamp": firestore.SERVER_TIMESTAMP,
                })

                db.collection("userbots").document(bot_doc_id).update({
                    'last_used': firestore.SERVER_TIMESTAMP, 'status': 'healthy'
                })

                print(f"✅ Photos bot @{photos_bot_username} added to channel {channel_id} for user {user_id}")
                return jsonify({"status": "success", "bot_username": photos_bot_username})

            except UserDeactivatedBanError:
                db.collection("userbots").document(bot_doc_id).update({'is_active': False, 'status': 'banned'})
                continue
            except Exception as e:
                print(f"❌ Failed to add photos bot with worker {bot_doc_id}: {e}")
                db.collection("userbots").document(bot_doc_id).update({
                    'status': f'error: {str(e)[:200]}',
                    'error_count': firestore.Increment(1),
                })
                continue
            finally:
                if client.is_connected():
                    await client.disconnect()

        return jsonify({"error": {"message": "All worker bots failed to add the photos bot."}}), 500

    return asyncio.run(run_add_bot())

if __name__ == "__main__":
    print("Starting local development server...")
    app.run(host="0.0.0.0", port=8080, debug=True, use_reloader=False)