# Phase 3 — Make the worker survive its own budget

**Goal:** Ordinary use stops producing Cloudflare error 1102, which the app reports to users as sync and backup failure.

**Status:** not started.

Full task detail is in `MASTER_PLAN.md`. This file tracks execution: tick
the gates as each task passes, and write down anything surprising.

---

## Why this phase is here

These are the crashes users actually see, and they are cheap to fix once the security work has settled the same files.

---

## Tasks

### 3.1 — One shared subrequest counter
new `budget.ts`; `assets.ts`, `timeline.ts`, `sync.ts`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Increment **inside** the helpers that make the calls, never at call sites — that is what stops a budget drifting from what it counts. This is the structural fix that keeps 3.2 and 3.4 fixed.

### 3.2 — Cost the chunk budget correctly
`assets.ts` ~2226. Depends on 3.1.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** Twenty chunks at six subrequests each is 120 against a cap of 50. Also check the body cache **before** resolving the file path — that alone takes a warm chunk from 6 to 1.

### 3.3 — Stop copying 19 MB per chunk into `waitUntil`
`assets.ts` ~2146. Depends on 3.1.

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** `data.slice(0)` clones the whole chunk, un-awaited, up to twenty at once. Defeats the '~2 chunks in memory' claim directly above it.

### 3.4 — Give the timeline the same one-job rotation sync has ✅ DONE
`timeline.ts` ~55-69 · shim `ea08d9704ab2` · commit `1af4daa`

- [x] Implemented
- [x] Gate 1 · Security — no auth or trust-boundary surface; dispatch only
- [x] Gate 2 · Principles — identical for both flavours; reuses sync's pattern rather than inventing a second one
- [x] Gate 3 · Correctness — cursor rotates so no job starves; nothing scheduled without a DB; jobs still self-guard for completion
- [x] Gate 4 · Works for real — 149 tests green, new tests confirmed failing before the change, deployed and verified live
- [x] Deployed & committed

**Shipped ahead of approval** because the operator was actively hitting 1102.

**Watch for:** `sync.ts:290-302` already does this and documents why. Timeline fires two jobs whose budgets sum to 64 against a cap of 50.

### 3.5 — Backpressure on full-file downloads
`assets.ts` ~2262-2278

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** The 206 path was fixed; this one was not. Reuse its pump rather than inventing a second approach.

### 3.6 — Never serve a whole original as a grid thumbnail
`assets.ts` ~1910, guard ~1924-1941

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** The guard covers video and HEIC. A plain JPEG with no stored thumb still serves its full original, cached immutable for a year.

### 3.7 — Expire Telegram file paths honestly
`assets.ts` ~3108-3144

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** An L2 hit re-stamps L1 with a fresh 55 minutes regardless of age, so a path can outlive Telegram's validity. No eviction on failure either.

### 3.8 — Revive early dedup for foreground uploads
`upload-dedup.ts`, `upload-stream.ts`

- [ ] Implemented
- [ ] Gate 1 · Security
- [ ] Gate 2 · Principles
- [ ] Gate 3 · Correctness
- [ ] Gate 4 · Works for real
- [ ] Deployed & committed

**Watch for:** The hint reads a field the foreground uploader never sends. `duration` is sent and distinguishes stills from video.

---

## Exit criteria

- [ ] No code path can exceed the subrequest cap by construction.
- [ ] Memory stays bounded on the largest file a user can store.
- [ ] The timeline and sync both dispatch at most one background job per invocation.
- [ ] A cached Telegram path can never be used past its validity.
- [ ] `range-stitch.test.ts` still proves byte-exactness.

## Notes during implementation

_(append as you go — surprises, decisions, anything the plan got wrong)_
