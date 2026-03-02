# daemonclient/auth.py
"""Authentication module — login, logout, token management."""

import json
import os

import requests
import typer
from rich.console import Console

from .config import AUTH_URL, TOKEN_FILE

console = Console()


def login(email: str, password: str) -> None:
    """Authenticate with Firebase REST API and save the token locally."""
    payload = {
        "email": email,
        "password": password,
        "returnSecureToken": True,
    }

    try:
        response = requests.post(AUTH_URL, json=payload, timeout=15)
        data = response.json()

        if "error" in data:
            console.print(f"[red]Login failed:[/red] {data['error']['message']}")
            raise typer.Exit(code=1)

        # Save the full token response
        with open(TOKEN_FILE, "w") as f:
            json.dump(data, f)

        console.print(f"[green]✅ Logged in as {email}[/green]")

    except requests.ConnectionError:
        console.print("[red]Connection error — is the internet available?[/red]")
        raise typer.Exit(code=1)


def logout() -> None:
    """Remove saved session."""
    if os.path.exists(TOKEN_FILE):
        os.remove(TOKEN_FILE)
        console.print("[green]Logged out.[/green]")
    else:
        console.print("[yellow]Not logged in.[/yellow]")


def whoami() -> None:
    """Print the current user's email."""
    token_data = _load_token_data()
    if token_data:
        console.print(f"[cyan]{token_data.get('email', 'Unknown')}[/cyan]")
    else:
        console.print("[yellow]Not logged in.[/yellow]")


def get_auth_token() -> str:
    """Read the saved ID token, or exit if not logged in."""
    token_data = _load_token_data()
    if not token_data:
        console.print("[red]Not logged in. Run 'daemon login' first.[/red]")
        raise typer.Exit(code=1)
    return token_data["idToken"]


def get_auth_headers() -> dict:
    """Convenience: returns {'Authorization': 'Bearer <token>'}."""
    return {"Authorization": f"Bearer {get_auth_token()}"}


def _load_token_data() -> dict | None:
    if not os.path.exists(TOKEN_FILE):
        return None
    with open(TOKEN_FILE, "r") as f:
        return json.load(f)
