# I2 + I3 — the app keeps only what the worker serves

**Tasks I2 and I3 of `docs/plan/ENGINE.md` §9,** done together (they touch
the same files). Written before the code (GATES.md, Gate 1). Decisions:
D28 (distinct from Apple's Photos — "Memories", "Featured Photos", "Shared
With You" go with their features), D30 (originals only; English + Russian),
the I0b requirements (Free Up hidden before any build reaches a phone), and
the operator's 2026-11-22 rule: **removed from v1, not dropped** — each
feature's code stays in git (HomeRoll `bd90811`, our history) and comes back
on the core (ENGINE.md §9, the Later list).

## Out

- **I2 — what the worker does not serve:** the Search tab and Siri search
  (smart search, suggestions, places, cities, text in photos); Memories (the
  player, export, notifications) and Featured Photos; People and pets (faces,
  merging, contact links); Folders; the Shared Library (partners); shared
  links and album comments; tags; smart albums; duplicates; HomeRoll's
  server add-ons (clean-up, relevant/sensitive search); Immich's realtime
  video transcoding (HLS); the server statistics call.
- **I3:** the photo and video editor (and the edited-copy route); stacks;
  date and location edits; Spotlight; **backup sends originals only** (no
  edited versions) and **tags nothing**; **Free Up removed** (it trusted the
  server — I0b); the backup prompt says "Phosphor", not a server address.

## Stays

The library (timeline), the viewer (photos, videos, Live Photos, on-device
Live Text and spatial scenes), albums (create, add, remove, rename, delete),
favorites, hidden and archive, the map, media types built from the worker's
filtered lists, Recently Deleted as it is (the real Trash is CONTRACT_V2
§5b), sharing files through the iOS share sheet, saving to the phone,
backup, settings.

## Tests (written first)

- **`apps/ios/tools/check-routes.sh`** (+ a self-test, in CI): every route
  the app calls is in `apps/ios/tools/v1-routes.txt`, the worker routes v1
  uses (each served, not a stub). It fails today on 35 routes (people,
  memories, search, tags, stacks, shared links, duplicates, the editor's,
  HLS, …) and must pass after.
- `check-identity.sh` still passes; the app builds with no new warnings.
- **Gate 2 (Simulator, test account):** `SignInTests` pass; the library,
  Collections (only kept sections), an album, the viewer (photo, video, Live
  Photo), favorite and unfavorite, the map, Backup's screen — each looked at
  in English and Russian; no German, no "Memories" / "Featured" / "Shared
  With You", no dead buttons.

## As built (2026-11-26/27)

- **The route check failed on 33 distinct routes (48 call sites)** at
  d16253c, not 35 (that count included search/metadata and trash/restore,
  later taken off the allowlist); it passes now.
- **Also removed** (each needed a route or feature v1 does not have): spatial
  scenes (the server clean-up add-on), saving a video frame or a Live
  Photo's video as a new item (it copied date and place — an edit), duplicate
  (`assets/copy`), trips (with Memories), album sort and the share sheet's
  "Unedited Original" (the worker ignores `order` and `edited`), the
  capture-time retries (the worker ignores `dateTimeOriginal`).
- **search/metadata is not served for v1:** the worker reads an older,
  flat request and ignored HomeRoll's `{"filter": …}` — every list was the
  whole library. Media types now come from the library on the phone; an
  album and Hidden from the worker's timeline filters (`albumId`,
  `visibility`).
- **Recently Deleted is gone** (the plan's Stays list contradicted D30): the
  worker refuses restore, so every delete is permanent behind the "cannot be
  undone" confirmation.
- **Hidden:** the worker's month route ignores `visibility`, so the app
  decodes the column and filters on the phone — the library and albums drop
  hidden photos, Hidden keeps only them; a photo hidden on the iPhone is set
  hidden after its upload (the upload ignores the field).
- **Found while testing:** the worker sends `duration` as text for some
  videos; the strict decoder blanked the whole month (880 photos, grey
  tiles). `Millis` reads a number or "H:MM:SS.mmm", in the month columns and
  the single-asset reply; a month whose columns disagree in length is
  refused instead of crashing. Unit tests in `apps/ios/Tests` (run at Gate 2;
  CI is Ubuntu-only).
- **Left for I11 (no route, no UI):** stack/partner/edited fields and the
  trash grid code; ~400 stale catalog strings.
- **Worker bugs sent to Linux (NOW.md):** duration as text, the search
  request shape, restore refused, the month route and the upload ignoring
  `visibility`, `dateTimeOriginal` and album `order` ignored.

## Gate 3

Two separate reviews: security (nothing removed weakens a check; Free Up
truly unreachable; backup sends originals only) and spec (this plan, D28,
D30, I0b, nothing kept that calls an unserved route).

**Then:** a release build on the operator's iPhone (the operator,
2026-11-26) — the I0b requirements are met once this lands.
