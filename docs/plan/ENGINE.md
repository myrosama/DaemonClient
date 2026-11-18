# One engine for every client — plan

**For the operator and the Linux machine.** Direction from the operator
(2026-11-18): "rewrite the core for Photos too, then potentially Drive too,
with this Rust logic where it's not worker heavy." **Approved by the
operator 2026-11-18 (SPEC D25), with the order changed:** "focus on your work,
finalize the mobile apps; we optimize and rebuild the websites after these
works are finished — you two will be building that together." Nothing here is
built yet. Written on the MacBook from the code as it is on `main`
(`2aff3f6`) and the Linux machine's NOW.md of 2026-11-17.

---

## 1. Two separate problems

**A. The website is heavy on the worker.** Every byte it reads or uploads goes
through the worker's `/proxy` (three worker requests per thumbnail); the worker
backfills EXIF by downloading originals; uploads go unpaced. **None of that
needs Rust to fix** — it is the worker contract and calling Telegram directly
(`docs/web/photos-website-fixes.md`, items 1–5, 9, 10). Those go ahead now, in
TypeScript, and do not wait for anything below.

**B. Each client has its own copy of the rules, and they drift.** Found in P1
alone:

- the website stores hex SHA-1 where the app stores base64 (re-uploads);
- the website and worker pace sends at twice Telegram's group limit (40 s stalls);
- the website's video re-downloads each 19 MiB part for every range request;
- the website converts HEIC (the original and its EXIF lost);
- the scheduler's numbers differ per client;
- album batching (D24) would have to be written three times.

**The engine fixes B:** one implementation of the rules, tested once,
measured once (`dc-cli`), used by the phone apps, the Photos website and
Drive.

---

## 2. Architecture: a sans-I/O engine

**`dc-engine`** (new crate, carved out of `dc-core`): pure Rust — **no async
runtime, no network, no files; time is passed in.** It decides; the platform
does the I/O. Contents:

| Module | Today in `dc-core` | Change |
|---|---|---|
| Storage format: AES-GCM parts, PBKDF2 keys | `crypto.rs` (337 lines, pure) | moves as is |
| Parts and byte ranges | `chunk_plan.rs` (327, pure) | moves as is |
| Manifests: types, which files make a rendition, checks | `reader.rs` (select, Layout, Stored, job keys) + `worker.rs` types | split out of the I/O |
| Scheduler (the Nuke port: classes, slots, coalescing, D17) | `sched/state.rs`, `bucket.rs`, `mod.rs` (~1,030, pure but for tokio's `Instant`) | time becomes milliseconds passed in |
| Send pacer (1 per 3.5 s, burst 2, restart rule) | inside `telegram.rs` | becomes a pure bucket like the read one |
| Backup queue (D24: batch by token, albums ≤ 10 files ≤ 45 MB, parts alone, journal and resume rules, both-spellings dedupe, the worker's fields) | inside `upload.rs` (1,422, mixed with files) | **written pure**: the journal is data the platform stores |
| Telegram answers, multipart bodies for parts and albums, name cleaning | inside `telegram.rs` | split out of the I/O |
| Checksum (streamed SHA-1 → base64 and hex) | inside `upload.rs` | moves |

**The shells — I/O only:**

- **`dc-core` (native, the two apps):** stays the crate the apps call. It
  keeps tokio, reqwest, the hyper local media server, the disk caches, files
  and the background hand-off, and calls `dc-engine` for every decision.
  Behaviour does not change: all of today's tests stay green through the
  split.
- **`dc-engine-wasm` (the websites):** `dc-engine` compiled to WebAssembly
  (`wasm-bindgen`), with a small TypeScript wrapper. The browser does
  `fetch`, the Cache API and IndexedDB, service-worker responses and `File`
  slicing. The engine tells it what to fetch next, how to place bytes, what to
  send in which album, and what to tell the worker.

**What is not in the engine anywhere:**
- picture and video making — thumbnails, previews and the H.264 copy:
  - phones: PhotoKit/AVFoundation, MediaCodec;
  - browsers: canvas, `heic2any`, WebCodecs;
- the UI.

**The worker stays TypeScript, and thin.** After D23 it keeps the books:
metadata and D1, no bytes. Rewriting it in Rust (Cloudflare's `workers-rs`) is
not proposed: it would gain nothing, it is live production, and it is the
Linux machine's.

---

## 3. What runs where, when this is done

| | Phone apps | Photos website | Drive website | Drive app (P3) |
|---|---|---|---|---|
| Rules (format, ranges, scheduler, pacing, albums, journal, dedupe) | `dc-engine` (native) | `dc-engine` (wasm) | `dc-engine` (wasm) | `dc-engine` (native) |
| Network, storage, media serving | `dc-core` (Rust) | service worker + page (TS) | `sw.js` + page | `dc-core` |
| Pictures / video copies | PhotoKit, AVFoundation, MediaCodec | canvas, heic2any, WebCodecs | same | platform |
| Worker | metadata only | metadata only | metadata only | metadata only |

---

## 4. Measured before it is chosen (E2)

- **Crypto in the browser:** the AES-GCM crate in wasm runs in software;
  WebCrypto uses the CPU's AES instructions.
  - Time a 19 MiB part both ways in Chrome, Safari and Firefox.
  - If WebCrypto wins clearly, the web shell does the AES and the engine does
    everything around it.
  - The format is pinned by the CI vectors either way.
- **WebAssembly in a service worker:**
  - loading it at install (the SvelteKit service-worker build in
    `immich/web`; Drive's plain `public/sw.js`);
  - **CSP:** compiling wasm needs `'wasm-unsafe-eval'` in `script-src`. That
    matters for Drive's strict CSP and Trusted Types;
  - Safari's service-worker limits.
- **Size:** target under 400 KB gzipped.
- **Randomness:** `getrandom`'s browser backend (`crypto.getRandomValues`).

---

## 5. Steps and owners

| Step | Who | What | Waits for |
|---|---|---|---|
| **L0** | Linux | Release **R2** (approved by the operator 2026-11-18). Tutorial items 2 (call Telegram directly), 3 (thumbnail ids in bulk), 4 (one checksum spelling), 5 (complete deletes), 7's pacing constants only, 9 (the free plan's day). Accept `telegramPlaybackChunks` (+ size) on `clientUpload` for the phone's H.264 copy (P2-9). | nothing |
| **E1** | Mac | Carve `dc-engine` out of `dc-core`, no behaviour change (every test stays green); scheduler and buckets on passed-in time. | nothing |
| **E2** | Mac | `dc-engine-wasm`: the build, the TypeScript API, the measurements in §4, a test page. Its API is the contract with Linux, agreed in a doc before code. | E1 |
| **E3** | Mac | D24's backup queue, written in the engine (pure, tested); used by the app's P2 2.5 / 2.6. | E1 |
| **WE** | Linux | The Photos website on the engine (scheduler, reads, video ranges with a part cache, uploads with pacing, albums, journal, originals with their own previews). It replaces tutorial items 6, 7 (albums) and 8. A/B against today. | E2, E3 |
| **DE** | Linux | Drive phase 3's "shared scheduler module" **is** the engine's scheduler (wasm), not a new TypeScript module. Drive phase 4's writes go on the engine's upload queue. | E2 (E3 for writes) |
| **P3** | Mac | The Drive app, native on `dc-core`. | P2 |

**Order (operator, 2026-11-18):**
1. **The mobile apps first.** On the Mac:
   - P2 2.1–2.4: identity, sign-in, media through the local server, the
     phone-made pictures;
   - then **E1** (the split) and **E3** (D24's queue in the engine), because
     the apps' uploads are built on them;
   - then P2 2.5 onwards, and P3 (the Drive app).

   On Linux, only what the apps need from the worker: R2 (approved), and
   `telegramPlaybackChunks` on `clientUpload`. The rest of L0 waits, unless
   the operator says otherwise.
2. **Then the websites, together:**
   - **E2** (the wasm build);
   - **WE** (the Photos website on the engine) and **DE** (Drive on the
     engine);
   - the remaining tutorial items, rebuilt and optimised with the Linux
     machine.

---

## 6. Questions for the Linux machine (answer in NOW.md)

1. **Drive phase 3** was to start with a TypeScript shared scheduler. Can it
   take the engine's scheduler (wasm) instead? It already exists in Rust, with
   Nuke's tests and the measured numbers. E2 gives you its API first.
2. **Builds:**
   - Can the `immich/web` service worker (SvelteKit) and Drive's `sw.js` load
     a wasm module at install?
   - Is `'wasm-unsafe-eval'` acceptable in both CSPs?
   - Should the built `.wasm` be committed or built in CI?
   - Should the Rust workspace move from `mobile/` to a root `engine/` folder
     now that the web uses it?
3. **L0:** which items you take now, in what order, and when R2 goes out.
4. **One contract release:**
   - `telegramPlaybackChunks` (+ size) on `clientUpload`;
   - thumbnail and preview message ids;
   - a bulk create;
   - thumbnail ids in bulk (timeline columns).

   Agree the shapes in a doc first, so the engine builds the fields once.

## 7. For the operator

- Approve the direction as planned: the engine split, wasm for the websites,
  the worker staying TypeScript.
- Approve the order: Linux's L0 now; on the Mac P2 2.1–2.4, then E1–E3, then
  P2's uploads.
- Approve that the browser's crypto (wasm or WebCrypto) is chosen by the E2
  measurement.
