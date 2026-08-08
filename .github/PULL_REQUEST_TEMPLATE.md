<!--
Small and focused, please: one behaviour change per PR.

Delete any section that does not apply — an empty heading is worse than no
heading.
-->

## What was wrong

<!-- The symptom, ideally as a user would have reported it. -->

## How you know

<!-- What you observed, reproduced, or measured. "It looked wrong" is a start;
     "the batch throws on isFavorite=1 and sync never acks" is a diagnosis. -->

## What you changed

<!-- And, if the change looks convoluted, which constraint forced it. Most of
     the strange-looking code here comes from one of the four in CONTRIBUTING.md. -->

---

## Checklist

- [ ] `npm test` passes in every package I touched
- [ ] `npx tsc --noEmit` passes (for TypeScript packages)
- [ ] For a bug fix: **a test that fails before this change.** Several bugs here
      have been fixed twice because the first fix had no test.
- [ ] I grepped for the callers of anything I changed, and there is at least one.
      Four separate fixes in this project have been made to code that is never
      executed.

## If this touches any of these, say how it stays safe

- [ ] `requireAuth`, session signing, or the owner gate — there have been two
      complete authentication bypasses here, and both looked innocuous in review
- [ ] What `/proxy` will fetch — it relays to `api.telegram.org` and nothing
      else, on purpose
- [ ] Anything `sync.ts` emits — the mobile client parses it in a strict isolate
      and one unexpected value aborts all sync permanently
- [ ] Query strings built from user input, or per-user data reached without an
      owner filter
- [ ] Behaviour that differs between hosted and self-hosted — there are five
      such places and a sixth is a bug unless `docs/PARITY.md` says otherwise

## Anything reviewers should look at hardest?

<!-- Naming your own uncertainty gets you a better review. -->
