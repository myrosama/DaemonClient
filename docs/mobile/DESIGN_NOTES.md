# Mobile apps — design notes

One entry per task: what the plan said, what happened, decisions made along
the way, security findings, and the gate evidence. After a context reset, the
*why* is reconstructed from here — read it, do not re-derive it.

Append, never rewrite. A note that turns out wrong gets a correction under it.

**Format:**

```
## <task> — <title>            <date>

**Planned:** what the phase plan said.
**Did:** what actually happened, and any deviation with its reason.
**Decisions:** anything chosen at implementation time that the plan left open.
**Security:** findings raised, fixed, or accepted-and-tracked.
**Gate evidence:** G1 test names · G2 transcript/screenshots described · G3 reviewers and findings · G4 commits.
```

---

## — Research, spec and plan            2026-10-04

**Planned:** nothing; this preceded the plan.

**Did:** researched Drive UI references and the existing storage formats
(`RESEARCH.md` §1–§6), wrote `SPEC.md` (approved by the operator the same day)
and `PLAN.md` with the detailed P0 plan.

**Decisions:**
- Order changed by the operator from core → Drive → Photos to
  core → **Photos** → Drive (D7).
- Cargo workspace root moved from `mobile/core/` (first draft) to `mobile/`
  so the flutter_rust_bridge crate can be a workspace member: one lockfile,
  one build folder (D13).
- Images are decoded by the platform, not by Rust — PhotoKit / ImageDecoder
  read HEIC, RAW and video frames with hardware acceleration. Rust's work in
  media is decryption, range-to-part mapping and prefetching (SPEC §5.1).
- HEIC on Android goes through a JPEG preview made by the uploading phone;
  storing it needs `clientUpload` to accept `telegramPreviewId` — an additive
  worker change for the Linux machine (SPEC §5.1).
- Background upload reuses the fork's `background_downloader` (URLSession on
  iOS) to send pre-encrypted parts straight to Telegram (SPEC §5.2).
- `RustLib.init()` goes first in `initApp()`, not in `main()`, because the
  existing integration tests call `initApp()` but not `main()`.

**Blockers found:** 19 GB free disk (≥45 GB needed, P0 Task 0.1); no JDK; no
iOS Simulator runtime yet.

**Gate evidence:** docs only — no gates apply.
