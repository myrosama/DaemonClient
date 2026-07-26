# Alternatives review

A check on the master plan for two failure modes: building something that
already exists, and taking on a dependency that costs more than it saves.

Everything below was verified against the code or against current
documentation. Where I could not verify something, I say so.

**Read this first — five things that are wrong, not just improvable:**

1. **Half of Task 3.2 has already been done.** The chunk body cache is checked
   before the file path is resolved — `assets.ts:2132-2134`, committed
   2026-04-27 in `4b40008`. That half of the task is a no-op.
2. **Task 3.2's other half would reintroduce a bug the code says was fixed.**
   Deriving `MAX_CHUNKS_PER_RESPONSE` from a 50-subrequest cap gives 7 chunks.
   The comment at `assets.ts:2188-2195` says a truncated 206 makes native
   players stop. Shortening the 206 is the wrong lever.
3. **Task 3.1 will count the wrong budget.** D1 is not on the 50-subrequest
   budget. Free-plan Workers get 50 *external* subrequests **and** 1,000
   subrequests to Cloudflare services. Counting D1 into the 50 makes the worker
   refuse work it can afford.
4. **Task 2.3 silently deletes the byte-path optimisation Phase 3 depends on.**
   The Photos service worker reads `botToken` from `/api/server/telegram-config`
   and `password`/`salt` from `/api/server/zke-config`. Both are what let the
   browser fetch and decrypt bytes without the worker touching them. Remove
   those fields and every web byte request falls back onto the worker path —
   the exact path Phase 3 is trying to fit inside its budget.
5. **`selfhost/src/config.mjs:save()` can destroy `STORAGE_KEY`.** It truncates
   in place with no temp file and no `fsync`. A crash mid-write loses the one
   value the file's own header says is unrecoverable. It also writes through a
   symlink, and `config.env` is not gitignored — in a repository that has
   already committed a `.env` once (`6468388`, still in history).

Details in the sections below.

---

## a. Worker efficiency (Phase 3)

**Current/planned approach:** `getChunk` (`immich-api-shim/src/assets.ts:2131`)
checks a Cache API entry for the decrypted chunk body, then calls
`tgDownloadFile` → `tgGetFileUrl` (`assets.ts:3108`), which checks an in-memory
path cache, then a Cache API path cache, then Telegram's `getFile`, writes the
path back to the edge cache, and finally downloads the bytes. The plan (3.1,
3.2) proposes one shared subrequest counter and a `MAX_CHUNKS_PER_RESPONSE`
derived from measured cost, plus "check the body cache before resolving the file
path".

### What Cloudflare actually counts

Verified against `developers.cloudflare.com/workers/platform/limits/` (via the
Cloudflare docs MCP, 2026-07-26):

> A subrequest is any request a Worker makes using the Fetch API or to
> Cloudflare services like R2, KV, or D1.

| Limit | Workers Free |
|---|---|
| Subrequests per invocation | **50** |
| Subrequests to internal services | **1,000** |
| Cache API calls per request | **50** — "shares the same quota as subrequests (`fetch()`)" |
| Simultaneous outgoing connections | **6** |

And from the February 2026 changelog announcing the paid-plan increase:

> Workers on the free plan remain limited to **50 external subrequests and 1,000
> subrequests to Cloudflare services** per invocation.

So: `fetch()` to Telegram and every `cache.match`/`cache.put`/`cache.delete`
come out of 50. **D1 comes out of 1,000.** These are different budgets.

The plan's cold-chunk figure of 6 is exactly right:

| # | Call | Line |
|---|---|---|
| 1 | `cache.match(chunk-cache/<file_id>)` | 2133 |
| 2 | `edgeCache.match(dc-tg-path/<file_id>)` | 3121 |
| 3 | `fetch(getFile)` | 3130 |
| 4 | `edgeCache.put(path)` | 3138 |
| 5 | `fetch(file download)` | 3149 |
| 6 | `cache.put(chunk body)` in `waitUntil` | 2146 |

`waitUntil` work counts against the same invocation, so #6 is real. Twenty
chunks is 120 against a cap of 50.

### Alternatives considered

- **Check the body cache before resolving the file path (the plan's fix)** —
  *already implemented.* `assets.ts:2132-2134` does exactly this, before
  `tgDownloadFile` is called, and has since commit `4b40008` (2026-04-27). A
  warm chunk already costs 1. This half of Task 3.2 has nothing left to do. The
  same idea *does* apply to `handleThumbnail`, which resolves config
  (`getCachedConfig`, line 1943) before its cache check at 1949 — worth moving,
  but it is a different function and it needs care (see below).

  (Task 3.4 is a separate case: `timeline.ts` has the one-job rotation in the
  working tree right now, uncommitted. Someone is implementing it in parallel.
  Check before starting it again.)
- **Lower `MAX_CHUNKS_PER_RESPONSE` from real cost (the plan's other fix)** —
  **reject.** `floor((50 - preamble) / 6)` is about 7 chunks, roughly 133 MB.
  The code comment at 2188-2195 says, in detail, that native players open with
  `bytes=0-` and treat a truncated 206 as end-of-file, which is why the old
  per-chunk caps made multi-chunk video play its first window and freeze. The
  comment at 2222 claims the opposite ("a seek reopens from there"). They cannot
  both be true, and the 2188 comment reads as the one written after debugging a
  real failure. Do not cut the response length until the cost per chunk is down.
- **Store Telegram's `file_path` in D1 next to the chunk record** — **take
  this.** `telegramChunks` is already a JSON array of `{index, file_id}` read
  out of the photo row that the request has already loaded. Adding `path`
  removes calls 2, 3 and 4 for zero extra subrequests, because the row read
  costs nothing new and D1 is on the 1,000 budget anyway. Cold chunk drops 6 → 3.
  Telegram's contract is "it is guaranteed that the link will be valid for at
  least 1 hour... when the link expires, a new one can be requested by calling
  getFile" — so a stored path is a cache, not a fact, and needs the same
  404/410 → re-`getFile` → rewrite fallback Task 3.7 already specifies. Fill it
  lazily on first read rather than at upload time, so the upload path takes no
  new cost. The write cost is one `UPDATE` per photo, not per chunk —
  `telegramChunks` is a single JSON column — against D1's free ceiling of
  100,000 rows written per day. Not close to binding.
- **Skip the body `cache.put` for tail chunks of a streamed response** — take
  this too, and it merges with Task 3.3. A 380 MB video's chunk 14 is not going
  to be re-requested at the same offset; caching it costs a subrequest, a 19 MB
  clone, and cache space. Cache chunk 0 (players re-read the header constantly)
  and skip the rest. Cold tail chunk drops 3 → 2, and with the body-cache read
  also skipped for tail chunks, → 1.

  Combined: 20 chunks ≈ 1 (chunk 0 read) + 1 (chunk 0 write) + 19 + preamble ≈
  25 of 50. `MAX_CHUNKS_PER_RESPONSE = 20` becomes affordable and the 206 stays
  full length. This is a better outcome than the plan's.
- **`fetch(tgUrl, { cf: { cacheEverything: true, cacheTtl: 86400 } })` instead of
  the Cache API for bodies** — **reject, on CPU.** It would collapse
  match+fetch+put into one subrequest. But it caches the *ciphertext*, so every
  hit re-runs AES-GCM over 19 MB inside a 10 ms CPU budget. Today's Cache API
  entry holds plaintext, so a hit skips decryption entirely. Error 1102 is a
  resource-limit kill and CPU is one of those resources — this trade would move
  the failure, not remove it. (Also note the docs' caveat that cache-key
  overrides only apply "within your own zone, or requests to hosts that are not
  on Cloudflare", and `cacheKey` is Enterprise-only regardless.)
- **Workers Caching (`"cache": { "enabled": true }`)** — **investigate, do not
  adopt yet.** Shipped 2026-07-06, three weeks ago. It is a read-through cache
  *in front of* the Worker: a hit returns without running the Worker at all, so
  zero subrequests and zero CPU. Available on every plan, works on
  `workers.dev`, one config line. Two things block it here:
  - Requests carrying `Authorization` are automatically bypassed, and every byte
    request carries one (`helpers.ts:6-13` reads `Authorization: Bearer` or the
    `immich_access_token`/`__session` cookie). Stripping the header to get a
    cache hit means the cached response is keyed on path only — an
    unauthenticated request for a known asset UUID would then be served bytes.
    That is a straight security regression for a project whose first principle
    is security.
  - The Worker version is part of the cache key by default, so every deploy
    empties the cache. Per-user workers get redeployed often.

  Worth revisiting once it has a year on it and once there is a signed-URL
  scheme for media (which would give it a safe cache key). Not now.
- **Redirect the player straight to `api.telegram.org`** — **reject,
  permanently.** The download URL embeds the bot token. Handing that to a client
  hands over the whole channel. Write this down somewhere permanent so nobody
  re-proposes it.
- **One HTTP request per chunk, letting the client stitch** — already how the
  web works (`/api/assets/:id/dc-manifest` + the service worker at
  `immich/web/src/service-worker/index.ts`), and it is the right shape, because
  each request is a separate invocation with its own 50. It cannot be extended
  to native video playback: ExoPlayer and AVPlayer want one URL that answers
  Range, so the worker has to stitch for video. Keep both paths.

### Measure this before doing any of it

Every worker in this project — hosted and self-hosted — runs on
`*.workers.dev`. `deployment-service/src/index.ts:387` builds
`https://${workerName}.${subdomain}.workers.dev`, and the self-host CLI design
registers a `workers.dev` subdomain at Step 5. Nothing has a custom domain.

Cloudflare's Cache API page says:

> Workers deployed to custom domains have access to functional `cache`
> operations. So do Pages functions, whether attached to custom domains or
> `*.pages.dev` domains. However, any Cache API operations in the Cloudflare
> Workers dashboard editor and Playground previews will have no impact.

It names custom domains and Pages as working, and names two places as no-ops.
It does not say which side `workers.dev` falls on. Older versions of that note
listed `workers.dev` as a no-op — the restriction was that the cache was
zone-scoped and `workers.dev` has no zone. The note has since been reworded, and
the new Workers Caching product explicitly does work on `workers.dev`, which
suggests the old restriction is gone. Suggests. I could not confirm it.

This is worth thirty minutes before any of Phase 3 is written, because if the
Cache API is a no-op on `workers.dev`:

- every chunk is permanently cold for every user, hosted and self-hosted;
- three of the six subrequests are being spent on caches that never hit;
- the cost model the whole phase is built on is wrong.

The test: deploy a throwaway worker to `workers.dev` that does `cache.put` on
one request and `cache.match` on the next, and report whether it hits. If it
misses, storing `file_path` in D1 stops being an optimisation and becomes the
only thing keeping a multi-chunk video inside 50 subrequests — and putting the
worker behind a custom domain moves from cosmetic ("prettier worker URLs") to
load-bearing.

### The Phase 2 / Phase 3 collision

`/api/server/telegram-config` returns `botToken` (`server.ts:105`).
`/api/server/zke-config` returns `password` and `salt` (`server.ts:81-83`). The
Photos service worker reads both — `K()` fetches the telegram config for the bot
token and proxy URL, `q()` derives the AES key from password and salt, and
`X()` fetches and decrypts chunks straight from Telegram. That is the mechanism
that keeps the worker off the byte path for web users.

Task 2.3 removes those fields. When it lands:

- every web byte request falls back to the worker path;
- `/proxy` becomes unusable, because callers construct the Telegram URL
  themselves and can no longer know the token;
- Phase 3's budget problem gets several times worse on the same day.

The task text says to "check the web apps and Drive for readers first". The
readers exist and they are load-bearing. Task 2.3 needs a replacement mechanism
designed before it ships — most likely a short-lived per-asset signed URL issued
by the worker that `/proxy` validates, so the client can still pull bytes
without ever holding the bot token. That is real design work, not a field
deletion.

Separately: `/proxy` (`index.ts:182-217`) has no authentication at all. It is
restricted to `*.telegram.org`, so it is not an open proxy, but anyone holding
the bot token can use any user's worker as a relay and burn their request quota.

### The thumbnail path, which the plan does not cost at all

A cold grid thumbnail costs the same 6, plus the row read and the config read.
Warm, it costs 3: `loadPhotoById`, `getCachedConfig`, then `cache.match` at
line 1949. The two reads before the cache check are wasted on every hit, and a
timeline scroll is hundreds of these.

Moving `cache.match` above `loadPhotoById` would make a warm thumbnail cost 1 —
**but only if the uid goes into the cache key at the same time.** The key today
is the bare `request.url` (line 1948), and the only thing stopping one user
reading another's thumbnail by URL is that `loadPhotoById` scopes the lookup by
uid and runs first. Reorder without re-keying and that protection is gone on the
central worker, where several users share one cache. Per-user workers would not
notice; the central one would leak.

So: reorder and re-key together, or not at all. Worth its own task in Phase 3
rather than a line in someone else's.

### Two smaller things found while reading

- `getTgQueue` builds `new RequestQueue(10)` (`assets.ts:3206`) but Cloudflare
  caps simultaneous outgoing connections at 6 on both plans. Slots 7-10 do
  nothing except make the queue's own accounting misleading.
- `tgGetFileUrl`'s L2 hit re-stamps L1 with a full fresh TTL regardless of the
  entry's age — the plan already catches this as Task 3.7, and the fix is right.

**Recommendation:** CHANGE Task 3.1 and Task 3.2.

- 3.1: count **two** budgets, not one. `external` (fetch + Cache API, cap 50)
  and `internal` (D1, cap 1,000). A single counter will refuse affordable work.
- 3.2: drop "check the body cache first" — done. Replace "derive
  `MAX_CHUNKS_PER_RESPONSE` from cost" with "reduce the cost": store `file_path`
  in the chunk record, and stop caching tail chunk bodies. Keep the 20-chunk
  ceiling. Only shorten the 206 if measurement shows it is still needed, and
  only after settling which of the two contradictory comments is true.
- Add a task: design the replacement for what 2.3 removes, before 2.3 ships.

**Why:** the plan's diagnosis is correct and its arithmetic is correct. Its
prescription treats the symptom (fewer chunks per response) instead of the cause
(six subrequests to move one chunk), and the symptom treatment collides with a
mobile playback bug someone already spent time fixing.

**Evidence:** read `immich-api-shim/src/assets.ts` (2088-2320, 3080-3210),
`src/index.ts`, `src/server.ts:55-110`, `src/helpers.ts:1-120`,
`src/asset-manifest.ts`, `immich/web/src/service-worker/index.ts` and the built
`immich/web/.svelte-kit/output/client/service-worker.js`. Cloudflare limits and
Cache API semantics from `developers.cloudflare.com/workers/platform/limits/`,
`/workers/runtime-apis/cache/`, `/workers/cache/`, `/workers/cache/limitations/`,
`/workers/examples/cache-using-fetch/` and the 2026-02-11 subrequest changelog.
Workers Caching details from `blog.cloudflare.com/workers-cache/` (2026-07-06).
Telegram file-link validity from the Bot API `getFile` documentation.

---

## b. Video thumbnails

**Current/planned approach:** the plan states there is no solution. There is.
Two, in fact, and both are already in the tree.

**What already exists:**

- `immich/web/src/lib/utils/video-poster.ts` — 89 lines. Creates an
  `HTMLVideoElement`, seeks to 0.1 s, draws to a canvas, `toBlob` as JPEG.
  Handles the iOS `playsinline` requirement explicitly. No dependency, no WASM,
  uses the browser's own hardware decoder.
- `immich/web/src/lib/utils/video-backfill.ts` — walks videos with no thumbnail,
  extracts a poster, computes a ThumbHash, and POSTs both to
  `/api/assets/:id/thumbnail`. Wired to a "Fix video thumbnails" utility
  (`FixVideoThumbnailsModal.svelte`).
- `immich/mobile/lib/services/background_upload.service.dart:266-303` —
  after each upload, calls `entity.thumbnailDataWithSize(ThumbnailSize(256,256))`
  and POSTs it. `photo_manager`'s `AssetEntity` returns a poster frame for video
  assets, produced by MediaStore on Android and PHImageManager on iOS. Free,
  hardware-decoded, already correct for HEVC.
- The receiving endpoint, `handleThumbnailUpload` (`assets.ts` ~1800-1888),
  already stores the thumb the same zero-knowledge way as every other thumb.

So the pipeline is complete. What is missing is only a decision about the
fallback and a backfill for the mobile side.

**Alternatives considered:**

- **ffmpeg.wasm on the server** — reject. ~30 MB core. Will not fit a Vercel
  Edge function; on a Node serverless function the cold start is unacceptable
  for a thumbnail. Nothing about the worker helps: it holds one 19 MB chunk, but
  the `moov` atom is frequently at the end of a phone-recorded file, so the
  first chunk is often not enough on its own.
- **Parse the container for the first keyframe in the worker** — reject.
  Locating the first sync sample from `moov/trak/stbl/stss` is easy. Turning
  that access unit into pixels needs a full H.264 or HEVC decoder. There is no
  small one: Broadway.js is Baseline-only and phone video is High profile or
  HEVC; `libde265` and `openh264` are neither small nor fast enough for a 10 ms
  CPU budget. WebCodecs `VideoDecoder` would solve it and exists in no
  server-side runtime here.
- **Reuse `libheif-js` in the processor to decode an HEVC I-frame** — reject.
  It is technically adjacent (HEIC is HEVC in a container) but would mean
  hand-assembling an HEIF item around an extracted access unit. Enormous
  fiddliness for a case the client already handles.
- **`video-poster-ffmpeg.ts` (the existing client fallback)** — keep the
  capability, **change how it loads.** It `import()`s
  `https://esm.sh/@ffmpeg/ffmpeg@0.12.15` and pulls the core from
  `unpkg.com` at runtime. The page holding that code also holds the user's
  decryption key and, today, the bot token. Two third-party CDNs get arbitrary
  code execution in that context. For a project that says a self-hosted install
  depends on nothing the operator runs, depending on esm.sh and unpkg is worse,
  not better — nobody at all is accountable for those. Vendor the files into the
  build, or add SRI, or drop the fallback.

**Recommendation:** CHANGE — remove "no solution for video posters" from the
plan and replace it with three small tasks.

1. Make sure the mobile `_uploadThumbnail` path runs for video uploads, and add
   a test. This is where new videos get their poster.
2. Add a backfill for videos already stored without one. The web tool exists;
   confirm it covers server-encrypted videos and say so in the docs.
3. Vendor or pin-with-SRI the ffmpeg.wasm fallback, or delete it. Runtime
   `import()` from a public CDN does not belong in a page that holds key
   material.

**Why:** the expensive part of this problem — decoding video — is already done
for free by hardware on the device that took the video. Every server-side option
is worse than the one already shipped. The only genuine gap is the supply chain
of the fallback path.

**Evidence:** read `immich/web/src/lib/utils/video-poster.ts`,
`video-poster-ffmpeg.ts`, `video-backfill.ts`;
`immich/mobile/lib/services/background_upload.service.dart:215, 266-303`;
`immich-api-shim/src/assets.ts:1800-1888` (`handleThumbnailUpload`) and
`1919-1941` (the 404 guard the plan's Task 3.6 extends);
`processor/api/convert.js`.

---

## c. Documentation site (Task 6.2)

**Current/planned approach:** a new `docs-site/`, static, on Cloudflare Pages,
rendering the markdown already in `docs/`, in the shape of Cloudflare's own
docs. Generator unchosen — it is open question 3 in the plan.

### What Cloudflare's docs are actually built with

`github.com/cloudflare/cloudflare-docs`, branch `production`, read directly:

- `package.json` → `"astro": "^7.0.2"`. It is an Astro site.
- Search is `@docsearch/js` + `@docsearch/css` — Algolia DocSearch, a hosted
  service.
- `astro.config.ts` imports `@cloudflare/nimbus-docs`, their own in-house docs
  framework (public on npm at 0.8.2).

But read the comments in that config. They say things like *"mirrors CF's
`autogenSections` in the Starlight config"*, *"Starlight ships a native `seti:`
file-icon set"*, and *"...differs from Starlight's — a parity item for the
parity gate"*. Cloudflare's docs were built on **Astro Starlight**, and Nimbus
is the successor they are still measuring against it.

So the look the operator likes is, quite literally, the Starlight look with
Cloudflare's content in it. That settles most of the question.

### Alternatives considered

- **Astro Starlight** — closest to the target by construction, and it ships the
  three specific things asked for. One-line verdict: this is the one.
- **VitePress** — genuinely good, lighter, faster builds, has left nav, right
  ToC, local search and copy buttons. But the nav is hand-maintained in config
  rather than generated from the file tree, and it looks like Vue's docs, not
  Cloudflare's. Strong runner-up.
- **Docusaurus** — heaviest of the three, React at runtime, most configuration
  surface, and the result looks like Docusaurus. No.
- **mdBook** — would add a Rust toolchain to a repository that has no Rust. No
  right-hand contents rail by default. Search is there but the typography is not
  close. No.
- **Nextra** — couples the docs site to Next.js, which then needs an adapter to
  reach Cloudflare Pages. Most machinery for least gain here. No.
- **Plain Eleventy** — you would hand-build the nav tree, the contents rail, the
  search index and the copy buttons. That is precisely the reinvention this
  review exists to catch. No.
- **Material for MkDocs** — very close on look and famously low-maintenance, but
  it puts Python in the build. Worth a mention only because it is the one option
  outside the JS world that genuinely competes.
- **Mintlify** — hosted product. Fails "static files, free, Cloudflare Pages".
  No.
- **`@cloudflare/nimbus-docs`** — 0.8.2, built around Cloudflare's own content
  model, no outside users to speak of. Tempting because it is *the* answer to
  "what does Cloudflare use", and wrong for the same reason. No.

### Starlight, checked against the actual requirements

Read from `@astrojs/starlight@0.41.4`'s dependency list on the npm registry:

| Requirement | How Starlight answers it |
|---|---|
| Left nav tree | Built in, and it can autogenerate from the directory structure |
| Right-hand contents rail | Built in, on by default |
| Code blocks with copy buttons | `astro-expressive-code`, a direct dependency |
| Search, no external service | `pagefind` + `@pagefind/default-ui`, direct dependencies. A static index built at build time. No Algolia account, nothing to sign up for, nothing to pay. |
| Static output | `astro build` → `dist/`. Cloudflare Pages serves it. |
| Dense, calm typography | Its default. It is where Cloudflare's came from. |

Two things to plan for:

- **Frontmatter.** Starlight requires a `title` in each page's frontmatter.
  Every file in `docs/` today starts with a bare `# Heading` and has none
  (checked: only `docs/SKILL.md` has frontmatter). Adding it is a one-line
  change per published file — and it is the right change anyway, because nav
  labels and ordering should be stated, not guessed at from an H1.
- **Files outside the site directory.** Astro content collections take a
  `loader`, and the built-in `glob()` loader — quoting the Astro docs —
  *"fetches entries from directories of Markdown, MDX, Markdoc, JSON, YAML, or
  TOML files **from anywhere on the filesystem**"*, taking a `pattern` and a
  `base`. So `glob({ pattern: '**/*.md', base: '../docs' })` reads `docs/` in
  place. With Starlight specifically this means overriding the `docs`
  collection's loader with `glob()` instead of the default `docsLoader()`, and
  declaring the extra directory so Starlight's markdown pipeline processes it.
  Documented mechanism, not a workaround — but budget an hour for the wiring,
  and check `withastro/starlight` discussion #1257 first.

The honest cost: Starlight is still on **0.41.x**. It has been pre-1.0 for
years, and minor bumps carry breaking changes. Pin exact versions, and expect to
spend an afternoon on it once or twice a year. That is the price of the only
option that gives the requested look with no custom CSS.

### One scoping problem the task does not name

"Source of truth stays the markdown in `docs/` — the site renders it" cannot
mean *all* of `docs/`. Right now that tree holds `plan/`, `plan/review/`,
`roadmap/` and `superpowers/` — internal planning, a principles review, and a
798-line security review that names unfixed exploitable holes by file and line.

Publishing those is not the intent, so Task 6.2 needs an explicit list of what
the site renders — Getting started, Self-hosting, Architecture, API reference,
Contributing, Security — and everything else stays out of the glob.

Worth saying separately: `docs/plan/review/SECURITY_REVIEW.md` is already in a
public repository, describing holes that are still open. A docs site would make
that worse, but it is a problem today, before any site exists. That is the
operator's call, not mine, but it should be a deliberate call.

**Recommendation:** CHANGE TO Astro Starlight (the plan leaves it open;
this closes it).

**Why:** every other option means either building the requested layout by hand
or accepting a layout that is recognisably someone else's. Starlight gives the
exact look with no custom CSS, and it brings local search and code-copy buttons
as ordinary dependencies rather than as separate integrations to wire up. The
cost is a 0.x dependency that will break on upgrade — real, but bounded and
predictable, and cheaper than any of the alternatives.

If the 0.x versioning is a dealbreaker, take VitePress and accept that the site
will look like VitePress.

**Evidence:** fetched and read `package.json` and `astro.config.ts` from
`raw.githubusercontent.com/cloudflare/cloudflare-docs/production`; queried the
npm registry for `@astrojs/starlight/latest` (0.41.4, dependency list quoted
above) and `@cloudflare/nimbus-docs` (0.8.2). Read
`docs.astro.build/en/guides/content-collections/` for the `glob()` loader
contract. Surveyed the local `docs/` tree with `find`/`head -1` on all 35
markdown files to check for frontmatter — only `docs/SKILL.md` has any.

---

## d. Setup UX (Phase 4)

**Current/planned approach:** an interactive CLI, `daemonclient setup`, run after
`git clone`. Today it is a seven-step machine with `markDone`/`isDone` and a
state file (`setup.mjs:31-52`); Task 4.3 replaces that with
`probe()`/`repair()`/`verify()` per subsystem, and Task 4.4 makes `doctor` the
same code path with repair disabled.

### Is the interactive CLI the right shape?

Yes, for this product, and the reason is specific rather than general.

Compare what the alternatives assume. A generated config file plus a
non-interactive apply — the Terraform shape — assumes the user can fill the file
in. Here they cannot: the values are a Telegram bot token they have to get from
BotFather, a Cloudflare account id they have never seen, a D1 uuid that does not
exist yet, and a Firebase API key that is created as a side effect of creating a
project. Most of the config is *output*, not input. A file-first flow would be a
file with four blanks and eleven "leave this alone" comments.

A local web wizard is the Nextcloud/Gitea shape, and it is genuinely good when
the software is already running and serving HTTP. Here nothing is running yet —
that is what setup is for — so it would mean shipping a second HTTP server whose
only job is to bootstrap the first one, and the headless case gets *worse*, not
better: a terminal works over SSH, a browser on `localhost:3000` does not.

So: keep the interactive CLI. But it needs the things interactive CLIs are
routinely criticised for missing.

### What the plan should steal

**1. Detect a non-TTY and say so, rather than hanging.** The single most
common complaint about setup wizards is that they block on a machine with no
terminal — a VPS over SSH, a CI job, a container. The fix everyone converges on
is the same: check `process.stdin.isatty()` up front and, when it is false,
print what to set and exit non-zero instead of waiting forever. Task 4.8 already
covers the headless *browser* case for Cloudflare sign-in; extend it to headless
*stdin*, which is the more common one.

**2. A real non-interactive mode.** Every value the CLI prompts for should be
settable in `config.env` or an environment variable, and `--non-interactive`
(or `--yes`) should run through with what is there and fail loudly on what is
missing — naming every missing key at once, not one per run. This falls out of
Task 4.3's probe/repair/verify almost for free: `--no-repair` is already the
`doctor` mode, so `--non-interactive` is "repair only from config, never
prompt". Three modes over one implementation.

**3. Show what will be created before creating it.** Setup creates real
resources in three third-party accounts: a Cloudflare Worker, a D1 database, a
Pages project, a GCP project, a Firebase app, a Vercel project. The user should
see that list, with the names, before the first `POST`. A `--dry-run` that runs
every `probe()` and prints the plan — this exists, this will be created, this
will be changed — costs almost nothing once probe/repair/verify is in place,
and it is the difference between a tool people trust on their own account and
one they run in a VM first.

**4. A teardown command.** There is none today (`bin/daemonclient.mjs` has
`setup`, `status`, `update`, `dashboard`, `processor`, `doctor`). Setup can
half-fail — it currently `process.exit(1)`s mid-Cloudflare-step in two places
(`setup.mjs:250, 268`) after having already created a D1 database. The user is
then left with orphaned resources in an account they may not know how to
navigate, and no way to start clean. `daemonclient destroy` should list what it
found and what it will delete, require confirmation, and refuse to touch
anything it did not create. This also makes Task 5.1 (a real run against
throwaway accounts) repeatable instead of a one-shot.

**5. Say the third-party account cost up front.** Before the first prompt:
"this will create accounts or resources on Telegram, Cloudflare, Google/Firebase
and (optionally) Vercel; all on free tiers; here is what each one is for."
People abandon installers at the point where a new signup appears without
warning.

**6. Keep the state file dead, and mean it.** The current model prints *"Found a
previous run — completed steps will be skipped"* (`setup.mjs:39-41`). That is
the wrong promise: a step that succeeded in March and broke in June is never
re-checked, so `setup` stops being able to fix anything. Task 4.3's probe/verify
model is the right replacement precisely because re-running becomes a health
check rather than a resume. Make sure the migration deletes the old state file
rather than leaving it to confuse the next run.

### Two smaller things in the current code

- `splitSql()` (`setup.mjs:286-294`) splits the migration on bare `;`. The SQL
  is ours so it works today, but it will break silently the first time someone
  adds a trigger or a string containing a semicolon. Worth a comment saying so,
  at least.
- The Cloudflare step still walks the user through creating a custom API token
  by hand (`setup.mjs:192-199`) — four dashboard steps and three permission
  names. The design's move to `wrangler login` removes all of it. That is the
  single biggest UX win in Phase 4 and it is worth doing early.

**Recommendation:** KEEP AS PLANNED — the interactive CLI is the right shape.
ADD four things the plan does not currently have: non-TTY detection,
`--non-interactive`, `--dry-run`, and `destroy`.

**Why:** the shape is right because most of this configuration is generated
rather than supplied, and because a terminal survives SSH where a browser does
not. What interactive setup tools reliably get wrong is everything around the
happy path — the headless case, the half-failure, and the "what is this about to
do to my account" question. All four additions are cheap on top of
probe/repair/verify, and expensive to retrofit later.

**Evidence:** read `selfhost/bin/daemonclient.mjs`,
`selfhost/src/commands/setup.mjs` (full flow, and the Cloudflare step at
183-290), `selfhost/src/state.mjs`, and `docs/roadmap/SELFHOST_CLI_DESIGN.md`.
Compared against how Immich (compose + `.env`), Nextcloud and Gitea (first-run
web wizard) and Terraform (`plan`/`apply`/`destroy`) handle the same problems.
Immich's own installation docs and discussions
([#13842](https://github.com/immich-app/immich/discussions/13842),
[#19638](https://github.com/immich-app/immich/discussions/19638)) show the
file-first failure mode: the complaints are about a config the user is expected
to understand and adapt, which is exactly what this CLI avoids.

---

## e. Secret storage

**Current/planned approach:** `~/.config/daemonclient/config.env`, directory
0700, file 0600, dotenv format, written with
`fs.openSync(file, 'w', 0o600)` and then `chmodSync` (`config.mjs:150-188`).
Secrets marked in a `KEYS` table and redacted by `redact()`.

### What comparable CLIs actually do — measured, not recalled

`stat -c '%a %n'` on the credential files physically present on this machine
(umask `0002`; no secret values were read):

| CLI | Path | Mode |
|---|---|---|
| **wrangler 4.85** | `~/.config/.wrangler/config/default.toml` | **664** |
| **Vercel** | `~/.local/share/com.vercel.cli/config.json` | **664** |
| **firebase-tools** | `~/.config/configstore/firebase-tools.json` | 600 |
| **GitHub CLI** | `~/.config/gh/hosts.yml` | 600 |

And from the installed source, `node_modules/wrangler/wrangler-dist/cli.js`
around line 132422:

```js
fs29.mkdirSync(path3.dirname(configPath), { recursive: true });   // no mode
fs29.writeFileSync(path3.join(configPath), toml.stringify(config)); // no mode
```

No mode on either call, so it lands at `0666 & ~umask`. On a machine with the
common `umask 022` that is **644 — world-readable — holding the live Cloudflare
OAuth refresh token.** The same token `selfhost/src/api/cloudflare.mjs:116-130`
reads and uses as bearer for every REST call.

Read from upstream source and docs: doctl, flyctl, AWS CLI, gcloud, Docker on
Linux and npm all write a plain 0600 file and stop. Google states the threat
model outright — *"Any user with access to your file system can use the stored
access credentials created by `gcloud auth login`."* flyctl has no keyring code
at all. Docker's credential helpers are opt-in; plain docker-ce on Linux stores
base64, not encryption, forever.

The three exceptions are instructive, and none of them is a zero-dependency
Node CLI:

- **gh** (Go, statically linked, pure-Go D-Bus) falls back to a plaintext file
  silently when no keyring is available — which has generated
  [cli#10108](https://github.com/cli/cli/issues/10108),
  [cli#8954](https://github.com/cli/cli/issues/8954) and a keyring race,
  [cli#8802](https://github.com/cli/cli/issues/8802).
- **Stripe** hedges — live keys to the keyring, `sk_test_…` left in plaintext
  TOML.
- **Heroku** moved to the keychain in v11.8.0, *last month*, by shelling out to
  `security` / `secret-tool` / PasswordVault. Their own announcement lists the
  bill: *"You may need to install the `secret-tool` package"*, headless Linux
  falls back to `.netrc` anyway, and they had to build a git credential helper
  because taking the token out of `~/.netrc` broke `git push heroku`.

Note the symmetry with this stack: **Cloudflare, Firebase and Vercel — the three
services this CLI orchestrates — all chose a file, and two of the three chose a
world-readable one.**

### Alternatives considered

- **OS keychain via npm** (`keytar`, `@napi-rs/keyring`) — reject. `keytar` was
  archived in December 2022 with prebuilds only up to the Node 17 N-API ABI; on
  Node 20/22 it needs Python and a C++ toolchain to install. That alone ends
  "runs from a fresh clone".
- **OS keychain by shelling out** — reject, and the reason is concrete. On this
  machine — a full GNOME desktop with `gnome-keyring-daemon` running, `libsecret`
  present, `DBUS_SESSION_BUS_ADDRESS` and `DISPLAY` both set — **`secret-tool` is
  not installed.** It lives in `libsecret-tools`, which is in `universe` and not
  in the default install on Ubuntu or Fedora. So Heroku's Linux keychain path
  degrades to a file on a stock desktop, and this is the *best* case.

  The obvious workaround does not exist either: `dbus-send` can read the Secret
  Service but cannot write to it — `CreateItem` needs `a{sv}` and `(oayays)`, and
  `dbus-send` cannot express a variant. There is no zero-dependency way to store
  a secret in the Linux keyring. Windows has no built-in Credential Manager
  cmdlet; `CredentialManager` is a PSGallery module.
- **Encrypt the file with a passphrase at rest** — reject as the default. It
  turns every `daemonclient status` into a password prompt and breaks CI. Worth
  having as an explicit `config --export` (below), not as the storage format.
- **Everything in the user's D1** — already correctly rejected in the design
  (point 6). Bootstrap secrets cannot live behind the thing they bootstrap.

### What the keychain would actually protect against

Against the same-user attacker: **nothing.**

On Linux the Secret Service has no application isolation — any process running
as the user reads everything from an unlocked keyring over D-Bus. That is
CVE-2018-19358, which GNOME disputed and closed WONTFIX. It was demonstrated
here: an ordinary process enumerated `gh`'s stored item paths with no prompt.

On macOS, storing via `/usr/bin/security` grants that binary unfettered access
to the item without prompting — so anything running as the user can read it back
by shelling out to `security`. The one route open to a zero-dependency CLI is
precisely the route that discards the protection.

What a keychain genuinely buys is at-rest encryption while the machine is off or
the keyring is locked. Full-disk encryption covers that better, for every file,
with no CLI code.

Rank the real risks here and the case collapses: (1) the secret gets committed
to git, (2) it gets pasted into an issue, (3) it leaks through argv or a log,
(4) the file mode is wrong, (5) much later, cold-disk theft. A keychain
addresses only #5.

Worth noting on #3: `/proc/<pid>/cmdline` is mode **444** — argv is readable by
*every user on the box*, strictly worse than a 0600 file, while
`/proc/<pid>/environ` is 400. The design's rule of piping secrets to
`wrangler secret put` over stdin rather than argv is more load-bearing than it
looks. Keep it.

### Backup and portability — where the file wins outright

Measured round-trips of a 0600 file:

```
cp / cp -p / tar / zip / rsync / rsync -a   →  600   (all preserve)
cat config.env > backup.env                 →  644   ← widens
git add + git checkout                      →  644   ← widens
```

Every real backup tool preserves 0600. But **`cat >` widens to 644**, and so
does a git round-trip — git tracks only the exec bit. "Back it up in a private
git repo", which is exactly what people will do, hands them a world-readable
config on the new machine. The file header says losing `STORAGE_KEY` loses every
file in the channel, so this warning has to be in the header itself.

A keychain has no export path at all: macOS items are not portable, Secret
Service has no supported export, Credential Manager is DPAPI-bound to
user+machine. You would end up writing an `export` that decrypts to a plaintext
file — reinventing the file with extra steps.

### Hardening the plan should add

Node semantics, measured rather than assumed:

| Behaviour | Result |
|---|---|
| `openSync(f,'w',0o600)` under umask 002 / 077 | 600 / 600 — umask can only remove bits |
| `openSync(f,'w',0o600)` over an **existing 0644 file** | **644 — the mode is not reset** |
| `rename(tmp → dst)` | dst inherits the **source's** mode — so temp-at-0600 + rename is safe |
| `mkdirSync(d,{recursive,mode:0o700})` on an existing 0755 dir | **755 — not tightened** |
| `openSync` on a symlink | **follows it and truncates the target** |

Five things follow, all verified against `config.mjs`:

1. **`save()` is not atomic** (`config.mjs:184-186`). Crash, full disk or Ctrl-C
   mid-write truncates the config, and there is no `fsync`, so a power loss can
   leave it zero-length. The file's own header says that loses every stored
   file. **This is the highest-severity item in this whole review and it has
   nothing to do with keychains.** Write to a temp file in the same directory
   with `O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0600, `fchmod` the fd (that is what
   makes it umask-proof), `fsync`, then `rename` — which is atomic and carries
   the 0600 across. `fsync` the directory too. This is the same shape
   `write-file-atomic` uses for firebase-tools, the one CLI in the survey that
   gets this fully right.
2. **`save()` writes through a symlink.** Confirmed. The realistic case is not
   an attacker, it is `ln -s ~/dotfiles/dc.env ~/.config/daemonclient/config.env`
   — which, combined with the git-644 finding above, puts live secrets in a repo
   at 644. `lstat` and refuse.
3. **Write-then-chmod, for the case that matters.** R1 says "never
   write-then-chmod", but `openSync(...,0o600)` does not reset an existing
   file's mode, so a pre-existing 0644 config holds the new secrets at 0644
   until line 186 lands. The atomic rewrite in (1) fixes this too.
4. **`$DAEMONCLIENT_CONFIG` silently re-permissions the user's directory.**
   `configDir()` returns `dirname($DAEMONCLIENT_CONFIG)` and line 153 chmods it
   unconditionally — confirmed turning a `~/backups` at 755 into 700. Only
   tighten a directory the CLI created; otherwise check and warn.
5. **`checkPermissions()` only stats the file**, never the directory, never
   `lstat`s for a symlink, and never looks for `config.env~`, `.swp` or `.tmp`
   leftovers. All three belong in `doctor`.

Repo-level, and not hypothetical:

6. **`config.env` is not gitignored.** `git check-ignore config.env` exits 1.
   `.gitignore` has `.env` and `.env.*`, which do not match. There is already a
   test at `selfhost/test/selfhost.test.mjs:101` asserting the *state* filename
   is ignored; the mirror test for `config.env` would fail today.
7. **A `.env` was already committed to this public repository.** Verified:
   added in `6468388` ("Add files via upload", a GitHub web upload), deleted the
   same day in `a24c38a`, still reachable in history. This is the exact leak
   class R1 exists to prevent, and it has already happened here once. It also
   matches the outstanding owner TODO about scrubbing history and revoking the
   leaked Firebase key.
8. **A `.env` exists at the repo root right now, mode 664** — the condition
   Task 4.2 detects. The rule is correct and load-bearing; it can be tested
   against a real case today.

Two more, cheap:

9. **Warn about wrangler's token mode.** `doctor` already knows the path
   (`cloudflare.mjs:116`). One line — *"wrangler stored your Cloudflare token at
   mode 664; run `chmod 600`"* — protects the credential that matters more than
   anything DaemonClient writes. Fold into Task 4.2.
10. **`quote()` and `parseEnv` do not round-trip backslashes.** `quote()`
    (`config.mjs:190`) uses `JSON.stringify`, which escapes `\` as `\\`;
    `parseEnv` only un-escapes `\n` and `\"` (`config.mjs:106`). Latent today
    because no key holds a path. It will be a confusing afternoon the day one
    does.

And one addition worth making: **`daemonclient config --export`**, writing a
passphrase-encrypted blob with `node:crypto` scrypt + AES-256-GCM. Zero
dependencies, and it is the feature a keychain pretends to be, done portably —
which matters because `STORAGE_KEY` cannot be regenerated.

**Recommendation:** KEEP AS PLANNED — 0600 file at
`~/.config/daemonclient/config.env` — with items 1-10 added to Phase 4.

**Why:** the keychain protects against a threat that, on the platforms
self-hosters actually use, it does not in fact protect against; it cannot be
reached at all without either a dead native module or a binary that is missing
from a stock Ubuntu desktop; and it removes the backup story for a key that
cannot be regenerated. Meanwhile the file has two real bugs — non-atomic write
and symlink-follow — and is not gitignored, in a repository that has already
leaked a `.env` once. That is where the effort belongs.

**Evidence:** read `selfhost/src/config.mjs`, `env.mjs`, `api/cloudflare.mjs`,
`ui.mjs`, `test/selfhost.test.mjs`, `.gitignore`,
`node_modules/wrangler/wrangler-dist/cli.js`, and the installed
`firebase-tools`/`configstore`/`write-file-atomic` sources. Ran `umask`,
`stat`/`find -printf '%m'` on credential paths, `apt-cache policy
libsecret-tools`, `dbus-send` (session open and `SearchItems` only — no
`GetSecret`), `git check-ignore config.env`, `git log --diff-filter=A -- .env`,
and Node scripts measuring mode/umask/rename/symlink/backup semantics. Nothing
was logged into, deployed or mutated; no secret values were printed.

---

## f. Reinvented wheels, both directions

### Things that look reinvented but should stay

- **`immich-api-shim/src/sha1.ts`** — KEEP. `crypto.subtle.digest` is one-shot
  and the upload path streams in 19 MB slices to stay under 128 MB. The file
  prefers Cloudflare's native `crypto.DigestStream` and only falls back to the
  hand-written implementation on runtimes without it (tests, non-CF hosts). The
  reasoning is written down at the top of the file and it is correct. No library
  would help; the value has to match what the Immich app computes byte for byte.
- **`immich-api-shim/src/zip.ts`** — KEEP. 129 lines, STORE-only, streaming,
  data-descriptor layout so bytes leave before sizes are known. `fflate` and
  `@zip.js/zip.js` would both work in a Worker, but neither is smaller in
  practice once you need streaming STORE, and the 3 MB Worker size limit is real.
  Revisit only if a ZIP64 or a >4 GiB archive requirement appears.
- **`selfhost/src/config.mjs` dotenv parser** — KEEP. It reports errors by line
  number, which is the entire point (`dotenv` does not). Adding a dependency
  here would also break the zero-install property, which is worth more than the
  60 lines it saves.
- **`immich-api-shim/src/webdav.ts` XML building** — KEEP. It is string
  concatenation with a shared `xmlEscape` (line 143). WebDAV `PROPFIND`
  responses are a fixed shape; an XML builder buys nothing.

### Things that are genuinely reinvented and should not be

- **`processor/api/convert.js:56-77` — `keyFromCert`.** This hand-parses an
  X.509 DER blob by scanning for the RSA OID byte sequence, then walking
  backwards to find the enclosing SEQUENCE. It is the key-loading step of a
  security-critical token verifier, and it is doing ASN.1 by eye.

  There is a fix with **no dependency at all**: Google publishes the same keys
  as JWKS at
  `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`.
  Fetch that instead of the x509 endpoint and hand the JWK straight to
  `crypto.subtle.importKey('jwk', ...)`. Same cache-control handling, same
  `kid` lookup, same rotation retry — and 25 lines of ad-hoc DER scanning
  disappear.

  Confirmed live: that URL returns `{"keys":[{"kid":…,"kty":"RSA","alg":"RS256",
  "n":…,"e":"AQAB"},…]}` with `cache-control: public, max-age=19790,
  must-revalidate`, so the existing `googleCerts()` caching logic transfers
  unchanged. The `kid` values match the ones the x509 endpoint serves.

  This is the single clearest "reinvented wheel" in the repository and it is in
  the one file where being wrong is worst. Worth its own task.

### Dependencies that should be dropped

- **`drive/package.json`** declares five packages that nothing in `drive/src`
  or `drive/public` imports:
  - `heic2any` (0.0.4 — an unmaintained version number, and the processor
    already does HEIC)
  - `leaflet`
  - `react-leaflet`
  - `exifr`
  - `@zip.js/zip.js`

  Verified by grepping the literal package name across `drive/src` and
  `drive/public` — zero hits each, including CSS side-effect imports. Delete
  them. `drive/node_modules` is 312 MB; a contributor's first `npm install`
  should not be paying for code nobody imports.

- **`framer-motion` ^12** in both `accounts-portal` and `drive`. Used, so this
  is a judgement call rather than a finding — but it is a large runtime
  dependency for page and modal transitions on a signup funnel where load time
  is the product. Worth a look during Phase 6, not before.

### Two things in `selfhost/` that should go with Task 4.1

- **`selfhost/src/env.mjs` writes `CLOUDFLARE_API_TOKEN`** into a `.env` in the
  current working directory (`env.mjs:30`). That is the exact variable name
  `config.mjs:33-35` renamed to `DC_CF_TOKEN` specifically to stop wrangler
  picking it up and overriding browser sign-in, and the exact file Task 4.2
  refuses to run with. Task 4.1 already deletes this module. It should be first
  in the phase, not just somewhere in it — every day it exists is a day
  something can call it by accident.
- **`selfhost/src/api/cloudflare.mjs:98`** builds a predictable
  `/tmp/dc-wrangler-<pid>-<ts>.ndjson`. No secrets go in it, so this is minor,
  but `/tmp` is 1777 and `fs.mkdtempSync` is one line.

### Version drift worth pinning (supports Task 4.9)

| Package | Declared |
|---|---|
| root `package.json` | `wrangler ^4.85.0`, `typescript ^6.0.3` |
| `immich-api-shim` | `wrangler ^3.0.0`, `typescript ^5.0.0` |
| `daemonclient-proxy` | `wrangler ^4.50.0` |
| `selfhost` | none — resolves to whichever of the above is nearest on disk |

The CLI parses wrangler's behaviour in several places, so which major version it
gets must not depend on directory layout. Task 4.9 is right; note that pinning
`selfhost` alone is not enough while the shim still says `^3`, because
`wrangler deploy` runs against the shim's config.

Also: a `.env` exists at the repository root right now. That is exactly the
condition Task 4.2 detects. Good — it means the detector can be tested against a
real case immediately.

**Recommendation:**
- CHANGE `processor/api/convert.js` to use Google's JWKS endpoint. Zero new
  dependencies, removes hand-written ASN.1 from token verification.
- CHANGE `drive/package.json` — remove the five unused dependencies.
- KEEP `sha1.ts`, `zip.ts`, `config.mjs`'s parser, and the WebDAV XML.
- Fold the wrangler/typescript drift into Task 4.9.

**Why:** most of what looks hand-rolled here was hand-rolled for a stated reason
that holds up — a streaming hash because Web Crypto has no streaming API, a
streaming ZIP because archives can be gigabytes, a dotenv parser because the
error messages are the feature. Those should stay, and the reasons are already
written in the files. The two that fail the test fail it clearly: hand-parsing
ASN.1 inside a token verifier is risk with no upside when Google publishes the
same keys in a format WebCrypto reads directly, and five packages nobody imports
are 300 MB of install a first-time contributor pays for nothing.

**Evidence:** read `immich-api-shim/src/sha1.ts`, `src/zip.ts`,
`src/webdav.ts:143-200`, `src/thumbhash-util.ts`, `src/upload-stream.ts`,
`selfhost/src/config.mjs`, `processor/api/convert.js`. Dependency usage checked
by grepping each declared package name across each project's source tree; all
`package.json` files read directly.
