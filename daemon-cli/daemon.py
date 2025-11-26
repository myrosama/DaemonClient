# daemon-cli/daemon.py

import typer
import requests
import json
import os
from rich.console import Console
from rich.table import Table

# Remove the 'import pyrebase' line!

app = typer.Typer()
console = Console()

# --- CONFIGURATION ---
# We only need the API Key for the REST API
API_KEY = "AIzaSyBH5diC5M7MnOIuOWaNPmOB1AV6uJVZyS8"  # From your firebaseConfig
AUTH_URL = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}"

# Your Flask Server URL
API_URL = "http://127.0.0.1:8080/api"
TOKEN_FILE = os.path.expanduser("~/.daemonclient_token")

def get_auth_token():
    """Reads the saved token from the local file."""
    if not os.path.exists(TOKEN_FILE):
        console.print("[red]Not logged in. Run 'daemon login' first.[/red]")
        raise typer.Exit(code=1)
    with open(TOKEN_FILE, "r") as f:
        data = json.load(f)
        return data['idToken']

@app.command()
def login(email: str = typer.Option(..., prompt=True), password: str = typer.Option(..., prompt=True, hide_input=True)):
    """Interactive login to save your session (Zero-Dependency Version)."""
    
    payload = {
        "email": email,
        "password": password,
        "returnSecureToken": True
    }
    
    try:
        response = requests.post(AUTH_URL, json=payload)
        data = response.json()
        
        if "error" in data:
            console.print(f"[red]Login failed:[/red] {data['error']['message']}")
            raise typer.Exit(code=1)
            
        # Save the token locally
        with open(TOKEN_FILE, "w") as f:
            json.dump(data, f)
            
        console.print(f"[green]Success! Logged in as {email}.[/green]")
        
    except Exception as e:
        console.print(f"[red]System Error:[/red] {e}")

# ... (Keep your list and upload commands the same)
@app.command()
def list(json_output: bool = typer.Option(False, "--json", help="Output raw JSON for scripting")):
    """List all files in your cloud."""
    token = get_auth_token()
    headers = {"Authorization": f"Bearer {token}"}
    
    try:
        response = requests.get(f"{API_URL}/list", headers=headers)
        if response.status_code != 200:
            console.print(f"[red]Error:[/red] {response.text}")
            raise typer.Exit(code=1)
            
        files = response.json().get('files', [])
        
        if json_output:
            # Scripting Mode: Print pure JSON
            print(json.dumps(files))
        else:
            # Human Mode: Print a pretty table
            table = Table(title="DaemonClient Files")
            table.add_column("ID", style="cyan", no_wrap=True)
            table.add_column("Name", style="magenta")
            table.add_column("Size", style="green")
            
            for f in files:
                size_mb = f"{int(f.get('fileSize', 0)) / 1024 / 1024:.2f} MB"
                table.add_row(f['id'], f.get('fileName', 'Unknown'), size_mb)
            
            console.print(table)

    except Exception as e:
        console.print(f"[red]Connection Error:[/red] {e}")

@app.command()
def upload(file_path: str):
    """Upload a file (Placeholder for Phase 2)."""
    console.print(f"[yellow]Upload not yet implemented for {file_path}[/yellow]")
    # 1. Get Config (Bot Token) from /api/config
    # 2. Chunk file
    # 3. Send to Telegram API directly
    # 4. Register file in Firestore via /api/register_upload

if __name__ == "__main__":
    app()