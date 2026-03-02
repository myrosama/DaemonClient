# DaemonClient CLI

**Unlimited, encrypted cloud storage — from your terminal.**

DaemonClient uses Telegram as a free, unlimited storage backend and encrypts everything client-side with AES-256-GCM (Zero-Knowledge Encryption).

## Install

```bash
pip install daemonclient
```

## Quick Start

```bash
# 1. Login with your DaemonClient account
daemon login

# 2. See your files
daemon list

# 3. Upload a file (auto-encrypted if ZKE is enabled)
daemon upload myfile.zip

# 4. Download a file
daemon download <file-id>

# 5. Delete a file
daemon delete <file-id>
```

## Commands

| Command | Description |
|---------|-------------|
| `daemon login` | Sign in with email & password |
| `daemon logout` | Clear saved session |
| `daemon whoami` | Show current user |
| `daemon list` | List all files (add `--json` for scripts) |
| `daemon upload <path>` | Upload a file |
| `daemon download <id>` | Download a file |
| `daemon delete <id>` | Delete a file |
| `daemon config set-url <url>` | Set backend API URL |

## Encryption

Files are encrypted with **AES-256-GCM** using a key derived via **PBKDF2** (100,000 iterations). Your password never leaves your device — the server only stores encrypted blobs.

## Links

- **Web App:** [daemonclient.uz](https://daemonclient.uz)
- **GitHub:** [github.com/myrosama/DaemonClient](https://github.com/myrosama/DaemonClient)
