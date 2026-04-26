# Photos Multi-User Rollout and Rollback

## Rollout Rings

1. Internal
2. Alpha
3. 1%
4. 10%
5. 25%
6. 50%
7. 100%

Advance only when each ring meets SLO for at least 24 hours.

## SLO Signals

- Upload success
- Download success
- First preview latency (p95)
- Rate-limit induced failures
- Session creation success

## Rollback Triggers

- Upload success < 98% for 15 minutes
- Download success < 98% for 15 minutes
- P0 issue opened
- Elevated 429/420 errors that do not recover after adaptive backoff

## Rollback Steps

1. Disable `directBytePath` for affected cohort.
2. Keep `mobileResumeV2` enabled to preserve queue recovery.
3. Route users to compatibility fallback path.
4. Preserve diagnostic traces by request id.
5. Announce degraded mode and ETA.

## Post-Rollback Requirements

1. Root cause analysis within 24h.
2. Regression test case added.
3. Canary rerun before reopening ring progression.
