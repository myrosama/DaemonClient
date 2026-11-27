# Mobile apps — design notes

One entry per task: what the plan said, what happened, decisions made along
the way, security findings, and the gate evidence. After a context reset, the
*why* is reconstructed from here — read it, do not re-derive it.

Append, never rewrite. A note that turns out wrong gets a correction under it.

**Format:**

```

> **2026-11-20 — pruned (SPEC D26).** The notes on the dropped Flutter app
> were removed: "— Research, spec and plan", "0.1 — Toolchain (partial)", "0.2a — Make the Photos fork build on Xcode 27", "0.2 — What the existing Photos fork does at sign-in", "0.4 — `dc_core_flutter` and the first Rust call from the Photos app", "0.5 — CI", "Finding — Xcode 27.1 breaks `flutter build ios --simulator`". They are in git history. What remains is the Rust
> core's design record (0.3, 1.0–1.9) and the icon decision.
> Citations of `P1-core.md`, `PLAN.md` or `plans/…` point to the plans deleted
> the same day — read them at commit `53df7a4` (`git show 53df7a4:docs/mobile/plans/P1-core.md`).
## <task> — <title>            <date>

**Planned:** what the phase plan said.
**Did:** what actually happened, and any deviation with its reason.
**Decisions:** anything chosen at implementation time that the plan left open.
**Security:** findings raised, fixed, or accepted-and-tracked.
**Gate evidence:** G1 test names · G2 transcript/screenshots described · G3 reviewers and findings · G4 commits.
```

---

## 0.3 — Cargo workspace and `dc-core` with `chunk_plan`            2026-10-05

**Planned:** workspace at `mobile/`; `dc-core` with `part_count` and
`parts_for_range(...) -> Option<Vec<PartSlice>>`; 12 tests.

**Did:** as planned, then changed at Gate 3. The eager `Vec` became a lazy
plan: `plan_range(...) -> RangePlan { Partial(PartSlices) | Unsatisfiable |
Ignore }`, plus `plan_suffix(...)` for `bytes=-N`. 19 tests.

**Decisions:**
- **Serve the whole requested range, across parts.** The web's
  `planVideoRange` answers one part per request; its own comment says native
  players (AVPlayer, ExoPlayer) treat a short `206` as end-of-file, and the
  worker's `handleOriginal` serves the full range. The phone feeds native
  players, so it follows the worker.
- **Lazy, not a list.** A corrupt manifest size (e.g. `u64::MAX`) with a
  player's `bytes=0-` would have meant ~9.3e11 entries (~22 TB) and an abort.
  `PartSlices` holds five numbers whatever the size. Never `collect()` it from
  an untrusted size — **P1 1.5 must validate the manifest** (part list length
  == `part_count(file_size)`, except one stored part for a 0-byte upload —
  `assets.ts:1788,1858`).
- **Invalid range (start after end) → `Ignore` → `200` whole file** (RFC 9110
  §14.2 "MAY ignore"). Differs from the web/worker (one byte, or `416` past the
  end); players never send it. `Ignore` takes precedence over
  `Unsatisfiable`, since satisfiability is only defined for valid ranges —
  pinned by a test.
- **Suffix ranges:** `-0` → `416`; longer than the file → whole file; any
  non-zero suffix on an empty file → `Ignore` (§14.1.1). iPhone video opens
  with a suffix request to find its index, so this is load-bearing.
- **Strict lints** for the core: `unsafe_code` forbidden;
  `cast_possible_truncation`, `indexing_slicing`, `unwrap_used`, `expect_used`
  denied outside tests (`mobile/clippy.toml` allows them in tests). Verified
  they fire by injecting each into non-test code.
- Carry into P1: indexes into a part list must use `usize::try_from`, never
  `as usize` — armv7 Android has a 32-bit `usize`, and a wrapped index would
  fetch the wrong part, which decrypts fine and shows wrong bytes silently.
  The lint above enforces it.

**Security:** round 1 — security reviewer: 0 HIGH, 1 MEDIUM (unbounded
allocation from `file_size`), 3 LOW (one result for three cases; armv7
`usize`; lints); spec reviewer: 0 HIGH, 1 MEDIUM (same allocation), 5 LOW
(start>end wording vs test name; RFC section; suffix ranges undocumented;
"every remaining part" undocumented; records: toolchain pin, moved line
reference, 0-byte part count). All fixed. Round 2, a fresh reviewer: MEDIUM
resolved (3M random cases, no allocation, no overflow); 4 new LOW — wrong RFC
section, suffix on an empty file, untested precedence, "never collect" and a
stale plan document — all fixed.

**Gate evidence:**
- **G1:** tests written first and shown failing (`not implemented`, 11/12,
  then 16/17, then 1/19 for the empty-file suffix); now 19/19 pass; clippy
  `-D warnings` and `fmt --check` clean. Test names include
  `a_hostile_file_size_is_streamed_part_by_part_never_allocated_at_once`,
  `the_iphone_moov_probe_gets_the_last_bytes_of_the_file`,
  `an_invalid_range_is_ignored_even_when_it_also_starts_past_the_end`.
- **G2:** the production web planner (`telegram-media.ts` `planVideoRange`,
  run unmodified under Node 26) and `plan_range` on the same 2,754 ranges
  (9 file sizes up to 4 GiB, part boundaries, starts past the end, 2,700
  seeded random ranges): **0 mismatches** on part index, in-part offsets,
  `byte_range`, total coverage and 416 cases. A real device/network run is
  not applicable to pure arithmetic; it happens in P1 1.6 (media server).
- **G3:** above. **G4:** this commit pair.

---

## — Replan: HEIC previews and the scheduler's source            2026-10-05

**Planned:** D14 said the apps upload no preview.

**Did:** the operator asked what happens when an app-uploaded HEIC is opened
on the website. Checked the code (RESEARCH §8): the web viewer asks for a
preview and, with none, gets the HEIC original, which Chrome and Firefox cannot
draw. So **D18** brings the preview back for HEIC/HEIF/RAW only, through the
existing `POST /api/assets/:id/thumbnail` route the web's HEIC Fix tool already
uses — no worker change. The operator also asked to copy an existing
smart-loading algorithm rather than invent one: no Rust image scheduler exists,
so **D19** ports Nuke's (MIT) design onto Rust building blocks
(`governor`, `tokio-util`), keeping the operator's opened-first and
newest-first rules (RESEARCH §9, SPEC §4.9).

**Decisions:** the preview passes through the worker (a few hundred KB of
derived JPEG, the same as the web Fix tool) — a small, recorded exception to
"no file bytes through the worker". A later additive change could let
`clientUpload` take `telegramPreviewId` directly; not needed now.

**Gate evidence:** docs only.

---

## Icons — the approved Photos icon            2026-10-29

**Planned:** none — the operator approved app icons for both apps on
2026-10-29 (made on the Linux machine, `docs/mobile/icons/`, `8a695dc`; moved to `apps/brand/icons/` 2026-11-20).
**Did:** `mobile/tools/brand/install-photos-icon.sh` resizes the Photos set
("fanned gallery") into all 34 iOS AppIcon slots and the five Android
densities (legacy, adaptive foreground, and the Android 13 themed monochrome
icon, wired in `mipmap-anydpi-v26/ic_launcher.xml`) and refreshes the icon
generator's sources. Launch screens and in-app logos stay the DaemonClient
logo. The brand README marks the old icon outputs as superseded.
**Decisions:** assets only (plus one XML line and a resize script), so no
Gate 3 under GATES.md's proportional rigor.
**Gate evidence:** G2 — iOS: the built app's `AppIcon60x60@2x.png` is the new
icon, and the copy installed on the iPhone 18 Pro Simulator is byte-identical
(the home screen shows it on its second page; the first screenshot showed the
old icon from a stale build — see below). Android emulator: the home screen
shows the new icon. The iOS 1024 icon has no alpha. Commit `d52c269`.

---

## 1.0 — Foundations            2026-10-29

**Planned:** `Core` with its own runtime, `Secret`, `CoreError`, the core's
logger, the HTTP client of decision C1, and an HTTPS request to Telegram from
both device types (P1-core.md Part 2, Task 1.0 — written before the code).
**Did:** as planned. Differences: rustfmt reflowed the plan's code (layout
only); versions moved for advisories — tokio 1.53.3 (RUSTSEC-2026-0386),
webpki-roots 1.0.11 (RUSTSEC-2026-0381), rustls 0.23.46 (RUSTSEC-2026-0346
to -0349); four tests and three small fixes added from Gate 3 (below).
Also in this sitting: Rust **1.99.1** (`b0dfe2a`) — the 0.4/0.5 push turned
mobile-build red exactly as the pin check intends (stable became 1.99.1 on
2026-10-13), and `cargo-deny` 0.20.2 installed on the Mac so advisories are
checked before a push.
**Decisions:** a malformed address is `Internal`, not `Network`; a panicking
task reports only "a core task panicked"; `scrub` also catches the token with
`%3A` as the separator. Accepted LOWs, each assigned (P1-core.md, end of Part
2): `https://`-only worker URLs → 1.2; the logger's sink fixed at install →
1.8 / P2; the process-wide `Core` and text errors over the bridge → P2.
**Security:** reviewer — **1 HIGH**, 0 MEDIUM, 4 LOW. HIGH: webpki-roots
1.0.9 still trusted a root with distrusted emSign intermediates whose keys
are public (RUSTSEC-2026-0381) — on hostile Wi-Fi a forged api.telegram.org
certificate would have exposed the bot token; fixed (1.0.11). LOW: rustls
advisories (not exploitable with this config) → 0.23.46; panic messages
reached Dart unscrubbed → fixed; percent-encoded tokens escaped `scrub` →
fixed; `http://` allowed → task 1.2. INFO: `scrub` fuzzed with 200k random
and 300k token-bearing lines — no panic, no leak, linear time; error texts for
refused/DNS/bad-scheme/unparsable carry no URL; `Secret` really zeroes;
only reqwest and rustls log through `log`, nothing with URLs at Info/Warn;
no certificate bypass anywhere; redirects off.
Spec reviewer — 0 HIGH, 2 MEDIUM (Gate 2 transcript missing; EXECUTION_STATUS
row stale — both fixed in this docs commit), 4 LOW (weak logger test →
strengthened; the redirect test needed the internet → now catches it on the
fake server; builder errors called "network" → fixed; sink fixed at install
→ assigned), INFO for P2 recorded above.
**Gate evidence:**
- G1: tests written first and failing (compile errors for the new modules;
  then the three Gate 3 tests failed before their fixes). `cargo test -p
  dc-core` — 33 passed; clippy (deny lints) and fmt clean;
  `cargo deny check advisories` — "advisories ok".
- G2 (after all fixes, 2026-10-29), `flutter test
  integration_test/core_test.dart` from the plugin's example:
  - iOS 27.0 Simulator, iPhone 18 Pro, Xcode 27.1: "the app reaches the Rust
    core…", "file sizes above 2^53…", "the core reaches Telegram over HTTPS
    from this device" → `00:01 +3: All tests passed!`
  - Android emulator, API 36 (`dc-test`): same three → `00:01 +3: All tests
    passed!` (A first run failed with "Connect: operation timed out": the
    emulator had lost its network — `ping` could not resolve any name — while
    the Mac reached Telegram in 0.12 s; restarting the emulator fixed it.)
- G3: above. G4: `b0dfe2a` (Rust 1.99.1), `9d9e929` (code), this docs commit.

> **0.5, G2 (2026-10-30):** after the push and the Rust 1.99.1 bump, all of
> CI is green on `3440a3c` — `mobile-core` (core + audit)
> https://github.com/myrosama/DaemonClient/actions/runs/40887140650 and
> `mobile-build` (android-apk **and ios-simulator — the first green iOS
> build ever**) https://github.com/myrosama/DaemonClient/actions/runs/40887140844.
> 0.5 is done, and with it P0 (SPEC §9 P0 exit).

---

## 1.1 — Crypto            2026-10-30

**Planned:** move the spike's crypto into `dc-core` with the production
JavaScript checks in CI (P1-core.md Part 2, Task 1.1).
**Did:** as planned — files, names, `CryptoError` variants and pins match the
plan; the spike's scripts are byte-identical; `sha1` dropped (not needed
until 1.7). From Gate 3: aes-gcm's `zeroize` feature (the expanded key is
wiped); the Rust→JS check refuses an empty part list; salts accept trailing
bits like `atob`; the Drive key-check vector is made by
`apps/drive-web/src/zke-unlock.js`'s `makeKeyCheck`; a test pins the SHA-256 of both
JavaScript sources, so a change to either fails CI until `vectors.json` is
regenerated (`node mobile/core/compat/gen-vectors.mjs`). `vectors.json` changes
on every regeneration (random IVs in two sections); keys and fixed-IV answers
are reproducible.
**Decisions / carried forward:** SPEC §7 (worker-encrypted `server` assets) is
covered by inspection — the worker's `assets.ts` and the web service worker
use the same `atob` salt, PBKDF2 parameters and part layout as `crypto.js`;
the real check is reading such an asset in 1.5. `verify_drive_key` returns
`false` for a malformed check as for a wrong password → P3 (Drive unlock).
`From<CryptoError> for CoreError` → 1.5. `derive_key` is slow by design → 1.2
calls it through `spawn_blocking`.
**Security:** reviewer — 0 HIGH, 0 MEDIUM, 2 LOW (expanded key not zeroized →
fixed; malformed check reads as wrong password → P3), INFO (atob edge cases →
fixed; empty check list → fixed; stale vectors → fixed). Confirmed: no
unauthenticated plaintext leaves `decrypt_part` (aes-gcm checks the tag before
decrypting), no panic on hostile lengths, fresh random IV per part, PBKDF2
identical to the JS.
Spec reviewer — 0 HIGH, 0 MEDIUM, 3 LOW (atob trailing bits, frozen vectors,
key-check constant not from production code — all fixed).
**Gate evidence:**
- G1: the eight tests written first (compile failure), then the Gate 3 tests
  (trailing bits failed before its fix). `cargo test -p dc-core` 42 passed;
  clippy and fmt clean; `cargo deny check advisories` ok.
- G2 (the production code is the real condition): JS→Rust — the vectors were
  produced by `apps/drive-web/src/crypto.js` (SHA-256 `aa2a05f2…`) and `zke-unlock.js`,
  and all crypto tests pass against them; Rust→JS — `emit_vectors | node
  mobile/core/compat/verify-rust-output.mjs` → `ok 0 / 1 / 16 / 1000 /
  19922944 bytes`, exit 0.
- G3: above. G4: `6361a35` and this docs commit.

---

## 1.2 — Sign-in and the worker client            2026-10-30

**Planned:** P1-core.md Part 2, Task 1.2 (written before the code).
**Did:** as planned, with these differences: `POST /api/assets` and the
thumbnail route moved to 1.7 and the Drive routes to P3 (built where first
used; PLAN and §5.3 amended); `restore` and `sign_out` return `Result` (the
session lock); `.local`, link-local and IPv6 unique-local addresses count as
local; from Gate 3 — hosted workers must be https even on a home network,
`restore` re-checks the stored worker address, a 404 at sign-in is
`BadAddress`, empty zke settings give no key, server messages are scrubbed
**before** being cut and lose control/bidi characters, an undecodable reply
quotes nothing. Closes Task 1.0's carried-forward LOW (http worker URLs).
**Decisions:** recorded at the end of P1-core.md Part 2 — each accepted LOW
with its owning task (1.3, 1.5, 1.7, P2), the accepted self-hosted LAN-http
risk, and the Turnstile risk on the central login.
**Security:** reviewer — 0 HIGH, 0 MEDIUM, 4 LOW, all fixed: a token cut at
the 200-character limit escaped `scrub`; hosted sign-in allowed http to local
addresses; `restore` skipped the address check; the example could print raw
Keychain bytes on a decode failure. INFO: password copies in the request body
are not wiped (accepted); sign-out does not stop in-flight work (→ P2); lock
poisoning now cannot keep the token; reply sizes uncapped (→ 1.5). Checked
fine: every `Secret` field redacted in `Debug`; the Bearer header is marked
sensitive; redirects off; the asset-id guard blocks traversal; address tricks
(`@`, userinfo, `127.0.0.1.nip.io`, IPv4 forms, IDN) normalise or are refused.
Spec reviewer — 0 HIGH, 1 MEDIUM (empty zke settings derived a key from "" —
fixed, test added), 4 LOW (404 untested / sign-in 404 → fixed; decode text
uncapped → fixed; missing Telegram config → 1.3; moved routes → recorded).
`HOSTED_API` (`https://api.daemonclient.uz`) confirmed: the fork's prefilled
address and the openapi spec's "login and worker discovery" server.
**Gate evidence:**
- G1: tests first, failing (missing types), then each Gate 3 test failed
  before its fix. `cargo test -p dc-core` 58 passed; clippy (deny lints) and
  fmt clean; `cargo deny check advisories` ok.
- G2 (2026-10-30, `cargo run -p dc-core --example sign_in`, the operator's
  approved test account, password from the Keychain item `daemonclient-test`):
  `signed in — worker: dc-…workers.dev` (host withheld here) ·
  `telegram — bot token: present, channel: present` ·
  `photos encryption — mode: server, key: derived (derived in 638 ms)` (debug
  build; includes one network round-trip). Re-run after every Gate 3 fix.
- G3: above. G4: this code commit and docs commit.

---

## 1.3 — The Telegram client            2026-10-31

**Planned:** P1-core.md Part 2, Task 1.3 (written before the code).
**Did:** as planned; the differences are listed under "As built (Task 1.3)" in
P1-core.md — chiefly the bot cached in `Core` (one per session) instead of the
worker's config. The token bucket ported from Nuke lives in `sched/bucket.rs`;
NOTICE now credits Nuke for it too. User-facing text says "storage" (SPEC D21,
decided during this task).
**Security:** reviewer — 0 HIGH, **2 MEDIUM**, 4 LOW, all fixed. MEDIUM: a
`retry_after` near 2^63 panicked inside the pacer (`Instant + Duration`
overflow), poisoned its lock, and every later send went out unpaced — capped
at a day, `checked_add`, poisoned locks recovered; MEDIUM: a sign-out while the
bot config was being fetched stored the old bot again — with sign-in as
another account in between, that account's uploads would have gone to the
first account's channel — worker and bot now live under one lock, made once
per session, handed out only to the session they belong to. LOW: Telegram's
description not cleaned (shared clean-up now), a shorter pause cutting a
longer one, two pacers under concurrent first calls, the streamed-size cap
untested. INFO checked fine: a hostile `file_path` cannot move the
token-bearing request off api.telegram.org; every reqwest error loses its URL.
Spec reviewer — 0 HIGH, 1 MEDIUM (the same race), 8 LOW: fixed — 5xx is
transient, a bare 429 still means wait, description cleaned, longer pause
wins, test gaps (field names, stale-path counts, streamed cap), NOTICE, the
download buffer sized from the bounded length; assigned — see the
carried-forward list after Task 1.3.
**Gate evidence:**
- G1: tests first, failing (compile, then 5 behavioural failures incl. the
  reproduced overflow panic). `cargo test -p dc-core` 75 passed; clippy (deny
  lints) and fmt clean; `cargo deny check advisories` ok.
- G2 (`cargo run -p dc-core --example telegram_roundtrip`, the approved test
  account): before Gate 3 — `sent 64 KiB in 1187 ms · read back 64 KiB in
  1275 ms — identical: true · read again (path cached) in 968 ms · deleted`;
  after the fixes — `sent 64 KiB in 1227 ms · deleted the test message · read
  back 64 KiB in 828 ms — identical: true · read again (path cached) in 398 ms`.
- G3: above. G4: `0af1736` and this docs commit.

---

## 1.4 — Smart loading: the scheduler (Nuke port)            2026-10-31

**Planned:** P1-core.md Part 2, Task 1.4 (written before the code).
**Did:** `sched::state` — the rules as a pure state machine, time passed in;
`sched::shell` — one tokio task runs it, each download its own abortable task.
Differences from the plan are under "As built (Task 1.4)" in P1-core.md.
**Found on the way — a bug in 1.3's pushed code:** `TokenBucket::wait()`
rounded to 0 ns when the tokens summed to a hair under 1.0 (0.1 added ten
times is 0.9999999999999999) while `try_take()` refused. Callers read a zero
wait as "a token is there": the scheduler started reads without tokens (a
first fling run started 373 in 1.7 s against a budget of 43), and
`SendPacer` let an occasional upload part through unpaced. 1.3's pacing
test used a paused clock that never lands on such sums. Fixed once in the
bucket, with a test over step sizes 1–50 ms that failed first (4 ms steps).
**Security:** reviewer — 0 HIGH, **2 MEDIUM**, 3 LOW, all fixed or recorded.
MEDIUM: a `retry_after: 0` restarted the opened read at once — 1,000 fetches
a second, never resolving — and rate-limited jobs retried forever (pause
floored at 1 s, job fails after 3); a 429 from Telegram's file server was a
plain error, so reads never paused (now a rate limit). LOW: O(n) scan per
event (recorded for 1.8), opened reads unmetered (they now spend a token
when there is one), `Limits` unchecked (code constants; contract documented).
INFO taken: dropping the scheduler now stops everything (sign-out); an opened
photo waiting out a pause no longer holds up uploads. Checked fine: stale
results of aborted runs are ignored (attempt numbers), the task ends when
dropped, nothing in `sched` logs or leaks a token; a randomized run of the
state machine (400 seeds × 400 steps) kept every invariant.
Spec reviewer — 0 HIGH, **3 MEDIUM**, 7 LOW. MEDIUM: Next work could take the
slot reserved for the opened photo (SPEC §4.9 says it never waits) — now the
opened item's only; a running job's class change moved slots — now counted
by the class it started in; the first fling test did not show what Gate 2
claims — replaced by a scroll model (below). LOW: tests added for each rule
that broke no test when mutated (Opened and the bucket, Opened and the pause,
newest-first on a repeated request — which also fixed a Background request
reordering the screen, pre-emption when the opened photo joins a running
prefetch, new work after a cancel); `is_running` test-only; a debug assert
that every read but the opened one took a token.
**Gate evidence:**
- G1: tests first, each failing before its fix (9 at the Gate 3 round).
  `cargo test -p dc-core` 103 passed; clippy (deny lints), fmt clean;
  `cargo deny check advisories` ok.
- G2: the scheduler against a scroll model of the Photos grid (10,000
  thumbnails, 30 on screen, 120 Hz frames, Flutter's order: new tiles built,
  then old disposed; 150 ms per fetch; a photo tapped halfway; then the final
  screen must load). Steady scroll (1 tile per frame): **1,630 started, 1,625
  finished, 5 cancelled.** Fast fling (4 per frame — each tile on screen 60
  ms, less than one fetch): **437 started, 407 cancelled, the final 30
  loaded** — held to the rate (burst + 20/s), the waste goes to P2 (scroll-
  aware loading). In both, the tapped photo started at once and alone, and
  never more than 5 started in one instant. Real Telegram round trip on the
  test account after the bucket fix: sent 64 KiB in 1017 ms, identical on
  read-back (632 ms, cached path 219 ms), deleted.
- G3: above. G4: `e827804` and this docs commit.

---

## 1.5 — The read path            2026-11-15

**Planned:** P1-core.md Part 2, Task 1.5 (written before the code, 10-31).
**Did:** `reader` (which stored file answers which request — the web's
`selectFileIds` and playback rule, ported exactly — the manifest checks, the
range reader), `disk_cache`, and `Core::image` / `layout` / `range` on a
per-account scheduler. Differences from the plan are under "As built (Task
1.5)" in P1-core.md.
**What the test account holds** (found before building, so the work fits
the data): 2,177 assets in 10 shapes, all `server`-encrypted, all with a
thumbnail, every size known, no gaps, no H.264 renditions — 1,197 images
with only `originalId` (649 with a preview), 707 one-part and 13 two-part
images, 160 `originalId`-only videos and 100 multi-part videos up to 740 MB.
The web plays `originalId`-only videos through the worker; the core reads
them itself.
**Security:** reviewer — 0 HIGH, **2 MEDIUM**, 3 LOW, all fixed. Both
MEDIUMs were about the picture cache across accounts: signing in as another
account without signing out kept the first account's decrypted thumbnails
where the second session could be served them (cache names now include the
account and how the file is read; another account empties the cache), and a
thumbnail finishing just as the user signed out was written after the cache
was emptied (a generation counter now drops such writes; emptying also
removes temp files). LOW, fixed: the read kind in the cache name, a 1 MiB cap
on manifests (they are kept in memory), nothing over 4 MiB kept on disk. A
second, short check of the plain-picture fallback (below): 0 HIGH, 0 MEDIUM,
1 LOW (a copy made for every such read — now only when the bytes are a
picture), fixed.
**Spec:** reviewer — **1 HIGH**: a shape the plan missed — older uploads in an
encrypted library stored thumbnails and previews as plain JPEGs; the worker
shows them (it decrypts, and on failure serves bytes that are a JPEG or PNG)
and the core would have shown broken tiles. Ported as the worker does it:
decrypt first, the magic check only after a failure (checked first, one
encrypted thumbnail in 65,536 would be shown as noise), thumbnails and
previews only. Whether any test-account thumbnail took this path cannot be
seen from outside the core; the unit test is the evidence that it works. 1 MEDIUM (the size-0 `layout` path untested — now tested),
7 LOW (tests for a short part, the key derived once, the scheduler living on
the core's runtime — each mutation-checked; the rest recorded as accepted).
The operator decided on 2026-11-15 that sign-out empties the picture cache
(SPEC §4.7, change log).
**Gate evidence:**
- G1: tests first, each failing before its fix; two of them mutation-checked
  (an always-clearing `restore` and a scheduler on the caller's runtime both
  fail the suite). `cargo test -p dc-core` 127 passed; clippy (deny lints),
  fmt clean; `cargo deny check advisories` ok.
- G2 (`cargo run -p dc-core --example read_assets`, the approved test account,
  read-only, debug build, 2026-11-15): **every grid thumbnail of the account
  — 2,177 — loaded through the core as a JPEG** (332 s, 8 at a time); for the
  smallest asset of each of the 10 shapes, thumbnail and preview read and the
  original **byte-identical to the production worker's**
  `/api/assets/:id/original` (full SHA-256 for 9 shapes; 3 of 3 ranges,
  one across a part boundary, for a 58 MB 4-part video); **0 cached files
  left after sign-out**. Originals read at ~2.5–3.3 MB/s one part at a time
  (prefetch is 1.6, throughput 1.8). The first run (10-31) gave the same
  matches before the Gate 3 fixes. Linux's worker release W1 (canaried on
  this account) changes no Photos endpoint.
- G3: above. G4: `e5be91b` and this docs commit.

---

## 1.6 — The local media server            2026-11-15

**Planned:** P1-core.md Part 2, Task 1.6 (written before the code). Two
decisions were due and written into the plan first: only a request's first
download runs at its listener's class (the 1.4 carry-forward about video
holding the grid back), and a thumbnail route never answers with a video.
**Did:** `media_server` (hyper, HTTP/1.1, two loopback listeners), the range
reader a part ahead, and — from Gate 2's own criterion — a per-account part
cache. Differences from the plan: "As built (Task 1.6)" in P1-core.md.
**Gate 2 found three things before review:** (1) the test tool's Telegram
relay ran on the runtime that the Swift check blocked, so AVFoundation's
first request timed out (fixed in the tool); (2) every part was downloaded
twice when AVFoundation opened a video — it probes the first 2 bytes (a whole
part under C6), asks for the whole file, then the end — hence the part cache;
(3) C6's promise of a first frame after one part holds for files with the
index at the start: an iPhone `.mov` keeps it at the end, so a video opens
after two parts. Recorded for the operator in SPEC §11.
**Security:** reviewer — **1 HIGH**, 1 MEDIUM, 1 LOW, all fixed. HIGH: another
app on the phone could get the secret — running out of file descriptors
ended the listener, the reopened one kept the same secret, and another app
could take the freed port and receive the secret with the app's next
request; now every listener has its own secret, errors pause instead of
ending at once, and at most 32 connections per listener (the MEDIUM). LOW:
`MediaServer` printed its secrets in `Debug`. Also: a `403` closes its
connection, SVG is not a picture.
**Spec:** reviewer — **1 HIGH**, 4 MEDIUM, 8 LOW. HIGH: iOS can close a
suspended app's socket while the accept loop never notices, and
`ensure_running` checked only the loop — it now asks the port itself (a
loopback connect) and reopens. MEDIUM: tests for the 502/503 statuses and for
the listeners surviving sign-out; the plan and SPEC texts (secret per
listener, the part cache, C6's measured cost). LOW: a test that a stream's
first part runs at the viewer's class (and a part from memory no longer uses
it up), `image()` never a video tested, a case-insensitive type check, a
range refused when the manifest changed since its layout; the rest recorded.
**Gate evidence:**
- G1: tests first, failing; four tests mutation-checked (hyper's
  `half_close`, the next part prefetched at `Opened`, no connection limit, no
  port check — each fails its test). `cargo test -p dc-core` 145 passed;
  clippy (deny lints), fmt clean; `cargo deny check advisories` ok; no new
  crates (hyper's server side, already in the tree through reqwest).
- G2 (`cargo run --release -p dc-core --example serve`, the approved test
  account, read-only, everything through the media server; a relay counts
  Telegram downloads and never prints a path): a grid thumbnail — a JPEG;
  **AVFoundation, cold, opened a 3-part iPhone video in 7.8–8.0 s and drew a
  1920x1080 frame from its middle in 12.8–15.1 s, each part downloaded once**
  (three runs); the whole file **byte-identical to the worker's** (SHA-256)
  and three ranges equal (one across a part boundary, the first 2 bytes, the
  last 64 KiB); no cached picture left after sign-out. Full reads ran at
  2.0–5.3 MB/s on this Mac's network (throughput is 1.8's).
- G3: above. G4: `ce43929` and this docs commit.

**After the reviews — the listener mechanism, settled.** An automated review
then found that a plain connect could not tell our listener from another app
that took a freed port, and a security re-check of that fix found that a
reopened listener's old connections lived on with the old secret, and that a
busy or slow port could stall or flap the check. Fixed in `5b07471`; what the
mechanism now guarantees, each with a test:
- **(a)** a secret works only on connections its live listener owns — they
  run in the listener's task set, so a reopen ends them with it;
- **(b)** the app never keeps an address whose port does not answer as ours —
  `ensure_running` sends a fresh nonce and expects an HMAC of the listener's
  secret, which is never sent;
- **(c)** neither the listener nor `ensure_running` spins or hangs — one
  750 ms deadline per challenge, one retry, a capped reply, paused accepts.
The trade-off, chosen: a port that is connected but does not answer in time
— ours but busy, or another app — is reopened. That is safe by (a), cheap,
and can be caused by another app; it ends that listener's connections, so
the app must use the addresses `media_server()` returns and reload what
failed (P2). The part cache cannot outlive sign-out: the account owns it and
readers hold it weakly. Tests: 148 passed; the connection-ownership test was
mutation-checked (detached connections fail it).

---

## 1.7 — The upload engine            2026-11-16

**Planned:** P1-core.md Part 2, Task 1.7 (written before the code), then
revised the same day for the operator's decisions: SPEC D22 (automatic
background backup — parts prepared as whole requests the platform uploader
sends straight to Telegram, the one exception to D21) and D23 (the phone does
the heavy work: thumbnail, preview and EXIF made on the phone, the worker
given metadata only), the original byte for byte, dedupe on SHA-1.
**Did:** `upload` (checksum → dedupe → parts → thumbnail and preview →
metadata), the hand-off (`part` / `part_sent`), the resume journal.
Differences from the plan: "As built (Task 1.7)" in P1-core.md.
**Security:** reviewer — **1 HIGH**, 3 MEDIUM, 4 LOW, all fixed. HIGH: an
upload was not tied to the account that began it — with another account
signed in, a resumed or abandoned upload could delete that account's
unrelated messages, register one account's parts in another's library, or
send one account's plaintext into another's encrypted library. Now an upload
keeps its account's worker and bot, checks the signed-in account at every
step, lives in a per-account folder, and all uploads are wiped at sign-out
and account switch. MEDIUM: encryption settings read once per session (now
read for every file); answers from the platform uploader trusted as given
(now recorded only for their own part: index, name, size); a file changed
between the checksum and the part reads (size and modified time checked).
LOW: one upload per file at a time, flushed journal writes, duplicates
clean up earlier sends, at most two prepared parts on disk.
**Spec:** reviewer — **1 HIGH**, 3 MEDIUM, 5 LOW. HIGH: a lost answer to a
successful asset creation, then "duplicate" on the retry, deleted the parts
the new asset pointed at — the journal now marks `creating` before the
request, and nothing it lists is deleted after that. MEDIUM: location was
not sent (the worker reads it only from `latitude`/`longitude` until W2 —
now sent from the EXIF); three rules no test could catch (a key change, the
journal written before a body goes, the IV-and-tag size — tests added); no
progress callback (P2 reports progress from `pending()`). LOW: fixed —
cleaned names compared, thumbnail and preview through the send slot with
retries, bodies built off the async threads, more fields asserted.
**Found by Gate 2, before any phone:** reqwest's 30 s "read" limit runs from
the start of a request until the answer begins — on a slow uplink every
19 MiB part would have failed and been sent again. Sends now use a client of
their own, limited by their size (20 KB/s, a minute at least), with TCP
keepalive. Mutation checks: the account check, the `creating` mark.
**Gate evidence:**
- G1: tests first, failing; `cargo test -p dc-core` 170 passed; clippy
  (deny lints), fmt clean; `cargo deny check advisories` ok (`sha1` added,
  RustCrypto).
- G2 (`cargo run --release -p dc-core --example upload`, the approved test
  account; test assets deleted at the end and leftovers of earlier runs at
  the start): a JPEG and a HEIC made with `sips` (6–17 MB) uploaded and
  **read back byte-identical**, thumbnails JPEG, in 15–27 s; the same JPEG
  again a **duplicate with nothing sent**; **a 722 MB iPhone video in 39
  parts — 2 sent by hand through the hand-off as the background uploader
  will, 37 resumed by the core — exactly 39 parts sent, none twice, and read
  back byte-identical** (898 s: this Mac's uplink, ~0.8 MB/s, sets the
  pace; read back by a second core straight from Telegram — the counting
  relay answers only after a whole part, which trips the 30 s read limit).
  Earlier runs of the tool gave the video a new device id on the second
  call, so it started over instead of resuming: 4 sent parts (~76 MB) stayed
  in the test channel unused before that was found and fixed. Some runs also
  met this Mac's network dropping for a while (timeouts on the worker); the
  tool deletes its leftovers at its next start.
- G3: above. G4: the code commit and this docs commit.

---

## 1.8 — `dc-cli`, the measurements, the P1 exit            2026-11-17

**Planned:** P1-core.md Part 2, Task 1.8 (written before the code).
**Did:** `mobile/core/dc-cli` (whoami, list, upload, download, delete, serve,
bench reads / sends / parts); the read limits and the send pacing set from
measurement; a dedupe fix found by Gate 2. Differences from the plan: "As
built (Task 1.8)" in P1-core.md.
**Found by Gate 2:** the website stores **hex** SHA-1, the Immich app, the
worker and the core **base64**, and the worker compares the text — the app
would have uploaded again every photo the website had. The core now asks
about both spellings (test; live: a website photo backed up through dc-cli →
"already stored, nothing sent"). The other direction is the worker's (W2).
**Measured (this Mac, release):** reads — no rate limit up to 122 paths and
126 thumbnails a second; the core went from 11 to 25 thumbnails a second
(12 at once, 40/s, burst 12). Sends — ~20 messages a minute per channel (the
21st in a burst waits 40 s), half of what RESEARCH §12 assumed: a first
backup runs at ~600 JPEGs or ~400 HEICs an hour; the pacer is now 1 per 3 s,
burst 3. C6 — two parts at once ~40% faster than one after the other, but an
early fetch of a video's last part showed no gain in AVFoundation's open
(seven alternating pairs, medians 7.9 vs 8.3 s): built, measured, removed.
Downloads 4–6 MB/s.
**Security:** reviewer — 0 HIGH, 2 MEDIUM, 10 LOW. MEDIUM: Ctrl-C skipped
the cleanup (decrypted thumbnails left in the temp folder, bench messages
left in the channel) — now any command ends through it, checked live; the
bench's deletion depended on a later worker request — the client is made
first. LOW fixed: capped waits, leftover ids printed, the password in
`Secret`, tools by `/usr/bin` path, absolute upload paths, poster files
removed, a smaller read budget. Carried: the opened item's memory with 12
slots (P2, on a device); pacing at the measured limit.
**Spec:** reviewer — 1 HIGH (the P1 exit evidence not recorded — now in As
built), 5 MEDIUM, 3 LOW: a stale comment, the two-spellings finding and C6's
removal into SPEC §10/§11 and RESEARCH, the unpaced bench opening a client
every 3 sends, the background uploader's pacing carried to P2, stale texts,
two more tests.
**Gate evidence:**
- G1: tests first, failing; `cargo test` dc-core 171, dc-cli 9; clippy (deny
  lints), fmt; `cargo deny check advisories` ok. Mutation checks: the hex
  spelling (the new dedupe test fails without it).
- G2: the P1 exit on the test account — sign-in; a JPEG and a 157 MB video
  uploaded and read back byte-identical; a website upload downloaded and
  decrypted, matching its stored checksum; the video served to AVFoundation
  (a 1080p frame from its middle) and ranges checked with `curl` (206, 416,
  403). The operator opened both on the website: they open and the video
  plays, with lag from the website's video path (RESEARCH §14). **P1 exit
  met** (SPEC §9).
- G3: above. G4: the code commit and this docs commit.

---

## 1.9 — Limits to the edge: reads, sends, albums            2026-11-17

**Planned:** P1-core.md, Task 1.9 (written before the code, extended mid-task
for the operator's questions: an adaptive album algorithm, upload and
download speeds, the worker's limits). Operator: "learn the rate limits
perfectly… never hits 429 and if it does make sure it will be fixable…
scroll through 10k thumbnails freely and fast, open any photo and any video,
backups should be perfect"; "run every test possible and consult with the
advisor".
**Did:** ~20 measurement runs on the test account (every one in As built and
RESEARCH §14's table), and from them: read defaults 24 at once, 60/s, burst
24 (a fling 22 → 44 thumbnails a second, no rate limit; 32/80 no faster); a
manifest gate (16 in flight for the grid, the opened and the next item skip
it: a photo tapped mid-fling 13 s → 2 s, A/B); the send pace 1 per 3.5 s,
burst 2 (≤ 19 in any minute; two 10-minute runs of 170 sends without a refusal), not respent after a restart within
a minute (a per-account mark); every rate limit logged; albums and batch
delete in the Telegram client; the limits checked at start.
**Found:** Telegram's group limit counts **requests** — an album of 10
documents is one; Telegram spends ~0.6–0.8 s a file in an album; requests
must go one at a time (albums started together are refused; two parts in
flight gain nothing); a request is capped at ~50 MB (45 MB albums). The
uplink (~2 MB/s here) bounds videos and big photos; downloads fill the link
with 2–3 parts. Cloudflare's free plan bounds a backup at ~14,000–16,000 new
photos a day (D1 writes) and a scroll costs one worker request per thumbnail.
**Proposed:** SPEC D24 — backups batched into albums by the pacer's token
(~1,900 HEIC / ~2,200–2,800 JPEG an hour instead of ~340 / ~510), for the
operator to approve; the website's side in `docs/web/photos-website-fixes.md`.
**Security:** reviewer — 0 HIGH, 2 MEDIUM, 5 LOW, all fixed (manifest fetches
queued before a sign-out now end there; benches delete what was in flight
after Ctrl-C or a failure; complete limit checks; cleaned multipart names;
an unreadable album answer deletes its messages; the mark's path from the
session snapshot).
**Spec:** reviewer — 0 HIGH, 4 MEDIUM, ~15 LOW, fixed or recorded (burst 2,
D24 split into built and proposed, the albums-of-2 figure dropped, the next
item exempt from the gate, more tests, stale text).
**Gate evidence:**
- G1: tests first, failing; dc-core 184, dc-cli 9; clippy (deny lints), fmt;
  `cargo deny check advisories`. Mutation checks: the gate (open and next
  bypass), the restart mark's wiring, name cleaning.
- G2: the runs above on the test account.
- G3: above. G4: the code commit and this docs commit.

## I4 — The core in the iPhone app; the sign-in screen            2026-11-26

**Planned:** ENGINE.md §9 I4, plan `docs/mobile/plans/I4-core-bridge.md`
(written alongside the code: the operator asked to go straight to it), and
I4c, the sign-in screen ("make it close to immich login screen
professional"; "we need create account button that opens a web page").
**Did:** `core/dc-ffi`, a thin UniFFI 0.32.2 bridge (`uniffi-bindgen`
generates the Swift; the bindings and DCCore.xcframework are built into the
git-ignored `core/dc-ffi/build/` by `build-ios.sh` and never copied into the
app, so they cannot drift from the Rust); `CoreBridge.swift` keeps the whole
session in one Keychain item with an install marker in UserDefaults;
HomeRoll's client takes the worker address and token from it until I5–I8.
The sign-in screen rebuilt; HomeRoll's Immich sign-in and SSO deleted.
**Found:** UniFFI's generated `errorDescription` prints the Swift type name,
so the app maps errors itself; `flat_error` alone gave Swift no kind to
translate, so the bridge keeps kinds. `SignedIn` must not derive `Debug` (it
holds the token). ring targets the newest SDK unless
`IPHONEOS_DEPLOYMENT_TARGET` is set (linker warnings for iOS 26). A release
core logs warnings only. `simctl pbcopy` did not reach the app on this Mac;
the Mac's clipboard did. A skipped XCTest still runs its `defer`.
**Deviations:** dc-ffi declares its own lint set (UniFFI's scaffolding needs
`unsafe`). The token crosses the bridge in plain text until I5–I8 (it stays
in-process). The `accessToken` wipe in `ImmichClient.init` goes at I11.
**Gate 2:** Simulator UI tests passed (sign-in, wrong password, restore with
the grid filling, sign-out, reinstall → the form); the new screen checked in
English (light, dark) and Russian.
**Gate 3:** security — 0 HIGH, 0 MEDIUM, 7 LOW, fixed (SSO past the core
removed; unscrubbed panic text; the marker before first unlock; private
logs in release; the test's password and results; the token kept inside
`CoreBridge`) or recorded (restore's address check is looser than sign-in's
— the deployment is not stored yet, with I4b; the password is not zeroed;
sign-out does not revoke on the worker). Spec — 3 HIGH, fixed: a 401 left
the session to be restored; the S1 claim was overstated (now in part); the
audit job would fail (deny.toml; and `url` 2.5.9 for a new advisory).

## I2 + I3 — Only what the worker serves            2026-11-27

**Planned:** `docs/mobile/plans/I2-I3-v1-scope.md` (Gate 1 before the code;
the route check written first). **Did:** ~9,000 lines of HomeRoll features
out (the plan's Out list and the extras in As built); backup originals only,
no tags, no Free Up; every delete permanent behind its warning (D30).
**Found:** the worker's `search/metadata` reads an older request shape (every
filtered list was the whole library); restore is refused; the month route
ignores `visibility` and some rows send `duration` as text — HomeRoll's
strict decoder blanked a whole month (880 photos as grey tiles) and never
read the hidden flag, so hidden photos were not behind Face ID. All fixed on
the phone; seven worker bugs to Linux (NOW.md).
**Gate 3:** security — 1 HIGH (hidden photos, fixed), 1 MEDIUM (a short
column crashed decoding on every launch, fixed), LOWs fixed or recorded
(old Spotlight/notification data: only ever on the Simulator, no sweep;
check-routes ignores methods). Spec — 2 HIGH (hidden; the single-asset
duration), fixed; MEDIUMs fixed (capture-time retries, dead controls, Free
Up and Recently Deleted wording) or recorded ("server" wording for hosted
users → I4c follow-up; stale strings → I11).
**Gate 2:** partly — SignInTests pass; library (all 2,176 items, footer
1,916 photos + 260 videos), viewer and info panel checked in English. The
rest (Collections, an album, the map, Backup, Russian, hide/unhide) and the
build of the Gate 3 fixes wait for Xcode's reinstall.

