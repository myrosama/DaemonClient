# daemonclient/config.py
"""Configuration management for DaemonClient CLI."""

import json
import os

# --- Paths ---
TOKEN_FILE = os.path.expanduser("~/.daemonclient_token")
CONFIG_FILE = os.path.expanduser("~/.daemonclient.json")

# --- Defaults ---
DEFAULT_API_URL = "https://daemonclient.onrender.com/api"
FIREBASE_API_KEY = "AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8"
AUTH_URL = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"

# --- Upload Constants ---
CHUNK_SIZE = 19 * 1024 * 1024  # 19 MB (matches web app)
MAX_RETRIES = 5


def get_api_url() -> str:
    """Returns the configured API URL, falling back to default."""
    cfg = _load_config()
    return cfg.get("api_url", DEFAULT_API_URL)


def set_api_url(url: str) -> None:
    """Persists a custom API URL."""
    cfg = _load_config()
    cfg["api_url"] = url.rstrip("/")
    _save_config(cfg)


def _load_config() -> dict:
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    return {}


def _save_config(cfg: dict) -> None:
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
