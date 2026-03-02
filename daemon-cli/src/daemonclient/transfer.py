# daemonclient/transfer.py
"""Upload and download logic — chunking, encryption, Telegram transport."""

import math
import os
import time

import requests
import typer
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeRemainingColumn

from .auth import get_auth_headers
from .config import CHUNK_SIZE, MAX_RETRIES, get_api_url
from .crypto import encrypt_chunk, decrypt_chunk

console = Console()


# ── helpers ──────────────────────────────────────────────────────────

def _get_tg_config() -> dict:
    """Fetch bot_token + channel_id from the backend."""
    res = requests.get(f"{get_api_url()}/config", headers=get_auth_headers(), timeout=15)
    if res.status_code != 200:
        console.print(f"[red]Failed to get config:[/red] {res.text}")
        raise typer.Exit(1)
    return res.json()


def _get_zke_config() -> dict | None:
    """Fetch ZKE config (password, salt, enabled) from the backend.
    
    Returns None if ZKE is disabled or the endpoint doesn't exist yet.
    """
    try:
        res = requests.get(f"{get_api_url()}/zke-config", headers=get_auth_headers(), timeout=15)
        if res.status_code == 200:
            return res.json()
    except Exception:
        pass
    return None


def _derive_key_from_config(zke_cfg: dict):
    """Derive AES key from the ZKE config fetched from the server."""
    from .crypto import derive_key, base64_to_bytes
    salt = base64_to_bytes(zke_cfg["salt"])
    return derive_key(zke_cfg["password"], salt)


def _send_chunk_to_telegram(
    chunk_data: bytes,
    part_name: str,
    bot_token: str,
    channel_id: str,
) -> dict:
    """Upload a single chunk to Telegram with retry logic.
    
    Returns {"message_id": ..., "file_id": ...}.
    """
    for attempt in range(MAX_RETRIES):
        try:
            files = {"document": (part_name, chunk_data)}
            data = {"chat_id": channel_id}

            res = requests.post(
                f"https://api.telegram.org/bot{bot_token}/sendDocument",
                data=data,
                files=files,
                timeout=300,
            )

            if res.status_code == 429:
                retry_after = res.json().get("parameters", {}).get("retry_after", 5)
                time.sleep(retry_after + 1)
                continue

            if res.status_code != 200:
                raise Exception(f"Telegram Error {res.status_code}: {res.text}")

            result = res.json()["result"]
            return {
                "message_id": result["message_id"],
                "file_id": result["document"]["file_id"],
            }

        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            time.sleep(2 ** attempt)  # exponential backoff

    raise Exception("Max retries exhausted")


# ── public API ───────────────────────────────────────────────────────

def upload_file(
    file_path: str,
    folder_id: str = "root",
    no_encrypt: bool = False,
) -> None:
    """Upload a local file to DaemonClient storage."""
    if not os.path.exists(file_path):
        console.print(f"[red]File not found:[/red] {file_path}")
        raise typer.Exit(1)

    file_name = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    total_parts = math.ceil(file_size / CHUNK_SIZE)

    # Fetch Telegram credentials
    tg = _get_tg_config()
    bot_token = tg["bot_token"]
    channel_id = tg["channel_id"]

    # Fetch ZKE key (if enabled)
    zke_key = None
    if not no_encrypt:
        zke_cfg = _get_zke_config()
        if zke_cfg and zke_cfg.get("enabled"):
            zke_key = _derive_key_from_config(zke_cfg)
            console.print("[dim]🔐 ZKE encryption enabled[/dim]")

    console.print(
        f"🚀 Uploading [bold cyan]{file_name}[/bold cyan] "
        f"({file_size / 1024 / 1024:.2f} MB, {total_parts} chunk{'s' if total_parts != 1 else ''})"
    )

    uploaded_messages = []

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Uploading", total=total_parts)

        for i in range(total_parts):
            start = i * CHUNK_SIZE
            with open(file_path, "rb") as f:
                f.seek(start)
                chunk = f.read(CHUNK_SIZE)

            # Encrypt if ZKE is active
            if zke_key:
                chunk = encrypt_chunk(chunk, zke_key)

            part_name = f"{file_name}.part{i + 1:03d}"
            msg = _send_chunk_to_telegram(chunk, part_name, bot_token, channel_id)
            uploaded_messages.append({"index": i, **msg})
            progress.update(task, advance=1)

    # Register in Firestore
    register_payload = {
        "fileName": file_name,
        "fileSize": file_size,
        "fileType": "application/octet-stream",
        "parentId": folder_id,
        "type": "file",
        "messages": [
            {"message_id": m["message_id"], "file_id": m["file_id"]}
            for m in sorted(uploaded_messages, key=lambda x: x["index"])
        ],
    }

    try:
        res = requests.post(
            f"{get_api_url()}/register",
            headers=get_auth_headers(),
            json=register_payload,
            timeout=15,
        )
        if res.status_code == 200:
            console.print(f"[green]✨ Upload complete! '{file_name}' registered.[/green]")
        else:
            console.print(f"[red]Upload worked but registration failed:[/red] {res.text}")
    except Exception as e:
        console.print(f"[red]Registration error:[/red] {e}")


def download_file(file_id: str, output_path: str | None = None) -> None:
    """Download a file from DaemonClient storage."""
    tg = _get_tg_config()
    bot_token = tg["bot_token"]

    # Fetch ZKE key
    zke_key = None
    zke_cfg = _get_zke_config()
    if zke_cfg and zke_cfg.get("enabled"):
        zke_key = _derive_key_from_config(zke_cfg)

    # Find the file in the list
    console.print(f"[dim]Fetching metadata for {file_id}...[/dim]")
    list_res = requests.get(f"{get_api_url()}/list", headers=get_auth_headers(), timeout=15)
    if list_res.status_code != 200:
        console.print(f"[red]Failed to list files:[/red] {list_res.text}")
        raise typer.Exit(1)

    files = list_res.json().get("files", [])
    target = next((f for f in files if f["id"] == file_id), None)
    if not target:
        console.print(f"[red]File ID '{file_id}' not found.[/red]")
        raise typer.Exit(1)

    file_name = target["fileName"]
    final_path = output_path or file_name
    messages = target.get("messages", [])

    console.print(
        f"⬇️  Downloading [cyan]{file_name}[/cyan] "
        f"({len(messages)} chunk{'s' if len(messages) != 1 else ''})"
    )

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Downloading", total=len(messages))

        with open(final_path, "wb") as f_out:
            for msg in messages:
                # Get Telegram file path
                info_res = requests.get(
                    f"https://api.telegram.org/bot{bot_token}/getFile",
                    params={"file_id": msg["file_id"]},
                    timeout=30,
                )
                if info_res.status_code != 200:
                    console.print(f"[red]Telegram error:[/red] {info_res.text}")
                    raise typer.Exit(1)

                tg_path = info_res.json()["result"]["file_path"]
                download_url = f"https://api.telegram.org/file/bot{bot_token}/{tg_path}"

                # Stream download
                chunk_res = requests.get(download_url, stream=True, timeout=300)
                chunk_data = b""
                for piece in chunk_res.iter_content(chunk_size=8192):
                    chunk_data += piece

                # Decrypt if ZKE is active
                if zke_key:
                    chunk_data = decrypt_chunk(chunk_data, zke_key)

                f_out.write(chunk_data)
                progress.update(task, advance=1)

    console.print(f"[green]✅ Downloaded: {final_path}[/green]")


def delete_file(file_id: str, skip_confirm: bool = False) -> None:
    """Delete a file from Telegram and Firestore."""
    tg = _get_tg_config()
    bot_token = tg["bot_token"]
    channel_id = tg["channel_id"]

    # Find the file
    list_res = requests.get(f"{get_api_url()}/list", headers=get_auth_headers(), timeout=15)
    files = list_res.json().get("files", [])
    target = next((f for f in files if f["id"] == file_id), None)

    if not target:
        console.print(f"[red]File ID '{file_id}' not found.[/red]")
        raise typer.Exit(1)

    file_name = target.get("fileName", "Unknown")

    if not skip_confirm:
        confirm = typer.confirm(f"Delete '{file_name}'?")
        if not confirm:
            console.print("[yellow]Cancelled.[/yellow]")
            raise typer.Abort()

    # Delete chunks from Telegram
    messages = target.get("messages", [])
    console.print(f"[yellow]Deleting {len(messages)} chunks...[/yellow]")

    with Progress(SpinnerColumn(), TextColumn("{task.description}"), BarColumn(), console=console) as progress:
        task = progress.add_task("Cleaning up", total=len(messages))
        for msg in messages:
            try:
                requests.post(
                    f"https://api.telegram.org/bot{bot_token}/deleteMessage",
                    json={"chat_id": channel_id, "message_id": msg["message_id"]},
                    timeout=15,
                )
            except Exception:
                pass  # best-effort
            progress.update(task, advance=1)

    # Delete from Firestore
    try:
        res = requests.post(
            f"{get_api_url()}/delete",
            headers=get_auth_headers(),
            json={"file_id": file_id},
            timeout=15,
        )
        if res.status_code == 200:
            console.print(f"[green]🗑️  '{file_name}' deleted.[/green]")
        else:
            console.print(f"[red]Registry delete failed:[/red] {res.text}")
    except Exception as e:
        console.print(f"[red]API error:[/red] {e}")
