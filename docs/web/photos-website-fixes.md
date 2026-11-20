# Photos website: what to fix so the app and the website work together

For the Linux machine (it owns `workers/user-worker/`, `apps/photos-web/web/`, the
service worker and every worker release) and for the operator. Written
2026-11-17 from the phone core's Task 1.8–1.9 measurements on the test account
(every number: `docs/mobile/RESEARCH.md` §14) and a read of the code. Background: `docs/mobile/RESEARCH.md` §14,
`docs/mobile/SPEC.md` D22/D23.

**The rule behind all of it (SPEC D23):** the phone does the heavy work, the
worker keeps the books. The phone uploads the original byte for byte, makes
the thumbnail, the preview and the EXIF itself, and sends every byte straight
to Telegram. The worker stores ids and metadata — nothing it has to download,
convert or decrypt. The website should work the same way, so that each one
reads what the other uploaded.

---

## Telegram's limits, as measured and as documented

| What | Number | Source |
|---|---|---|
| Sends to one group (the storage chat is a supergroup) | **20 requests a minute** — the 21st in a burst waits ~40 s | Bot FAQ: "In a group, bots are not able to send more than 20 messages per minute"; measured exactly |
| Sends in the same second | about 1 a second; several at once draw a short wait (~6 s) | Bot FAQ: "avoid sending more than one message per second"; measured with three albums in flight |
| A safe steady pace | **1 send every 3.5 s, bursts of 2** (≤ 19 in any minute) | 10 minutes, 170 sends, no refusal; 1 per 3 s drew one after 40 |
| Requests in flight | **one at a time** — albums started together are refused; two big parts in flight gain nothing | measured |
| An album (`sendMediaGroup`, 2–10 documents) | counts as **one** request; Telegram takes ~0.6–0.8 s per file in it (~6 s for 10) | measured: 300 files in 3.2 min, no refusal |
| An album's size | **≤ 45 MB** — 47 MB went, 52 MB got HTTP 413 | measured |
| Reads (`getFile` + the file) | no limit seen up to 126 a second | measured, 1,600 requests |
| Delete | `deleteMessages`, 1–100 ids per call; the docs say a message can only be deleted for 48 h (an admin in a supergroup may be exempt — being checked) | Bot API |
| A deleted message's file | **still downloads by its file id** | measured |

So a backup is bound by how many *requests* it makes, not files: ten files in
one album cost what one file costs.

**Cloudflare's free plan** (every user's worker and D1 are on their own free
account): **100,000 worker requests a day** (then Error 1027 until 00:00
UTC), 10 ms CPU a request; D1 **100,000 rows written** and 5 M rows read a
day. A new photo writes ~6–7 D1 rows (the row + one per index), so a backup can
add at most ~14,000–16,000 photos a day; a scroll costs one worker request per
thumbnail today. Items 2, 3 and 9 below are about this budget.

---

## The fixes, in order

### 1. Worker release R2 — take the phone's preview, EXIF and message ids

*(Built by the Linux machine as **R2** — the Mac called it W2; Drive's W2 is a
different, later release. The operator approved R2's release 2026-11-18.
Message ids are still to add.)*

**Symptom.** iPhone photos backed up by the app (HEIC) show a thumbnail in
the grid but do not open in Chrome, Firefox or on Android; there is no camera
information; and the worker quietly downloads every phone photo again.

**Why.** On `POST /api/assets` with `clientUpload=true`, the worker ignores
`telegramPreviewId` and `exif`. The website's service worker then has no
preview and serves the raw HEIC as `image/heic` (`telegram-media.ts`
`selectFileIds`), which only Safari can show. And because `exifChecked` stays
unset for client uploads (`assets.ts`, `exifChecked: clientUpload ? undefined
: …`), `backfillExifBatch` downloads and decrypts the first part of every
phone image to read its EXIF.

**Change** (`workers/user-worker/src/assets.ts`, the `clientUpload` branch of
`handleUpload`, plus D1 columns where missing):
- store `telegramPreviewId` (encrypted like the thumbnail: `thumbEncrypted`
  covers both);
- store `exif` — one JSON field in the `PhotoExif` shape (make, model,
  lensModel, fNumber, focalLength, iso, exposureTime, orientation,
  dateTimeOriginal, latitude, longitude) — and set `exifChecked` to the
  current version, so the backfill never touches it;
- store `telegramThumbMessageId` and `telegramPreviewMessageId` (new; see 3).

**Verify.** The phone side already sends the preview and EXIF; once W2 is
live, a HEIC uploaded with `dc-cli upload x.heic` (on the Mac) opens in Chrome
and shows its camera data; the worker log shows no EXIF backfill for it.

### 2. Talk to Telegram directly — drop the `/proxy` relay

**Symptom.** Every byte the website reads or uploads passes through the
user's worker: the service worker's `getFile` and file downloads
(`telegram-media.ts` `buildGetFileUrl` / `buildDownloadUrl`) and the uploader's
`sendDocument` (`daemonclient-drive.ts`) all go to `${proxyUrl}?url=…`, the
worker's `/proxy` (`index.ts`, set by `server.ts` `proxyUrl`). A thumbnail on
the website costs **3 worker requests** (manifest, file path, bytes); an upload
part costs its whole body through the worker.

**Why it isn't needed (checked 2026-11-17 from the Mac, with a made-up
token):** Telegram answers browsers itself — `api.telegram.org/bot…/getMe`
and `api.telegram.org/file/bot…/…` both return
`access-control-allow-origin: *` (even on 401/404), and a multipart `POST`
is a CORS "simple request" (no preflight; Telegram's preflight answers with
`allow-origin: *` and `allow-headers: content-type` anyway). The phone core
has always talked to Telegram directly.

**Change.** Call `https://api.telegram.org/…` directly for `getFile`, file
downloads and `sendDocument` / `sendMediaGroup`; keep `/proxy` only as a
fallback when a direct call fails at the network level (a network that blocks
Telegram). Nothing is exposed that isn't already: the browser already holds
the bot token (`/api/server/telegram-config`).

**Verify.** DevTools → Network while scrolling: thumbnails come from
`api.telegram.org`, and the worker sees only manifest (or bucket) requests;
an upload's parts go to `api.telegram.org`.

### 3. Thumbnail file ids in bulk (fewer worker requests while scrolling)

**Symptom.** Scrolling a big library costs one worker request per thumbnail
(the app and the website both fetch `dc-manifest` before each thumbnail): a
fling through 10,000 photos is 10,000 worker requests — a tenth of the
free plan's day — and each thumbnail waits one more round trip. Measured on
the phone: ~44 thumbnails a second is the ceiling while each needs its own
manifest.

**Change.** Put what a thumbnail needs (`thumbId`, `thumbEncrypted` /
`encryptionMode`, `mimeType`) into the timeline bucket's columns
(`timeline.ts`, beside `ratio` and `thumbhash`), or add a bulk route (ids in,
manifests out). Then a month of thumbnails costs one worker request. Tell the
Mac which: the phone core will read the same.

**Verify.** Scroll a month on the website with DevTools open: one bucket
request, no `dc-manifest` per tile.

### 4. One spelling for checksums

**Symptom.** The website uploads again a photo the app already backed up.

**Why.** The website stores **hex** SHA-1 (`apps/photos-web/web/src/lib/workers/hash-file.ts`,
`bytesToHex`); the Immich app, the worker's own backfill (`sha1.ts`) and the
phone store **base64**. `bulk-upload-check` and `getPhotosByChecksums`
(`d1-adapter.ts`) compare the text. (The phone now asks about both spellings,
so it no longer re-uploads the website's photos; the other direction is
yours.)

**Change.** Pick base64 (most rows already use it). In `bulk-upload-check`
and at upload, turn a 40-character hex checksum into base64 before
comparing or storing (upstream Immich accepts either). Migrate existing rows:
every 40-character `[0-9a-f]` checksum → base64 of the same bytes.

**Verify.** Upload a photo with the app (or `dc-cli upload`), then drop the
same file on the website: it says the photo is already there.

### 5. Delete everything a photo left behind

**Symptom.** After a photo is deleted its thumbnail (and preview) stay in the
user's Telegram chat — in an unencrypted library, a visible picture — and the
owner can still fetch the deleted photo through `dc-manifest`.

**Why** (`assets.ts` `handleDeleteAssets`): only the messages in
`telegramChunks` are deleted; no message id is stored for the thumbnail or the
preview, so they cannot be. The tombstone row (`isTrashed=1`) keeps
`telegramOriginalId`, `telegramThumbId` and `telegramPreviewId`, and the
`dc-manifest` route does not check `isTrashed`. `deleteMessage`'s answer is
not checked.

**Change.**
- store the thumbnail's and preview's message ids (W2, item 1; the website's
  own uploader should send them too) and delete them with the parts;
- use `deleteMessages` (up to 100 ids a call) instead of one call per part;
- on the tombstone clear every file id (`telegramOriginalId`,
  `telegramThumbId`, `telegramPreviewId`, playback ids), and answer 404 from
  `dc-manifest` for `isTrashed` rows;
- log a failed delete (don't swallow it). Messages older than 48 hours may
  not be deletable — the Mac is checking whether the bot, as a supergroup
  admin, is exempt.
- say in the product text that deleting removes a photo from the library and
  the chat, but Telegram may keep the file: an encrypted library leaves only
  ciphertext; an unencrypted one cannot be fully erased.

**Verify.** Upload, delete, then `dc-cli download <id> out` on the Mac:
"not found". The thumbnail's message is gone from the chat.

### 6. Website video: stop re-downloading, start playing sooner

**Symptom.** Videos "kinda lag" (the operator, on the P1 exit video): slow to
start, and they pause every ~19 MB.

**Why** (`apps/photos-web/web/src/service-worker/index.ts`, `fetchVideoDirect` and
`downloadChunk`): every range request downloads and decrypts a whole 19 MiB
chunk, with no chunk cache and no prefetch. Browsers make several range
requests while opening a video (a probe, the index at the end of an iPhone
`.mov`, then playback), so the first chunk is downloaded two or three times,
and playback stops at each chunk boundary while the next one downloads.

**Change.** Keep the last 3 decrypted chunks in memory (keyed by file id,
about 57 MB), and when chunk *n* is served, start chunk *n+1* in the
background at a low priority — exactly the phone core's fix (Task 1.6:
`PartCache` + next-part prefetch), after which each part downloaded once.

**Also — pick the file by what the browser can play.** Today the service
worker plays `playbackChunks` whenever they exist. Once phones upload H.264
copies of HEVC videos (SPEC §5.1, P2-9), Safari would get the 720p copy
instead of the original. Use the original when
`canPlayType('video/mp4; codecs="hvc1"')` (or `"hev1"`) says `probably`/`maybe`,
the copy otherwise; downloads stay the original.

**Verify.** Open a multi-part video in DevTools → Network: each chunk's
Telegram download appears once; playback runs past the 19 MB marks without
stopping on a normal connection.

### 7. Pace every send, and send small files in albums

**Symptom.** Long website uploads stall ~40 s at a time.

**Why.** The website's uploader (`apps/photos-web/web/src/lib/utils/daemonclient-drive.ts`,
the `sendDocument`/`sendPhoto` calls) does not pace at all — it only waits
out each 429; the worker's `paceSend` (`assets.ts`, `SEND_INTERVAL_MS =
1500`, `SEND_BURST = 8`) allows twice the group limit.

**Change.**
- pace both at **1 request every 3.5 s, bursts of 2**, **one request in
  flight**, and keep honouring `retry_after`;
- **once the operator approves SPEC D24**, send small files **in albums**:
  when the pacer allows a send, every small
  file waiting (≤ 5 MB each) goes into one `sendMediaGroup` of up to 10
  documents and **≤ 45 MB**; a lone file goes alone; a 19 MiB part always
  goes alone. Give every file a random name (thumbnails and previews too) and
  match Telegram's answer by name and size, not by order. A
  photo's part, thumbnail and preview, and the next photos', can share an
  album — all as documents (an album cannot mix documents with photos, so
  send an unencrypted thumbnail as a document too — check the website still
  shows it). That is ~2× for 3 MB photos on a 2 MB/s uplink and up to ~5× for
  small files (measured: 3 MB files 19 → 38 a minute; tiny files 19 → 98).
  The phone will do the same in P2 once D24 is approved.

**Verify.** Upload 100 photos from the website: no `429` in the console, and
it takes minutes, not tens of minutes.

### 8. Website uploads keep the original

**Symptom.** A HEIC uploaded from the website loses its original bytes and
EXIF; the app then sees a JPEG that is not what the camera made.

**Why.** `apps/photos-web/web/src/lib/utils/file-uploader.ts` converts HEIC to JPEG
with `heic2any` before uploading.

**Change.** Upload the file as it is (byte for byte), and make a JPEG
**preview** in the browser (the same `heic2any`/canvas code, ~1440 px) sent
as `telegramPreviewId`; read EXIF in the browser and send it as `exif` (item
1). The checksum stays the original's.

**Verify.** Upload a HEIC on the website, then `dc-cli download <id> out.heic`
on the Mac: "checksum matches", and the file is a HEIC.

### 9. Stay inside the free plan's day

**Symptom.** A big first backup stops dead for the rest of the day (Error
1027, or D1's "daily limit exceeded"), and everything else on that account
stops with it.

**Change.**
- **Bulk routes:** the duplicate check already takes many checksums — the
  phone will send 100 a request; add a bulk create (`clientUpload` metadata
  for up to ~10 assets, one D1 `batch()` — it counts as one query against the
  50-a-request limit), so an album of photos costs one create request.
- **Fewer D1 writes per photo:** each index adds a written row per insert;
  `idx_photos_trashed` indexes a boolean and helps no query worth it — drop it
  (one written row fewer a photo; read `meta.rows_written` on one insert to
  see whether the primary key makes it 7 or 6 today).
- **Say it, don't retry it:** when the worker or D1 hits a daily limit,
  answer with a clear code the phone and the website recognise (not a
  generic 500), so they stop until 00:00 UTC instead of burning requests.

**Verify.** On the test account, back up 1,000 photos and count the worker
requests in the Cloudflare dashboard: about 2 per album, not 3 per photo.

### 10. Delete the worker's byte paths (D23)

Once 1–9 are live, nothing should need the worker to move bytes: delete the
server-side upload (`assetData`), serving decrypted thumbnails, originals and
video (with its range stitching), the D18 `POST /api/assets/:id/thumbnail`
route, the EXIF and HEIC backfills that download originals, and any
server-side conversion. Keep the service worker's fallback to the worker only
until the website reads everything directly.

### 11. For the operator to decide

- ~~iPhone videos are HEVC~~ — **decided 2026-11-18:** the uploading phone
  makes a 720p H.264 copy (`telegramPlaybackChunks`) for videos that are not
  H.264 8-bit; the website plays the original where the browser can
  (`video.canPlayType('video/mp4; codecs="hvc1"')`, Safari) and the copy
  elsewhere — see item 6. The worker must accept `telegramPlaybackChunks`
  (+ size) on `clientUpload`.
- **A channel instead of a supergroup** for new accounts: Telegram documents
  the 20-a-minute limit for groups only. With albums (item 7) the ceiling is
  already ~5× higher, so this is worth testing only if backups are still too
  slow.

---

## How to check from the Mac

`dc-cli` (in `core/dc-cli`, built with `cargo build --release -p
dc-cli`) signs in to the test account from the Keychain and runs the phone
core's real code: `upload`, `download` (checks the stored checksum, either
spelling), `delete`, `list`, `serve` (plays a video through the phone's local
server), and `bench reads | sends | albums | upload | scroll | parts`. Ask the Mac to
run any of the checks above after a release.
