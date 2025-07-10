import asyncio
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

# ❗️ IMPORTANT: Put your REAL api_id and api_hash here
API_ID = 27523196
API_HASH = 'cbbcf2d8e08296c1e24bf3ab53b89787'

async def main():
    # This creates the session directly in memory as a string
    async with TelegramClient(StringSession(), API_ID, API_HASH) as client:
        print("\n✅ Login successful!")
        print("Here is your session string. Copy the entire line below:")
        # This will now correctly print the string we need
        print(client.session.save())

if __name__ == "__main__":
    # You can delete the old 'my_session_name.session' file now
    print("Attempting to generate a session string...")
    print("Please enter your phone number, login code, and 2FA password if prompted.")
    asyncio.run(main())