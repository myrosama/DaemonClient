# Photos Single-User Soak Test Runbook

## Objective

Validate one-user production reliability for 7-14 continuous days.

## Required Scenarios Per Day

1. Upload 20 mixed images and 5 videos.
2. Browse timeline for at least 10 minutes.
3. Open 30 thumbnails and 10 full assets.
4. Seek in at least 3 videos.
5. Delete and restore at least 3 assets.
6. Force one network interruption during upload and confirm resume.

## Metrics Gates

- Upload success rate >= 99.5%
- Download success rate >= 99.5%
- Thumbnail miss rate <= 1%
- Resume recovery success >= 99%
- No unrecoverable queue state

## Incident Classification

- P0: data loss, undecryptable finalized asset, repeated auth failure
- P1: failed resume, severe timeline breakage, frequent 429 loops
- P2: minor UI inconsistency, non-critical metadata mismatch

## Daily Report Template

- Date:
- Build version:
- Scenarios executed:
- Pass/Fail count:
- Errors by code:
- Top regression:
- Fix committed:
- Gate status:

## Promotion Rule

Stage A is complete only if no P0/P1 is observed during 7 consecutive days.
