import os
import asyncio
import traceback
import re
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv
from google.cloud.firestore_v1.base_query import FieldFilter
import hashlib
from telethon.tl.types import InputPeerUser
from telethon.tl.functions.account import GetPasswordRequest
from telethon.tl.types import InputPeerUser

# Import Telethon libraries
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.channels import CreateChannelRequest, EditAdminRequest, EditCreatorRequest, GetParticipantsRequest
from telethon.tl.functions.messages import GetHistoryRequest, ExportChatInviteRequest
from telethon.tl.types import ChannelParticipantsSearch, ChatAdminRights, InputCheckPasswordSRP
from telethon.errors.rpcerrorlist import UserDeactivatedBanError, FloodWaitError, UserNotParticipantError

# --- Load Environment Variables ---
load_dotenv()

# --- Initialize Flask App ---
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# --- Initialize Firebase Admin SDK ---
try:
    firebase_creds_json = os.getenv("FIREBASE_CREDENTIALS_JSON")
    if not firebase_creds_json: raise ValueError("FIREBASE_CREDENTIALS_JSON environment variable not set.")
    cred = credentials.Certificate(json.loads(firebase_creds_json))
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase initialized successfully.")
except Exception as e:
    print(f"FATAL: Could not initialize Firebase. Error: {e}")

TELETHON_2FA_PASSWORD = os.getenv("TELETHON_2FA_PASSWORD")

# --- SELF-CONTAINED SRP FIX ---
def get_bytes(value):
    if isinstance(value, bytes): return value
    if isinstance(value, str): return value.encode('utf-8')
    if isinstance(value, int): return value.to_bytes((value.bit_length() + 8) // 8, 'big', signed=True)
    return b''
async def get_srp_password_check(password, srp):
    p, g = int.from_bytes(srp.p, 'big'), srp.g; g_b = int.from_bytes(srp.g_b, 'big')
    x_b = get_bytes(password); x = int.from_bytes(hashlib.sha256(srp.salt1 + x_b + srp.salt1).digest(), 'big'); v = pow(g, x, p)
    k = int.from_bytes(hashlib.sha256(get_bytes(p) + get_bytes(g)).digest(), 'big'); k_v = (k * v)
    a = int.from_bytes(os.urandom(256), 'big'); g_a = pow(g, a, p)
    u = int.from_bytes(hashlib.sha256(get_bytes(g_a) + get_bytes(g_b)).digest(), 'big')
    if u == 0: return await get_srp_password_check(password, srp)
    s_a = pow(g_b - k_v, a + u * x, p); k1 = hashlib.sha256(get_bytes(s_a)).digest()
    m1_c = hashlib.sha256(hashlib.sha256(get_bytes(p)).digest() + hashlib.sha256(get_bytes(g)).digest() + hashlib.sha256(srp.salt1).digest() + hashlib.sha256(srp.salt2).digest() + hashlib.sha256(get_bytes(g_a)).digest() + hashlib.sha256(get_bytes(g_b)).digest() + k1).digest()
    return InputCheckPasswordSRP(srp.srp_id, get_bytes(g_a), m1_c)

# --- Bot Pool Management (Your original, working function) ---
def get_available_bots():
    print("Fetching available userbots from Firestore...")
    try:
        bots_ref = db.collection('userbots').where(filter=FieldFilter('is_active', '==', True)).order_by('last_used', direction=firestore.Query.ASCENDING).stream()
        bots_list = [{'doc_id': bot.id, **bot.to_dict()} for bot in bots_ref]
        print(f"Found {len(bots_list)} active bots.")
        return bots_list
    except Exception as e:
        print(f"Error fetching bots from Firestore: {e}"); return []

# --- UPGRADED Core Telethon Logic ---
async def _create_resources_with_userbot(client, user_id, user_email):
    print(f"[{user_id}] Starting resource creation..."); bot_name = f"{user_email.split('@')[0]}'s DaemonClient"; bot_username, bot_token = "", ""
    async with client.conversation('BotFather', timeout=90) as conv:
        await conv.send_message('/newbot'); await conv.get_response()
        await conv.send_message(bot_name); await conv.get_response()
        for i in range(5):
            bot_username = f"dc_{user_id[:7]}_{os.urandom(4).hex()}_bot"; await conv.send_message(bot_username); response = await conv.get_response()
            if "Done! Congratulations" in response.text:
                token_match = re.search(r'(\d+:[A-Za-z0-9\-_]+)', response.text)
                if not token_match: raise Exception("Could not find bot token.")
                bot_token = token_match.group(1); break
            if "username is already taken" in response.text and i < 4: continue
            raise Exception(f"Failed to create bot username.")
    print(f"[{user_id}] Bot created: @{bot_username}")

    channel_title = f"DaemonClient Storage - {user_id[:6]}"; result = await client(CreateChannelRequest(title=channel_title, about="Private storage.", megagroup=True))
    new_channel = result.chats[0]; channel_id = f"-100{new_channel.id}"; print(f"[{user_id}] Channel created: {channel_id}")
    await client(EditAdminRequest(channel=new_channel.id, user_id=bot_username, admin_rights=ChatAdminRights(post_messages=True, edit_messages=True, delete_messages=True), rank='bot'))
    print(f"[{user_id}] Bot added as admin.")
    
    invite_link_result = await client(ExportChatInviteRequest(int(channel_id)))
    invite_link = invite_link_result.link
    print(f"[{user_id}] Created invite link: {invite_link}")
    
    await client.send_message(bot_username, '/start'); print(f"[{user_id}] Worker has started a chat with @{bot_username}.")
    return bot_token, bot_username, channel_id, invite_link

# In main.py, replace this entire function

async def _transfer_ownership(worker_client, bot_username, channel_id, target_user_id, target_user_username):
    results = {"bot_transfer_status": "pending", "bot_transfer_message": "", "channel_transfer_status": "pending", "channel_transfer_message": ""}
    
    # --- BOT TRANSFER (THE FINAL, PATIENT ALGORITHM) ---
    try:
        print(f"Starting bot transfer for @{bot_username} to @{target_user_username}...")
        
        async with worker_client.conversation('BotFather', timeout=120) as conv:
            # Helper function to find and click a button that contains specific text
            async def click_button_containing_text(response, text, password=None):
                for row in response.buttons:
                    for button in row:
                        if text in button.text:
                            await button.click(password=password)
                            return True
                return False

            # Step 1: Send /mybots and get the bot list
            await conv.send_message('/mybots')
            resp_bot_list = await conv.get_response()

            # Step 2: Find and click the correct bot in the list
            print("Finding bot in list...")
            if not await click_button_containing_text(resp_bot_list, bot_username):
                raise Exception(f"Could not find button for bot @{bot_username}")
            
            # --- THIS IS THE FIX, EXACTLY AS YOU DESIGNED IT ---
            # Step 3: BE PATIENT, then get the EDITED message and click "Transfer Ownership"
            print("Waiting for bot menu...")
            await asyncio.sleep(2) # A patient wait for the message to be edited
            resp_bot_menu = (await worker_client.get_messages('BotFather', limit=1))[0]
            print("Clicking 'Transfer Ownership'...")
            if not await click_button_containing_text(resp_bot_menu, "Transfer Ownership"):
                raise Exception("Could not find 'Transfer Ownership' button.")

            # Step 4: BE PATIENT, then get the EDITED message and click "Choose recipient"
            print("Waiting for transfer menu...")
            await asyncio.sleep(2) # Another patient wait
            resp_recipient_menu = (await worker_client.get_messages('BotFather', limit=1))[0]
            print("Clicking 'Choose recipient'...")
            if not await click_button_containing_text(resp_recipient_menu, "Choose recipient"):
                raise Exception("Could not find 'Choose recipient' button.")

            # Step 5: Wait for the NEW message prompt, then send the username
            print(f"Waiting for prompt and sharing new owner's username: @{target_user_username}")
            await conv.get_response() # This is a NEW message, so get_response() is correct
            await conv.send_message(f"@{target_user_username}")

            # Step 6: Wait for the NEW confirmation message and prepare for 2FA
            print("Waiting for confirmation...")
            resp_final_confirm = await conv.get_response()
            
            print("Preparing secure password for final confirmation click...")
            password_info = await worker_client(GetPasswordRequest())
            srp_check_for_button = await get_srp_password_check(password=TELETHON_2FA_PASSWORD, srp=password_info)
            
            print("Clicking final confirmation button with 2FA...")
            if not await click_button_containing_text(resp_final_confirm, "Yes, I am sure, proceed.", password=srp_check_for_button):
                raise Exception("Could not find final confirmation button.")
            
            # Step 7: Get the final success message
            print("Waiting for final success message...")
            resp_success = await conv.get_response()
            if "Success" not in resp_success.text:
                raise Exception("BotFather did not confirm final transfer after password.")

        results["bot_transfer_status"] = "success"; results["bot_transfer_message"] = "Bot ownership successfully transferred."
        print(f"✅ Bot ownership transferred to {target_user_id}")

    except Exception as e:
        print(f"❌ Bot transfer FAILED. Error: {e}"); traceback.print_exc()
        results["bot_transfer_status"] = "failed"; results["bot_transfer_message"] = f"Bot transfer failed: {e}"

    # --- CHANNEL TRANSFER (THIS PART IS ALREADY CORRECT) ---
    try:
        print(f"Starting channel ownership transfer for {channel_id}...")
        password_info = await worker_client(GetPasswordRequest())
        srp_check_for_channel = await get_srp_password_check(password=TELETHON_2FA_PASSWORD, srp=password_info)
        await worker_client(EditCreatorRequest(channel=int(channel_id), user_id=target_user_id, password=srp_check_for_channel))
        results["channel_transfer_status"] = "success"; results["channel_transfer_message"] = "Channel ownership successfully transferred."
        print(f"✅ Channel ownership transferred to {target_user_id}")
    except UserNotParticipantError:
        print(f"⚠️ Channel transfer FAILED due to privacy settings."); results["channel_transfer_status"] = "failed"; results["channel_transfer_message"] = "Channel transfer failed due to your privacy settings. You can retry later."
    except Exception as e:
        print(f"❌ Channel transfer FAILED. Error: {e}"); traceback.print_exc(); results["channel_transfer_status"] = "failed"; results["channel_transfer_message"] = f"Channel transfer failed: {e}"
        
    return results
    # --- CHANNEL TRANSFER (THIS PART IS ALREADY CORRECT) ---
    try:
        print(f"Starting channel ownership transfer for {channel_id}...")
        password_info = await worker_client(GetPasswordRequest())
        srp_check = await get_srp_password_check(password=TELETHON_2FA_PASSWORD, srp=password_info)
        await worker_client(EditCreatorRequest(channel=int(channel_id), user_id=target_user_id, password=srp_check))
        results["channel_transfer_status"] = "success"; results["channel_transfer_message"] = "Channel ownership successfully transferred."
        print(f"✅ Channel ownership transferred to {target_user_id}")
    except UserNotParticipantError:
        print(f"⚠️ Channel transfer FAILED due to privacy settings."); results["channel_transfer_status"] = "failed"; results["channel_transfer_message"] = "Channel transfer failed due to your privacy settings. You can retry later."
    except Exception as e:
        print(f"❌ Channel transfer FAILED. Error: {e}"); traceback.print_exc(); results["channel_transfer_status"] = "failed"; results["channel_transfer_message"] = f"Channel transfer failed: {e}"
        
    return results

# --- API Endpoints ---
@app.route('/')
def index(): return "DaemonClient is alive!"

# In main.py, replace the entire start_setup_endpoint function

@app.route('/startSetup', methods=['POST'])
def start_setup_endpoint():
    data = request.get_json().get('data', {}); user_id, user_email = data.get('uid'), data.get('email')
    if not user_id or not user_email: return jsonify({"error": "Missing uid or email in request body."}), 400
    print(f"Received setup request for user: {user_id}")

    available_bots = get_available_bots()
    if not available_bots:
        print("FATAL: No active userbots found in Firestore.")
        return jsonify({"error": {"message": "No available worker bots to process the request."}}), 500

    # This is the correct structure. All async logic is inside this one function.
    async def run_setup_flow():
        for bot_creds in available_bots:
            bot_doc_id = bot_creds['doc_id']
            # We create a new client inside the loop for each attempt
            client = TelegramClient(StringSession(bot_creds['session_string']), bot_creds['api_id'], bot_creds['api_hash'])
            try:
                print(f"Attempting setup with bot: {bot_doc_id}")
                
                # Connect the client first
                await client.start(password=lambda: TELETHON_2FA_PASSWORD)

                # Now, call the resource creation function. No more asyncio.run() here.
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
                db.collection('userbots').document(bot_doc_id).update({'last_used': firestore.SERVER_TIMESTAMP, 'status': 'healthy'})
                print(f"✅ Successfully configured user: {user_id} using bot {bot_doc_id}")
                
                return jsonify({"status": "success"}) # Return success and exit the function

            except UserDeactivatedBanError as e:
                print(f"⛔️ Bot {bot_doc_id} is BANNED. Deactivating. Error: {e}")
                db.collection('userbots').document(bot_doc_id).update({'is_active': False, 'status': 'banned'})
                continue # Move to the next bot

            except Exception as e:
                print(f"⚠️ Bot {bot_doc_id} failed. Trying next bot. Error: {e}")
                db.collection('userbots').document(bot_doc_id).update({'status': f'error: {str(e)[:200]}', 'error_count': firestore.Increment(1)})
                traceback.print_exc()
                continue
            finally:
                if client.is_connected():
                    await client.disconnect()

        # This is only reached if the loop finishes without a success
        print(f"CRITICAL: All {len(available_bots)} userbots failed for user {user_id}.")
        return jsonify({"error": {"message": "All available worker bots failed. Please check bot health in Firestore."}}), 500

    # We call asyncio.run() only ONCE, at the very end of the function.
    return asyncio.run(run_setup_flow())

# In main.py, replace this entire endpoint function

# In main.py, replace this entire endpoint function

# In main.py, replace this entire endpoint function

# In main.py, replace this entire endpoint function

@app.route('/finalizeTransfer', methods=['POST'])
def finalize_transfer_endpoint():
    data = request.get_json().get('data', {}); user_id = data.get('uid')
    if not user_id: return jsonify({"error": {"message": "Missing uid."}}), 400
    async def run_finalization():
        config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        config_doc = config_ref.get();
        if not config_doc.exists: return jsonify({"error": {"message": "Configuration not found."}}), 404
        config_data = config_doc.to_dict(); bot_username = config_data.get("botUsername"); channel_id = config_data.get("channelId"); worker_bot_id = config_data.get("createdBy")
        worker_bot_ref = db.collection('userbots').document(worker_bot_id).get()
        if not worker_bot_ref.exists: return jsonify({"error": {"message": "Worker bot not found."}}), 500
        bot_creds = worker_bot_ref.to_dict()
        worker_client = TelegramClient(StringSession(bot_creds['session_string']), bot_creds['api_id'], bot_creds['api_hash'])
        try:
            await worker_client.start(password=lambda: TELETHON_2FA_PASSWORD)
            me = await worker_client.get_me()
            
            print(f"Looking for new user in channel {channel_id}...")
            participants = await worker_client(GetParticipantsRequest(channel=int(channel_id), filter=ChannelParticipantsSearch(''), offset=0, limit=200, hash=0))
            target_user = next((p for p in participants.users if p.id != me.id and not p.bot), None)
            if not target_user: raise Exception("Could not find you in the channel. Please join the channel and try again.")
            
            if not target_user.username:
                raise Exception("To complete the transfer, you must set a public Telegram @username in your Telegram settings.")

            target_user_id = target_user.id
            target_user_username = target_user.username
            print(f"Found user {target_user_id} with username @{target_user_username}.")

            # --- THIS CALL IS NOW CORRECT ---
            transfer_results = await _transfer_ownership(worker_client, bot_username, channel_id, target_user_id, target_user_username)
            
            update_data = {'ownership_transferred': True, 'finalization_status': transfer_results}; config_ref.update(update_data)
            db.collection('userbots').document(worker_bot_id).update({'last_used': firestore.SERVER_TIMESTAMP})
            print(f"✅ Finalization complete for {user_id}.")
            return jsonify(transfer_results)
        except Exception as e:
            print(f"❌❌ Finalization FAILED for {user_id}. Error: {e}"); traceback.print_exc(); return jsonify({"error": {"message": f"{e}"}}), 500
        finally:
            if worker_client.is_connected(): await worker_client.disconnect()
    return asyncio.run(run_finalization())

if __name__ == "__main__":
    print("Starting local development server...")
    app.run(host='0.0.0.0', port=8080, debug=True, use_reloader=False)