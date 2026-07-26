# Alternatives review

A check on the master plan for two failure modes: building something that
already exists, and taking on a dependency that costs more than it saves.

Everything below was verified against the code or against current
documentation. Where I could not verify something, I say so.

**Read this first — four things in the plan are wrong, not just improvable:**

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
  `loader`, and the built-in `glob()` loader accepts a `base`, so
  `glob({ pattern: '**/*.md', base: '../docs' })` reads `docs/` in place. No
  copying, no symlinks, no duplicated source of truth. This is the documented
  mechanism, not a workaround.

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
above) and `@cloudflare/nimbus-docs` (0.8.2). Surveyed the local `docs/` tree
with `find`/`head -1` on all 35 markdown files to check for frontmatter.

---

## d. Setup UX (Phase 4)

_(pending)_

---

## e. Secret storage

_(pending)_

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

**Evidence:** read `immich-api-shim/src/sha1.ts`, `src/zip.ts`,
`src/webdav.ts:143-200`, `src/thumbhash-util.ts`, `src/upload-stream.ts`,
`selfhost/src/config.mjs`, `processor/api/convert.js`. Dependency usage checked
by grepping each declared package name across each project's source tree; all
`package.json` files read directly.
