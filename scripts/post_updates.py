#!/usr/bin/env python3
"""
DaemonClient Telegram Update Bot
Posts the latest commit update to a Telegram channel.
Triggered by the pre-push git hook.
"""

import subprocess
import requests
import os
from pathlib import Path

# Load .env from project root
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip())

BOT_TOKEN = os.getenv("UPDATES_BOT_TOKEN")
CHANNEL_ID = os.getenv("UPDATES_CHANNEL_ID")
GITHUB_REPO = os.getenv("GITHUB_REPO")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"


def main():
    if not BOT_TOKEN or not CHANNEL_ID:
        print("⚠️  Missing UPDATES_BOT_TOKEN or UPDATES_CHANNEL_ID in .env")
        return

    # Get the latest commit
    root = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True
    ).stdout.strip()

    result = subprocess.run(
        ["git", "log", "-1", "--pretty=format:%H|%h|%ad|%s", "--date=format:%B %d, %Y"],
        capture_output=True, text=True, cwd=root
    )

    if result.returncode != 0 or not result.stdout.strip():
        print("No commits found.")
        return

    parts = result.stdout.strip().split("|", 3)
    if len(parts) != 4:
        return

    full_hash, short_hash, date, message = parts

    # Format message
    text = (
        f"<b>DaemonClient Updates</b>\n"
        f"<b>Date:</b> {date}\n\n"
        f"<blockquote>- {message}</blockquote>\n\n"
        f'🔗 Commit: <a href="{GITHUB_REPO}/commit/{full_hash}">{short_hash}</a>'
    )

    # Send to Telegram
    response = requests.post(
        f"{TELEGRAM_API}/sendMessage",
        json={
            "chat_id": CHANNEL_ID,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True
        }
    )

    if response.status_code == 200:
        print(f"✅ Telegram update sent for {short_hash}")
    else:
        print(f"❌ Failed: {response.status_code} — {response.text}")


if __name__ == "__main__":
    main()
