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
from google.cloud.firestore_v1.base_query import FieldFilter # <-- IMPORT ADDED HERE

# Import Telethon libraries
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.channels import CreateChannelRequest, EditAdminRequest
from telethon.tl.types import ChatAdminRights
from telethon.errors.rpcerrorlist import UserDeactivatedBanError, FloodWaitError

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
    print("✅ Firebase initialized successfully from environment variable.")
except Exception as e:
    print(f"FATAL: Could not initialize Firebase. Check FIREBASE_CREDENTIALS_JSON. Error: {e}")

# --- Bot Pool Management ---
def get_available_bots():
    """
    Fetches all active userbots from the Firestore 'userbots' collection,
    ordered by the last time they were used to distribute the load.
    """
    print("Fetching available userbots from Firestore...")
    try:
        # --- THIS IS THE FIX ---
        bots_ref = db.collection('userbots').where(filter=FieldFilter('is_active', '==', True)).order_by('last_used', direction=firestore.Query.ASCENDING).stream()
        
        bots_list = []
        for bot in bots_ref:
            bot_data = bot.to_dict()
            bot_data['doc_id'] = bot.id
            bots_list.append(bot_data)
        
        print(f"Found {len(bots_list)} active bots.")
        return bots_list
    except Exception as e:
        print(f"Error fetching bots from Firestore: {e}")
        return []

# ---Core Telethon Logic (remains unchanged) ---
async def _create_resources_with_userbot(api_id, api_hash, session_string,
                                         user_id, user_email):
    # This function is the same as before
    print(f"[{user_id}] Starting Telethon client...")

    async with TelegramClient(StringSession(session_string), api_id,
                              api_hash) as client:
        print(
            f"[{user_id}] Telethon client connected. Starting BotFather conversation..."
        )
        # 1. Create the Bot via BotFather
        async with client.conversation('BotFather', timeout=90) as conv:
            await conv.send_message('/newbot')
            response = await conv.get_response()
            if "Alright, a new bot" not in response.text:
                raise Exception(
                    "BotFather did not respond as expected to /newbot.")

            bot_name = f"{user_email.split('@')[0]}'s DaemonClient"
            await conv.send_message(bot_name)
            response = await conv.get_response()
            if "Good. Now let's choose a username" not in response.text:
                raise Exception(f"BotFather did not ask for a username.")

            bot_username = ""
            for i in range(5):
                bot_username = f"dc_{user_id[:7]}_{os.urandom(4).hex()}_bot"
                await conv.send_message(bot_username)
                response = await conv.get_response()
                if "Done! Congratulations" in response.text:
                    break
                if "username is already taken" in response.text and i < 4:
                    continue
                raise Exception(f"Failed to create bot username.")

            # Regular Expression to find the token
            token_match = re.search(r'(\d+:[A-Za-z0-9\-_]+)', response.text)
            if not token_match:
                raise Exception(
                    "Could not find the bot token in BotFather's response.")

            bot_token = token_match.group(1)
            print(f"[{user_id}] Bot created successfully: {bot_username}")

        # 2. Create the Private Channel
        print(f"[{user_id}] Creating private channel...")
        channel_title = f"DaemonClient Storage - {user_id[:6]}"
        result = await client(
            CreateChannelRequest(title=channel_title,
                                 about="Private storage for DaemonClient.",
                                 megagroup=True))
        new_channel = result.chats[0]
        channel_id = f"-100{new_channel.id}"
        print(f"[{user_id}] Channel created successfully: {channel_id}")

        # 3. Add the New Bot as an Admin to the Channel
        print(f"[{user_id}] Adding bot as admin to channel...")
        await client(
            EditAdminRequest(channel=new_channel.id,
                             user_id=bot_username,
                             admin_rights=ChatAdminRights(
                                 post_messages=True,
                                 edit_messages=True,
                                 delete_messages=True),
                             rank='bot'))
        print(f"[{user_id}] Bot added as admin successfully.")

    return bot_token, channel_id


@app.route('/')
def index():
    """A simple route to let the keep-alive service know the app is running."""
    return "DaemonClient is alive!"


# --- API Endpoint (UPDATED)---
@app.route('/startSetup', methods=['POST'])
def start_setup_endpoint():
    """
    This API endpoint now uses a pool of bots from Firestore to perform its task.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid request. Expecting JSON body."}), 400

    user_id = data.get('data', {}).get('uid')
    user_email = data.get('data', {}).get('email')

    if not user_id or not user_email:
        return jsonify({"error": "Missing uid or email in request body."}), 400

    print(f"Received setup request for user: {user_id}")

    # 1. Fetch the pool of available bots from Firestore
    available_bots = get_available_bots()
    if not available_bots:
        print("FATAL: No active userbots found in Firestore.")
        return jsonify({"error": {"message": "No available worker bots to process the request."}}), 500

    # 2. Loop through the bots until one succeeds
    setup_successful = False
    for bot_creds in available_bots:
        bot_doc_id = bot_creds['doc_id']
        api_id = bot_creds['api_id']
        try:
            print(f"Attempting setup with bot: {bot_doc_id} (API ID: {api_id})")

            # Execute the main logic with the current bot's credentials
            bot_token, channel_id = asyncio.run(
                _create_resources_with_userbot(api_id, bot_creds['api_hash'], bot_creds['session_string'],
                                               user_id, user_email))

            # --- On Success ---
            # Save the created resources to the user's config
            user_config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
            user_config_ref.set({
                "botToken": bot_token,
                "channelId": channel_id,
                "setupTimestamp": firestore.SERVER_TIMESTAMP,
                "createdBy": f"telethon-pool-bot-{api_id}",
            })
            
            # Update the bot's 'last_used' timestamp so it goes to the back of the queue
            db.collection('userbots').document(bot_doc_id).update({
                'last_used': firestore.SERVER_TIMESTAMP,
                'status': 'healthy'
            })

            print(f"✅ Successfully configured user: {user_id} using bot {api_id}")
            setup_successful = True
            break  # Exit the loop on success

        except UserDeactivatedBanError as e:
            # --- On Bot Suspension ---
            print(f"⛔️ Bot {bot_doc_id} is BANNED. Deactivating it. Error: {e}")
            db.collection('userbots').document(bot_doc_id).update({
                'is_active': False,
                'status': 'suspended_banned',
                'error_count': firestore.Increment(1)
            })
            continue # Move to the next bot

        except Exception as e:
            # --- On Other Errors ---
            print(f"⚠️ Bot {bot_doc_id} failed. Trying next bot. Error: {e}")
            db.collection('userbots').document(bot_doc_id).update({
                'status': f'error: {str(e)[:200]}', # Store a snippet of the error
                'error_count': firestore.Increment(1)
            })
            print(traceback.format_exc())
            continue # Move to the next bot
    
    # 3. Final response after the loop
    if setup_successful:
        return jsonify({"data": {"status": "success"}})
    else:
        # This part is reached only if all bots in the pool failed
        print(f"CRITICAL: All {len(available_bots)} userbots failed for user {user_id}.")
        return jsonify({"error": {"message": "All available worker bots failed. Please check bot health in Firestore."}}), 500


if __name__ == "__main__":
    print("Starting local development server...")
    app.run(host='0.0.0.0', port=8080, debug=False) # Note: debug=False is recommended for production/stable setups