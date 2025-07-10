import os
import asyncio
import traceback
from flask import Flask, request, jsonify
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore
from dotenv import load_dotenv

# Import Telethon libraries
from telethon.sync import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.functions.channels import CreateChannelRequest, EditAdminRequest
from telethon.tl.types import ChatAdminRights

# --- Load Environment Variables ---
load_dotenv() 

# --- Initialize Flask App ---
app = Flask(__name__)
CORS(app)

# --- Initialize Firebase Admin SDK ---
try:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    key_path = os.path.join(base_dir, "serviceAccountKey.json")
    
    cred = credentials.Certificate(key_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase initialized successfully.")
except Exception as e:
    print(f"FATAL: Could not initialize Firebase. Make sure 'serviceAccountKey.json' is present. Error: {e}")


# --- Your Core Telethon Logic ---
# ... (all the code at the top of the file remains the same) ...
# Make sure to add this import at the top of your main.py file
import re

# --- Your Core Telethon Logic ---
async def _create_resources_with_userbot(api_id, api_hash, session_string, user_id, user_email):
    """This is your original logic to create a bot and channel."""
    print(f"[{user_id}] Starting Telethon client...")
    
    async with TelegramClient(StringSession(session_string), api_id, api_hash) as client:
        print(f"[{user_id}] Telethon client connected. Starting BotFather conversation...")
        # 1. Create the Bot via BotFather
        async with client.conversation('BotFather', timeout=90) as conv:
            await conv.send_message('/newbot')
            response = await conv.get_response()
            if "Alright, a new bot" not in response.text:
                raise Exception("BotFather did not respond as expected to /newbot.")

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

            # ✅ FIX: Use a reliable Regular Expression to find the token
            token_match = re.search(r'(\d+:[A-Za-z0-9\-_]+)', response.text)
            if not token_match:
                raise Exception("Could not find the bot token in BotFather's response.")
            
            bot_token = token_match.group(1)
            print(f"[{user_id}] Bot created successfully: {bot_username}")

        # 2. Create the Private Channel
        print(f"[{user_id}] Creating private channel...")
        channel_title = f"DaemonClient Storage - {user_id[:6]}"
        result = await client(CreateChannelRequest(title=channel_title, about="Private storage for DaemonClient.", megagroup=True))
        new_channel = result.chats[0]
        channel_id = f"-100{new_channel.id}"
        print(f"[{user_id}] Channel created successfully: {channel_id}")

        # 3. Add the New Bot as an Admin to the Channel
        print(f"[{user_id}] Adding bot as admin to channel...")
        await client(EditAdminRequest(
            channel=new_channel.id,
            user_id=bot_username,
            admin_rights=ChatAdminRights(post_messages=True, edit_messages=True, delete_messages=True),
            rank='bot'
        ))
        print(f"[{user_id}] Bot added as admin successfully.")
    
    return bot_token, channel_id

# ... (the rest of your main.py file remains exactly the same) ...



# --- API Endpoint ---
@app.route('/startSetup', methods=['POST'])
def start_setup_endpoint():
    """This is the API endpoint your website will call."""
    try:
        API_ID = int(os.environ['TELEGRAM_API_ID'])
        API_HASH = os.environ['TELEGRAM_API_HASH']
        SESSION_STRING = os.environ['TELEGRAM_SESSION']

        data = request.get_json()
        if not data:
            return jsonify({"error": "Invalid request. Expecting JSON body."}), 400
            
        user_id = data.get('data', {}).get('uid')
        user_email = data.get('data', {}).get('email')

        if not user_id or not user_email:
            return jsonify({"error": "Missing uid or email in request body."}), 400

        print(f"Received setup request for user: {user_id}")
        
        bot_token, channel_id = asyncio.run(
            _create_resources_with_userbot(API_ID, API_HASH, SESSION_STRING, user_id, user_email)
        )

        user_config_ref = db.collection(f"artifacts/default-daemon-client/users/{user_id}/config").document("telegram")
        user_config_ref.set({
            "botToken": bot_token,
            "channelId": channel_id,
            "setupTimestamp": firestore.SERVER_TIMESTAMP,
            "createdBy": "local-telethon-v1",
        })

        print(f"Successfully configured user: {user_id}")
        return jsonify({"data": {"status": "success"}})

    except KeyError as e:
        error_msg = f"Missing variable in .env file: {e}. Please check your .env file."
        print(f"ERROR: {error_msg}")
        return jsonify({"error": {"message": error_msg}}), 500
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": {"message": f"An internal error occurred: {e}"}}), 500
    
if __name__ == "__main__":
    print("Starting local development server...")
    app.run(host='0.0.0.0', port=8080, debug=True)
