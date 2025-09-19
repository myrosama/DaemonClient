import os
import asyncio
import traceback
import re
import json
import time
import hashlib
from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore
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
)
from telethon.errors.rpcerrorlist import (
    UserDeactivatedBanError,
    FloodWaitError,
    UserNotParticipantError,
    PasswordHashInvalidError,
)
from telethon.errors import SessionPasswordNeededError
from telethon.password import compute_check


# Add these lines at the top of main.py
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


# --- Helper: wait for a message that contains buttons (with timeout) ---
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


# --- Helper: click a button containing text (MODIFIED) ---
async def click_button_containing_text_in_msg(msg, text, retries=5, delay=2, password=None):
    """
    Try to find & click a button containing `text`.
    Will retry `retries` times with `delay` seconds in between.
    Returns the click result or None.
    NOW ACCEPTS A PASSWORD for 2FA-protected clicks.
    """
    for attempt in range(retries):
        if msg and getattr(msg, "buttons", None):
            for row in msg.buttons:
                for button in row:
                    if text.lower() in button.text.lower():
                        print(f"✅ Found button: {button.text} (attempt {attempt+1})")
                        # NINJA TECHNIQUE: Pass the password directly with the click
                        return await button.click(password=password)
        print(f"🔄 Retry {attempt+1}/{retries}: waiting for buttons to appear...")
        await asyncio.sleep(delay)
        # Refresh the message object in case the buttons appeared in an edit
        try:
            msg = await msg.client.get_messages(msg.chat_id, ids=msg.id)
        except Exception:
             pass # Ignore if message not found, continue loop
    # Before failing, print available buttons for debugging
    if msg and getattr(msg, "buttons", None):
        print("⚠️ Available buttons:", [b.text for row in msg.buttons for b in row])
    return None

# --- Core Telethon Logic ---
async def _create_resources_with_userbot(client, user_id, user_email):
    print(f"[{user_id}] Starting resource creation...")
    bot_name = f"{user_email.split('@')[0]}'s DaemonClient"
    bot_username, bot_token = "", ""

    async with client.conversation("BotFather", timeout=90) as conv:
        await conv.send_message("/newbot")
        await conv.get_response()
        await conv.send_message(bot_name)
        await conv.get_response()

        for i in range(5):
            # Generate a unique username to avoid conflicts
            bot_username = f"dc_{user_id[:7]}_{os.urandom(4).hex()}_bot"
            await conv.send_message(bot_username)
            response = await conv.get_response()
            if "Done! Congratulations" in response.text:
                token_match = re.search(r"(\d+:[A-Za-z0-9\-_]+)", response.text)
                if not token_match:
                    raise Exception("Could not find bot token in BotFather's response.")
                bot_token = token_match.group(1)
                break
            if "username is already taken" in response.text and i < 4:
                print(f"Username {bot_username} taken, retrying...")
                continue
            # If it fails on the last attempt or for other reasons, raise an error
            raise Exception(f"Failed to create bot username. Last response: {response.text}")

    if not bot_token:
        raise Exception("Failed to create a bot after all attempts.")

    print(f"[{user_id}] Bot created: @{bot_username}")

    channel_title = f"DaemonClient Storage - {user_id[:6]}"
    # Create a channel (megagroup=True makes it a supergroup, which is standard)
    result = await client(CreateChannelRequest(title=channel_title, about="Private storage.", megagroup=True))
    new_channel = result.chats[0]
    # The channel ID for API calls is prefixed with -100
    channel_id = f"-100{new_channel.id}"
    print(f"[{user_id}] Channel created: {channel_id}")

    # Promote the new bot to an admin in the channel with necessary rights
    await client(
        EditAdminRequest(
            channel=new_channel.id,
            user_id=bot_username,
            admin_rights=ChatAdminRights(post_messages=True, edit_messages=True, delete_messages=True),
            rank="bot",
        )
    )
    print(f"[{user_id}] Bot added as admin.")

    # Create an invite link for the user to join
    invite_link_result = await client(ExportChatInviteRequest(int(channel_id)))
    invite_link = invite_link_result.link
    print(f"[{user_id}] Created invite link: {invite_link}")

    # Start the bot to ensure it's responsive
    await client.send_message(bot_username, "/start")
    print(f"[{user_id}] Worker has started a chat with @{bot_username}.")

    return bot_token, bot_username, channel_id, invite_link
# =========================================================================
# ===                  THE DEFINITIVE AND FINAL VERSION                 ===
# =========================================================================

from telethon.tl.functions.channels import EditCreatorRequest
from telethon.tl.functions.account import GetPasswordRequest
from telethon.errors import PasswordHashInvalidError

# THE TRUE PATH, DISCOVERED BY OUR SCRIPT:
from telethon.password import compute_check


async def _transfer_ownership(worker_client, bot_username, channel_id, target_user_id, target_user_username):
    results = {
        "bot_transfer_status": "pending", "bot_transfer_message": "",
        "channel_transfer_status": "pending", "channel_transfer_message": "",
    }

    password_2fa = os.getenv("TELETHON_2FA_PASSWORD")
    if not password_2fa:
        raise ValueError("CRITICAL: TELETHON_2FA_PASSWORD is not set in the environment.")
    
    # --- BOT TRANSFER (This code is perfect and remains unchanged) ---
    try:
        print(f"Starting bot transfer for @{bot_username} to @{target_user_username}...")
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
            
            clicked = await click_button_containing_text_in_msg(
                resp_final_confirm, "Yes, I am sure", password=password_2fa
            )
            if not clicked:
                clicked = await click_button_containing_text_in_msg(
                    resp_final_confirm, "proceed", password=password_2fa
                )
            if not clicked:
                raise Exception("Could not find or click the final confirmation button.")
            await conv.get_response(timeout=15)

        results["bot_transfer_status"] = "success"
        results["bot_transfer_message"] = "Bot ownership successfully transferred."
        print(f"✅ Bot ownership transferred to {target_user_id}")

    except Exception as e:
        print(f"❌ Bot transfer FAILED. Error: {e}")
        traceback.print_exc()
        results["bot_transfer_status"] = "failed"
        results["bot_transfer_message"] = f"Bot transfer failed: {e}"

    # --- CHANNEL TRANSFER (FINAL FIX) ---
    if results["bot_transfer_status"] == "success":
        try:
            print(f"Starting channel ownership transfer for {channel_id}...")
            print("   -> Step 1/3: Fetching 2FA (SRP) parameters from Telegram...")
            account_password = await worker_client(GetPasswordRequest())
            
            print("   -> Step 2/3: Calculating SRP check object...")
            # THE FIX: This function is synchronous, so we remove 'await'.
            srp_check = compute_check(account_password, password_2fa)

            print("   -> Step 3/3: Executing transfer request with the SRP check object...")
            await worker_client(EditCreatorRequest(
                channel=int(channel_id),
                user_id=target_user_id,
                password=srp_check
            ))
            results["channel_transfer_status"] = "success"
            results["channel_transfer_message"] = "Channel ownership successfully transferred."
            print(f"✅ Channel ownership transferred to {target_user_id}")

        except Exception as e:
            print(f"❌ Channel transfer FAILED. Error: {e}")
            traceback.print_exc()
            results["channel_transfer_status"] = "failed"
            results["channel_transfer_message"] = f"Channel transfer failed: {e}"

    return results
# --- API Endpoints ---
@app.route("/")
def index():
    return "DaemonClient is alive!"


@app.route("/startSetup", methods=["POST"])
def start_setup_endpoint():
    data = request.get_json().get("data", {})
    user_id, user_email = data.get("uid"), data.get("email")
    if not user_id or not user_email:
        return jsonify({"error": "Missing uid or email in request body."}), 400
    print(f"Received setup request for user: {user_id}")

    available_bots = get_available_bots()
    if not available_bots:
        print("FATAL: No active userbots found in Firestore.")
        return jsonify({"error": {"message": "No available worker bots to process the request."}}), 500

    async def run_setup_flow():
        for bot_creds in available_bots:
            bot_doc_id = bot_creds["doc_id"]
            client = TelegramClient(StringSession(bot_creds["session_string"]), bot_creds["api_id"], bot_creds["api_hash"])
            try:
                print(f"Attempting setup with bot: {bot_doc_id}")

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
                print(f"✅ Successfully configured user: {user_id} using bot {bot_doc_id}")
                return jsonify({"status": "success"})

            except UserDeactivatedBanError as e:
                print(f"⛔️ Bot {bot_doc_id} is BANNED. Deactivating. Error: {e}")
                db.collection("userbots").document(bot_doc_id).update({'is_active': False, 'status': 'banned'})
                continue
            except Exception as e:
                print(f"⚠️ Bot {bot_doc_id} failed. Trying next bot. Error: {e}")
                db.collection("userbots").document(bot_doc_id).update({'status': f'error: {str(e)[:200]}', 'error_count': firestore.Increment(1)})
                traceback.print_exc()
                continue
            finally:
                if client.is_connected():
                    await client.disconnect()

        print(f"CRITICAL: All {len(available_bots)} userbots failed for user {user_id}.")
        return jsonify({"error": {"message": "All available worker bots failed. Please check bot health in Firestore."}}), 500

    return asyncio.run(run_setup_flow())


@app.route("/finalizeTransfer", methods=["POST"])
def finalize_transfer_endpoint():
    data = request.get_json().get("data", {})
    user_id = data.get("uid")
    if not user_id:
        return jsonify({"error": {"message": "Missing uid."}}), 400

    async def run_finalization():
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        config_doc = config_ref.get()
        if not config_doc.exists:
            return jsonify({"error": {"message": "Configuration not found."}}), 404
        config_data = config_doc.to_dict()
        bot_username = config_data.get("botUsername")
        channel_id = config_data.get("channelId")
        worker_bot_id = config_data.get("createdBy")
        worker_bot_ref = db.collection("userbots").document(worker_bot_id).get()
        if not worker_bot_ref.exists:
            return jsonify({"error": {"message": "Worker bot not found."}}), 500
        bot_creds = worker_bot_ref.to_dict()
        worker_client = TelegramClient(StringSession(bot_creds["session_string"]), bot_creds["api_id"], bot_creds["api_hash"])
        try:
            await worker_client.start(password=lambda: TELETHON_2FA_PASSWORD)
            me = await worker_client.get_me()

            print(f"Looking for new user in channel {channel_id}...")
            participants = await worker_client(GetParticipantsRequest(channel=int(channel_id), filter=ChannelParticipantsSearch(''), offset=0, limit=200, hash=0))
            target_user = next((p for p in participants.users if p.id != me.id and not p.bot), None)
            if not target_user:
                raise Exception("Could not find you in the channel. Please join the channel and try again.")

            if not target_user.username:
                raise Exception("You must set a public Telegram @username to complete the transfer.")

            target_user_id = target_user.id
            target_user_username = target_user.username
            print(f"Found user {target_user_id} with username @{target_user_username}.")

            transfer_results = await _transfer_ownership(worker_client, bot_username, channel_id, target_user_id, target_user_username)

            update_data = {'ownership_transferred': True, 'finalization_status': transfer_results}
            config_ref.update(update_data)
            db.collection('userbots').document(worker_bot_id).update({'last_used': firestore.SERVER_TIMESTAMP})
            print(f"✅ Finalization complete for {user_id}.")
            return jsonify(transfer_results)
        except Exception as e:
            print(f"❌❌ Finalization FAILED for {user_id}. Error: {e}")
            traceback.print_exc()
            return jsonify({"error": {"message": f"{e}"}}), 500
        finally:
            if worker_client.is_connected():
                await worker_client.disconnect()

    return asyncio.run(run_finalization())


if __name__ == "__main__":
    print("Starting local development server...")
    app.run(host="0.0.0.0", port=8080, debug=True, use_reloader=False)
