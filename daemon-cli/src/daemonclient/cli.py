# daemonclient/cli.py
"""Typer CLI application — the `daemon` command."""

import json

import typer
from rich.console import Console
from rich.table import Table

from . import __version__
from .auth import login as _login, logout as _logout, whoami as _whoami, get_auth_headers
from .config import get_api_url, set_api_url
from .transfer import upload_file, download_file, delete_file

app = typer.Typer(
    name="daemon",
    help="DaemonClient CLI — unlimited encrypted cloud storage from your terminal.",
    add_completion=False,
)
console = Console()

# ── Config sub-command group ─────────────────────────────────────────
config_app = typer.Typer(help="Manage CLI configuration.")
app.add_typer(config_app, name="config")


@config_app.command("set-url")
def config_set_url(url: str = typer.Argument(..., help="Backend API URL")):
    """Set the backend API URL (e.g. https://yourserver.com/api)."""
    set_api_url(url)
    console.print(f"[green]API URL set to:[/green] {url}")


@config_app.command("show")
def config_show():
    """Show current configuration."""
    console.print(f"[cyan]API URL:[/cyan] {get_api_url()}")


# ── Auth commands ────────────────────────────────────────────────────

@app.command()
def login(
    email: str = typer.Option(..., prompt=True),
    password: str = typer.Option(..., prompt=True, hide_input=True),
):
    """Sign in with your DaemonClient email and password."""
    _login(email, password)


@app.command()
def logout():
    """Clear your saved session."""
    _logout()


@app.command()
def whoami():
    """Show the currently logged-in user."""
    _whoami()


# ── File commands ────────────────────────────────────────────────────

@app.command("list")
def list_files(
    json_out: bool = typer.Option(False, "--json", help="Output raw JSON for scripting"),
):
    """List all files in your cloud."""
    import requests

    try:
        res = requests.get(f"{get_api_url()}/list", headers=get_auth_headers(), timeout=15)
        if res.status_code != 200:
            console.print(f"[red]Error:[/red] {res.text}")
            raise typer.Exit(1)

        files = res.json().get("files", [])

        if json_out:
            print(json.dumps(files, indent=2))
        else:
            table = Table(title="☁️  DaemonClient Files")
            table.add_column("ID", style="cyan", no_wrap=True)
            table.add_column("Name", style="magenta")
            table.add_column("Type", style="dim")
            table.add_column("Size", style="green", justify="right")

            for f in files:
                ftype = f.get("type", "file")
                if ftype == "folder":
                    size_str = "—"
                else:
                    size_str = f"{int(f.get('fileSize', 0)) / 1024 / 1024:.2f} MB"
                table.add_row(f["id"], f.get("fileName", "?"), ftype, size_str)

            console.print(table)

    except Exception as e:
        console.print(f"[red]Connection error:[/red] {e}")
        raise typer.Exit(1)


@app.command()
def upload(
    file_path: str = typer.Argument(..., help="Path to the file to upload"),
    folder: str = typer.Option("root", "--folder", "-f", help="Target folder ID"),
    no_encrypt: bool = typer.Option(False, "--no-encrypt", help="Skip ZKE encryption"),
):
    """Upload a local file to the cloud."""
    upload_file(file_path, folder_id=folder, no_encrypt=no_encrypt)


@app.command()
def download(
    file_id: str = typer.Argument(..., help="File ID to download"),
    output: str = typer.Option(None, "--output", "-o", help="Custom output path"),
):
    """Download a file from the cloud."""
    download_file(file_id, output_path=output)


@app.command()
def delete(
    file_id: str = typer.Argument(..., help="File ID to delete"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation"),
):
    """Delete a file from the cloud."""
    delete_file(file_id, skip_confirm=yes)


@app.command()
def version():
    """Show the CLI version."""
    console.print(f"[bold cyan]daemonclient[/bold cyan] v{__version__}")


if __name__ == "__main__":
    app()
