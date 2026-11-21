# Setup guide: from IPA to your photos

HomeRoll is only the app. Your photos live on your own **Immich server**, so you need one of those first. If you already run Immich, skip to step 3.

## What you need

- An iPhone with **iOS 26 or newer**
- A computer that runs all the time (NAS, mini PC, home server, old laptop) with **Docker**
- A free Apple ID for sideloading

## 1. Set up Immich

Follow the official guide: <https://docs.immich.app/install/docker-compose>

Short version:

```bash
mkdir immich-app && cd immich-app
wget -O docker-compose.yml https://github.com/immich-app/immich/releases/latest/download/docker-compose.yml
wget -O .env https://github.com/immich-app/immich/releases/latest/download/example.env
# edit .env: UPLOAD_LOCATION (where your photos are stored) and DB_PASSWORD
docker compose up -d
```

HomeRoll is tested with Immich **v3.3.5**. Newer versions usually work, older ones may not.

## 2. Create your account

1. Open `http://<server-ip>:2283` in a browser on your computer.
2. The first user you create is the admin. Note the e-mail and password, you log in to the app with them.
3. Optional: upload your existing photos here or with [icloudpd](https://github.com/icloud-photos-downloader/icloud_photos_downloader) / the [Immich CLI](https://docs.immich.app/features/command-line-interface). You can also let HomeRoll back up everything from the iPhone (step 5).

## 3. Make the server reachable from the iPhone

| Where | Address to use in the app | Works away from home |
|---|---|---|
| Home Wi-Fi only | `http://192.168.x.y:2283` | no |
| VPN (Tailscale, WireGuard) | `http://100.x.y.z:2283` (Tailscale IP) or your WireGuard IP | yes, with VPN on |
| Public with HTTPS (reverse proxy, Cloudflare Tunnel) | `https://photos.example.com` | yes |

Important:

- iOS blocks plain `http://` to public domain names. A public address **must** use HTTPS with a normal certificate (e.g. Let's Encrypt).
- Self-signed certificates and certificates from your own home CA don't work with the prebuilt IPA. Use HTTP inside your home network or a VPN, or [build the app yourself](../README.md#build--install) with your CA.
- Type `http://` in front of IP addresses. Without it the app tries `https://`.

## 4. Install the IPA

1. Install [SideStore](https://sidestore.io) (no computer needed later) or [AltStore](https://altstore.io) (needs AltServer on your computer) and sign in with your Apple ID.
2. Download `HomeRoll-<version>.ipa` (e.g. `HomeRoll-1.0.3.ipa`) from the [latest release](https://github.com/silentprovider423/HomeRoll/releases/latest) on the iPhone.
3. Open it with SideStore/AltStore ("Share" → SideStore, or the **+** button in My Apps).
4. If iOS asks: Settings → Privacy & Security → **Developer Mode** on, iPhone restarts.

With a free Apple ID the app has to be **refreshed every 7 days**. SideStore and AltStore do that for you, just open them once a week. Free accounts can only have 3 sideloaded apps active and create 10 app IDs per week; HomeRoll uses 3 (app, widget, share extension).

## 5. First start

1. Open HomeRoll, enter the server address from step 3, your Immich e-mail and password, tap **Sign In**.
2. Allow **local network** access when asked (needed for servers at home).
3. Your library loads. The first time takes a while with many photos, after that it is stored on the iPhone.

Backup (optional):

1. Go to **Collections**, tap the account button at the top right → **Backup**, and allow access to **all photos**.
2. Turn backup on. By default it backs up the **whole library**, including photos that are only in iCloud (they get downloaded for it).
3. Already moved older photos to the server another way? Turn on *"Older Photos Are Already on the Server"* and set the date. Then only newer photos are uploaded.
4. Backups run when the app is open and in the background while the iPhone is charging.

Free Up Space (in Backup) deletes from the iPhone only photos that are verified on the server. iOS asks first and keeps them in Recently Deleted for 30 days.

## 6. More people (family)

Every person gets their own Immich account and only sees their own photos.

1. In the Immich web app: **Administration → Users → Create user**.
2. Each person installs HomeRoll and logs in with their own e-mail and password (or SSO).
3. To share: **partner sharing** (Immich web app → Account settings → Partner sharing) or shared albums.

## 7. Keep your photos safe

Your server is now the only place your photos live, so back it up:

- **Second disk:** back up the Immich library (`UPLOAD_LOCATION`) and the database to another disk, e.g. once a day. Immich's guide: <https://docs.immich.app/administration/backup-and-restore>
- **Outside your home:** a copy somewhere else (cloud storage like Backblaze B2, or a disk at a friend's place) protects against fire and theft.
- **Watch your disks:** check SMART values now and then, or set up a mail alert.

HomeRoll's backup only copies the iPhone to the server, it doesn't back up the server.

## Optional server add-ons

Better smart search, receipts/document categories and Clean Up need extra services next to Immich, see [`server/README.md`](../server/README.md). The app works without them.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not connect" at login | Check the address in Safari on the iPhone first. Missing `http://`? Port `2283`? VPN on? |
| Works at home, not on mobile data | Your address is a home IP. Use a VPN or HTTPS (step 3). |
| Login fails with a certificate error | Self-signed or home-CA certificate. Use Let's Encrypt, HTTP in your home network, or build the app yourself. |
| App doesn't open after a week | Refresh it in SideStore/AltStore. |
| Can't install, "maximum number of apps" | Free Apple IDs allow 3 sideloaded apps. Remove one or wait for the weekly app ID limit to reset. |
| Widget or share extension shows nothing | Open the app once after installing and log in, then add the widget again. |

Found a bug? Open an [issue](https://github.com/silentprovider423/HomeRoll/issues). Personal project, I answer when I have time.
