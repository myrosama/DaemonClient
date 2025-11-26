# daemon-cli/daemon.py

import typer
import requests
import json
import os
from rich.console import Console
from rich.table import Table
import math
from concurrent.futures import ThreadPoolExecutor, as_completed

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

# ... (Previous code remains the same) ...

# --- CONSTANTS ---
CHUNK_SIZE = 19 * 1024 * 1024  # 19MB (Matches web app)
MAX_RETRIES = 5

@app.command()
def upload(file_path: str):
    """Upload a local file to the cloud (Zero-Cost Direct Transfer)."""
    if not os.path.exists(file_path):
        console.print(f"[red]File not found:[/red] {file_path}")
        raise typer.Exit(code=1)

    # 1. Get Config (Bot Token & Channel ID)
    token = get_auth_token()
    headers = {"Authorization": f"Bearer {token}"}
    
    try:
        # Fetch credentials from your API, NOT the file content
        config_res = requests.get(f"{API_URL}/config", headers=headers)
        if config_res.status_code != 200:
            console.print(f"[red]Failed to get upload config:[/red] {config_res.text}")
            raise typer.Exit(code=1)
            
        config = config_res.json()
        bot_token = config['bot_token']
        channel_id = config['channel_id']
        
    except Exception as e:
        console.print(f"[red]Connection Error:[/red] {e}")
        raise typer.Exit(code=1)

    # 2. Prepare File
    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    total_parts = math.ceil(file_size / CHUNK_SIZE)
    
    console.print(f"🚀 Uploading [bold cyan]{file_name}[/bold cyan] ({file_size/1024/1024:.2f} MB)")
    console.print(f"📦 Chunks: {total_parts} | Target Channel: {channel_id}")

    # 3. Upload Chunks Directly to Telegram
    uploaded_messages = []
    
    # We define a helper function for uploading a single chunk
    def upload_chunk(part_index):
        start = part_index * CHUNK_SIZE
        
        # Retry logic
        for attempt in range(MAX_RETRIES):
            try:
                with open(file_path, "rb") as f:
                    f.seek(start)
                    chunk_data = f.read(CHUNK_SIZE)
                
                files = {
                    'document': (f"{file_name}.part{part_index+1:03d}", chunk_data)
                }
                data = {'chat_id': channel_id}
                
                # DIRECT TO TELEGRAM (Bypasses your backend!)
                res = requests.post(
                    f"https://api.telegram.org/bot{bot_token}/sendDocument",
                    data=data,
                    files=files,
                    timeout=300
                )
                
                if res.status_code == 429:
                    # Rate limit handling
                    retry_after = res.json()['parameters']['retry_after']
                    time.sleep(retry_after + 1)
                    continue
                    
                if res.status_code != 200:
                    raise Exception(f"Telegram Error: {res.text}")
                    
                result = res.json()
                return {
                    "index": part_index,
                    "message_id": result['result']['message_id'],
                    "file_id": result['result']['document']['file_id']
                }

            except Exception as e:
                if attempt == MAX_RETRIES - 1:
                    raise e
                time.sleep(2)

    # Execute uploads (Sequential for now to be safe, can be threaded later)
    # Using a simple loop to ensure order and handle errors gracefully
    with typer.progressbar(length=total_parts, label="Uploading") as progress:
        for i in range(total_parts):
            try:
                msg_data = upload_chunk(i)
                uploaded_messages.append(msg_data)
                progress.update(1)
            except Exception as e:
                console.print(f"\n[red]Failed to upload part {i+1}:[/red] {e}")
                raise typer.Exit(code=1)

    # 4. Register File in Firestore
    # Now we tell your backend: "Hey, I'm done. Here is the metadata."
    register_payload = {
        "fileName": file_name,
        "fileSize": file_size,
        "fileType": "application/octet-stream", # Simplified for CLI
        "parentId": "root", # Default to root for now
        "type": "file",
        "messages": [ 
            {"message_id": m["message_id"], "file_id": m["file_id"]} 
            for m in sorted(uploaded_messages, key=lambda x: x['index']) 
        ]
    }
    
    try:
        # We need a new endpoint for this! Let's call it /api/register
        # For now, we can't finish this step until we update the backend.
        # console.print(f"[yellow]Upload complete! (Metadata registration pending)[/yellow]")
        
        # Let's assume we added this endpoint
        reg_res = requests.post(f"{API_URL}/register", headers=headers, json=register_payload)
        if reg_res.status_code == 200:
            console.print(f"[green]✨ Upload Successful! File registered.[/green]")
        else:
             console.print(f"[red]Upload worked, but registration failed:[/red] {reg_res.text}")

    except Exception as e:
        console.print(f"[red]Registration Error:[/red] {e}")

if __name__ == "__main__":
    app()