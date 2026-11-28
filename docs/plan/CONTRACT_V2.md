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

## 5b. A real Trash (operator, 2026-11-22, SPEC D30)

The apps and the website get a 30-day **Recently Deleted**: a delete moves an
asset to the trash (`deletedAt`, a `rev` bump, still listed in `/changes`
with its `deletedAt`); `POST /api/v2/assets/restore` brings it back; a purge
after 30 days (or "Delete now" / "Empty") does today's permanent delete
(Telegram parts, then the tombstone). `/changes` then carries `trashed`
(with `deletedAt`) separately from `deleted` (gone for good). Until this
exists the apps delete permanently behind a clear warning.

### Linux design for 5b (2026-11-28)

Why first: the worker already tells the website `trash: true, trashDays: 30`,
so the website's **Move to trash** looks reversible, but since R3 a delete is
permanent and **Restore** answers 400. The website and the apps both need this.

**Row states.** Two new columns, `deletedAt` and `purgeAt` (ISO text, added on
first use like the other columns); `isTrashed` keeps meaning "out of the
library".

| State | isTrashed | purgeAt | purgedAt | Telegram parts | Restorable | Shown in |
|---|---|---|---|---|---|---|
| live | 0 | null | null | kept | | library |
| in the trash | 1 | `deletedAt` + 30 days, in the future | null | kept | **yes** | Trash / Recently Deleted |
| purge due | 1 | now or past (or null: rows R3 deleted) | null | being deleted | no | nowhere |
| purged | 1 | | set | cleared | no | nowhere (tombstone, 90 days) |

**Today's routes (the website and the apps use these now):**
- `DELETE /api/assets {ids, force: false}` and `PUT … isTrashed: true` move to
  the trash: `isTrashed=1, deletedAt=now, purgeAt=now+30d`. Nothing goes to
  Telegram.
- `DELETE /api/assets {ids, force: true}` deletes for good now (`purgeAt=now`,
  then the R3 path: Telegram in batches of 100, parts forgotten once confirmed),
  from the library or from the trash.
- `POST /api/trash/restore/assets {ids}` and `POST /api/trash/restore` bring
  restorable rows back (`isTrashed=0`, `deletedAt`/`purgeAt` cleared). Rows past
  their purge are skipped and reported.
- `POST|DELETE /api/trash/empty` makes every trashed row due, then drains (the
  R3 caps: 1000 rows, 40 Telegram calls a request; the rest on later requests).
- The trash view lists restorable rows only. Their thumbnails, originals and
  manifest still load, so a trashed photo can be opened; due and purged rows
  stay 404 (R3).
- A Live Photo's still and video are trashed, restored and purged together.
  Album membership stays while in the trash (hidden from the album) and comes
  back on restore; the purge removes it.

**The 30-day purge.** One job drains due rows (100 at a time, ≤ 40 Telegram
calls). It runs after every delete or empty (as today) and in the background of
the month and `/changes` routes at most once an hour per worker, so it needs no
schedule of its own and costs one cheap query when nothing is due.

**In contract v2:** `/changes` lists restorable rows as `trashed: [{ id,
deletedAt, purgeAt }]` and due or purged ones in `deleted: [id]`; trashing,
restoring and becoming due each bump `rev`. `POST /api/v2/assets/restore
{ ids }` → `{ restored: [ids], notRestorable: [ids] }`. "Delete now" and
"Empty" use the routes above.

## 7. Build order (Linux, 2026-11-28)

Each is its own worker release with all four gates; the MacBook builds the
core's side against each as it lands.

1. **R8: the Trash on today's routes** (5b above). The website's Trash and the
   apps' Recently Deleted work at once; no v2 needed.
2. **R9: `rev` + `GET /api/v2/changes` + `AssetRow`** (§2–4 with the 2026-11-20
   answers: `MAX(rev)+1`, old rows at rev 0, the `(rev, id)` cursor,
   `purgedThroughRev`, `durationMs` and the local time from R7).
3. **R10: `POST /api/v2/assets` bulk create + `POST /api/v2/assets/restore`.**

Questions for the MacBook before R8: (a) are the Live Photo and album rules
above what the app expects; (b) is "Delete now" fine as
`DELETE /api/assets {ids, force: true}`, or do you want a v2 route for it?

## 6. Questions for Linux

1. `rev` by `MAX(rev)+1` in each write, or a counter row? Any write path
   that would miss bumping it (backfills, D1 console edits)?
2. Tombstone retention: 30 days?
3. `thumb` / `preview` file ids in the row — any reason not to expose them to
   the owner's own client (they are useless without the bot token and key)?
4. Does the website move to `/api/v2/changes` too, in the joint phase (D25)?

### Linux answers (2026-11-20)

1. **`rev` = `MAX(rev)+1` through `idx_photos_rev`, not a counter row.** A
   counter row is one more write per change against the free plan's 100,000
   row writes a day; the indexed MAX costs a read. Two consequences:
   - A statement that updates many rows (the batched delete in R3, any
     `UPDATE … WHERE id IN (…)`) evaluates the subquery once, so those rows
     share one `rev`. Pages must never split a `rev`: make the cursor the pair
     `(rev, id)` (`WHERE rev > ? OR (rev = ? AND id > ?) ORDER BY rev, id`), or
     extend each page to the end of its last `rev`.
   - **Don't number existing rows.** Leave them at `rev 0`: the first sync
     (`since=0`) returns them anyway, and a 100k-photo library's numbering
     migration alone would blow the day's write cap.
   - Where to bump: `D1Adapter.savePhoto` / `updatePhoto` cover most writes.
     Raw SQL that must bump too: the batched delete (`updateOwnRows`,
     `forgetParts`), the EXIF backfill, live-photo link repair, and the sync
     pre-pass that merges duplicate checksums. Bookkeeping columns
     (`exifChecked`, `checksumChecked`, `heicThumbChecked`, `purgedAt`) must
     NOT bump. D1 console edits can't bump; the operator knows.
2. **Retention: the worker keeps tombstones 90 days today**
   (`TOMBSTONE_TTL_DAYS` in `assets.ts`), so keep 90. For `reset`: when the
   purge deletes tombstones, store the highest `rev` it removed
   (`config.purgedThroughRev`); a `since` below it gets `reset: true`. The
   purge itself runs only from `/api/sync/stream` today (Immich-only), so v2
   needs another trigger. Mine: run it from the delete handler and the daily
   fleet nudge, never from `/changes`.
3. **Exposing thumb/preview file ids: fine.** `dc-manifest` already gives the
   owner every part's `file_id`, and the owner's client holds the bot token
   (`telegram-config`) and the key (`zke-config`). Columns: `telegramThumbId` +
   `thumbEncrypted`, `telegramPreviewId` + `previewEncrypted` (R2).
4. **Yes, the website moves to `/changes` in the joint phase.** Its timeline
   (`/api/timeline/buckets`, `/bucket`) loads every row per call today too, the
   same D1 read problem.

Also for §4/§5:
- **No `localDateTime` column exists** (only `fileCreatedAt`, UTC). Add one,
  set from EXIF `dateTimeOriginal` without a zone; null = fall back to `takenAt`.
- **`duration` is TEXT** (`"0:00:00.000"`); `durationMs` would be derived on
  read (`parseDurationSeconds`) or a new integer column.
- **Write budget:** `photos` has 7 indexes (2 partial), so one insert is about
  6–8 row writes. 100k/day caps backups at roughly 13–16k photos a day, which
  matches D24. A `rev` index adds one write to every change; keep bulk create
  to one D1 batch per request as proposed.
