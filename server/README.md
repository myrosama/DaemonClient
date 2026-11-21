# Optional server add-ons

Small Docker services that run **next to Immich** (same Docker network `immich_default`). The app works without them; with them, search, memories, people and editing get better.

| Service | Port | What the app uses it for |
|---|---|---|
| `relevanz` (`relevanz.py`) | 2284 | keeps only clear hits of smart search; face suggestions ("Is this X?"); sensitive-photo check for memory covers (computes missing CLIP embeddings on demand, read-only) |
| `kategorien` (`kategorien.py`) | – | tags photos as `Kategorie/<name>` (receipts, documents, handwriting, QR codes …) every 15 min |
| `bereinigen` (`bereinigen/`) | 2285 | Clean Up in the editor and background fill of the spatial scene (LaMa, CPU) |

## Setup

### 1. Read-only database user

The services only **read** from Immich's database. Create a dedicated role instead of using the Immich superuser
(`docker exec -it immich_postgres psql -U postgres -d immich`):

```sql
CREATE ROLE homeroll_readonly LOGIN PASSWORD 'choose-a-long-password';
GRANT CONNECT ON DATABASE immich TO homeroll_readonly;
GRANT USAGE ON SCHEMA public TO homeroll_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO homeroll_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO homeroll_readonly;
-- PostgreSQL 14 lets every role create tables in "public" by default – switch that off:
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

### 2. Config files

```bash
cd server
cp .env.example .env
cp db_url.txt.example db_url.txt   # your read-only role and password – mounted as a Docker secret, not an env variable
cp keys.json.example keys.json     # one Immich API key per user for the categories service (see below)
mkdir -p data
# the containers run as UID 10001 (not root): let them read the secrets and write the state
sudo chown 10001:10001 db_url.txt keys.json data && sudo chmod 600 db_url.txt keys.json
```

**API keys for `kategorien`:** create them in Immich (Account settings → API keys) with only these permissions:
`asset.read`, `asset.view`, `tag.read`, `tag.create`, `tag.asset`. Nothing else is needed.

### 3. Start

```bash
docker compose up -d --build       # relevanz + kategorien
cd bereinigen && docker compose up -d --build
```

The images are pinned (base image digest, package hashes, LaMa model SHA-256); the build fails if anything was swapped.
The containers run without root, with a read-only file system, no Linux capabilities and memory/CPU/process limits.

## How the app reaches them

By default the ports are bound to **127.0.0.1 only** – nothing on your network can reach them yet. Pick one:

- **Reverse proxy (recommended, HTTPS):** the app calls `https://photos.example.com/fotos-dienst/<name>`. Example for nginx / Nginx Proxy Manager ("advanced"):

  ```nginx
  location /fotos-dienst/relevanz   { proxy_pass http://127.0.0.1:2284/relevanz; }
  location /fotos-dienst/bereinigen { proxy_pass http://127.0.0.1:2285/bereinigen; client_max_body_size 30m; proxy_read_timeout 300s; }
  ```
  (If the proxy runs on another machine, set `BIND_ADDR` to the server's LAN IP and use that IP here.)

- **Home network without proxy:** if the app talks to Immich directly on port **2283**, it calls `http://<server>:2284/relevanz` and `http://<server>:2285/bereinigen`. Set `BIND_ADDR=<LAN IP of the server>` in `server/.env` and `server/bereinigen/.env`. This is plain HTTP – only on your own network or over a VPN.

**Never forward these ports or Immich to the internet without HTTPS and authentication.** The recommended setup is home network or VPN (e.g. WireGuard) only.

Limits: Clean Up accepts at most 30 MB per request and 2 at a time (`MAX_BODY_MB`, `MAX_CONCURRENT`); more than 20 failed logins per minute from one address get `429`.
