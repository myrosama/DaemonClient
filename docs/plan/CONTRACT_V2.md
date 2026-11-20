# Worker contract v2 — draft for the Linux machine

**Status: draft, 2026-11-20, written on the MacBook from the code on `main`.**
For Linux to change, then agree before either side builds (ENGINE.md §12 Q3,
Q9; Linux agreed 2026-11-19 to design sync fresh: "a cursor + tombstones").
Nothing here exists yet. v1 routes stay until nothing uses them.

## 1. Why

Every read of the library today loads **all** of a user's rows:
`/api/sync/stream` (one `SELECT` of every photo per call) and
`/api/timeline/buckets` + `/bucket` (`loadPhotos`, then group). At 2,000
items that is fine; at 100,000 a single client syncing costs 100,000 D1 row
reads, and the free plan allows 5 M a day — about 50 syncs. The native apps
keep a local index (ENGINE.md §8, `dc-core`) and need only what changed.

## 2. A change number on every row

- `photos.rev INTEGER NOT NULL DEFAULT 0` + `CREATE INDEX idx_photos_rev ON photos(rev)`.
- Every insert or update that a client would see (upload, favorite,
  visibility, live-photo link, thumbnail or preview set, EXIF fill, trash)
  sets `rev = (SELECT COALESCE(MAX(rev), 0) + 1 FROM photos)` in the same
  statement. Each user has their own D1 database and D1 serializes writes, so
  the numbers are unique and increasing per user.
- Albums: `albums.rev`, and membership changes recorded with a rev
  (`album_assets.rev`, and a small `album_assets_removed(albumId, assetId, rev)`
  for removals).
- Existing rows: one migration gives them `rev` 1..n in `fileCreatedAt` order.

## 3. `GET /api/v2/changes?since=<rev>&limit=<n>`

```json
{
  "rev": 48213,            // the highest rev in this answer; the next `since`
  "more": false,           // true → call again with since = rev
  "reset": false,          // true → since is older than the kept tombstones: drop the index, sync from 0
  "assets": [ AssetRow ],  // inserted or changed, in rev order
  "deleted": [ "id", … ],  // isTrashed rows (the tombstones; treat isTrashed as the truth — R3)
  "albums": [ AlbumRow ],
  "albumsDeleted": [ "id" ],
  "albumAssets": { "added": [["albumId","assetId"]], "removed": [["albumId","assetId"]] }
}
```

- `since=0` is the full first sync, paged by `limit` (default 1,000, max 5,000).
- Tombstones (`isTrashed=1` rows) are kept **N days** (proposal: 30) before the
  purge; a client whose `since` predates the oldest purge gets `reset: true`.
- Reads per call = changed rows only.
- The heal jobs (EXIF / checksum / HEIC backfill, tombstone purge) need a
  trigger other than `/api/sync/stream` (Linux, 2026-11-19) — not this route,
  so a sync stays cheap.

## 4. `AssetRow` — what the grid and viewer need without another request

| Field | Type | Note |
|---|---|---|
| `id`, `checksum` | string | checksum = base64 SHA-1 (one spelling) |
| `type` | `IMAGE` \| `VIDEO` | |
| `mimeType`, `fileName`, `fileSize` | | |
| `width`, `height` | int | 0 = unknown (the viewer must cope — 2.3's 0×0 crash) |
| `durationMs` | int \| null | a number, not `"0:00:00.000"` |
| `takenAt` | ISO-8601 UTC | today `fileCreatedAt` |
| `localDateTime` | ISO-8601, no zone | for grouping by day/month in the photo's own time |
| `isFavorite` | bool | a real boolean |
| `visibility` | `timeline` \| `archive` \| `hidden` \| `locked` | |
| `livePhotoVideoId` | string \| null | |
| `thumbhash` | string \| null | |
| `thumb` | `{ "fileId", "encrypted" }` \| null | **so the core fetches a thumbnail straight from Telegram with no manifest request per tile** |
| `preview` | `{ "fileId", "encrypted" }` \| null | same, for the viewer's first picture |
| `exif` | object \| null | the R2 fields (make, model, lens, f-number, exposure, ISO, focal length, orientation, taken-at, lat/lon) |
| `rev` | int | |

Originals and video parts still come from `dc-manifest` (only when opened).

## 5. `POST /api/v2/assets` — bulk create (D24)

One request per album the core sends to Telegram (≤ 10 items):

```json
{ "items": [ { "clientId": "c1", /* the R2 upload fields */ } ] }
→ { "results": [ { "clientId": "c1", "id": "…" },
                 { "clientId": "c2", "duplicateOf": "…" },
                 { "clientId": "c3", "error": "…" } ] }
```

- Idempotent: a repeat of `(deviceId, deviceAssetId)` or of a known checksum
  returns the existing id (`duplicateOf`) — a retried request never doubles.
- One D1 batch per request; the free plan's 100k row writes a day still
  bound backups (D24's ~14–16k photos a day).
- Width, height, duration, thumbhash, `exif` (always, `{}` when empty — R2)
  and the thumbnail/preview ids are sent by the phone.

## 6. Questions for Linux

1. `rev` by `MAX(rev)+1` in each write, or a counter row? Any write path
   that would miss bumping it (backfills, D1 console edits)?
2. Tombstone retention: 30 days?
3. `thumb` / `preview` file ids in the row — any reason not to expose them to
   the owner's own client (they are useless without the bot token and key)?
4. Does the website move to `/api/v2/changes` too, in the joint phase (D25)?
