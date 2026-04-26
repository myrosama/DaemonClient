# Photos DaemonClient Implementation Handoff

This document is the execution companion for the research plan. It describes what was implemented and how to continue.

## Implemented Foundations

- Contract model and normalization in `immich-api-shim/src/contracts.ts`
- Control-plane policy endpoints in `immich-api-shim/src/policy.ts`
- Feature flags endpoint and defaults in `immich-api-shim/src/feature-flags.ts`
- Request correlation IDs in `immich-api-shim/src/index.ts`
- Upload session validation and manifest normalization in `immich-api-shim/src/assets.ts`
- Photos media engine (chunking, retries, resumable upload sessions, decrypt merge) in `frontend/src/photos/media-engine.js`
- Smart thumbnail loading + prefetch + cache control in `frontend/src/photos/thumbnail-loader.js`

## Control Plane Endpoints

- `POST /api/policy/upload-session`
- `GET /api/policy/upload-session/:id`
- `POST /api/policy/upload-session/:id/complete`
- `POST /api/policy/worker`
- `GET /api/policy/health`
- `GET /api/policy/flags`

## Stage A Completion Checklist

1. Wire `PhotosMediaEngine` into the active upload UI flow.
2. Wire thumbnail loader into timeline/gallery rendering.
3. Emit telemetry with `x-request-id` for every client network call.
4. Run single-user soak using `docs/photos/SOAK_TEST_RUNBOOK.md`.
5. Close all P0/P1 defects prior to stage promotion.

## Stage B Completion Checklist

1. Per-user quotas tuned by production telemetry.
2. BYO worker onboarding integrated with `POST /api/policy/worker`.
3. Rollout executed in rings (internal, alpha, 1%, 10%, 25%, 50%, 100%).
4. Rollback playbook validated with game-day simulation.

## Risks and Mitigations

- Risk: upload API currently persists one asset per request in existing flow.
  - Mitigation: migrate UI to session-driven finalize flow with deterministic idempotency key.
- Risk: background mobile constraints differ across platforms.
  - Mitigation: keep queue state durable and recoverable with strict replay safety.
- Risk: user misconfigured BYO workers.
  - Mitigation: worker health checks + direct-path fallback.
