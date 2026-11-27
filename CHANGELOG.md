# Changelog

Notable changes, newest first. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Releases matter more here than in most projects.** A self-hosted install
> checks this repository's **GitHub releases** feed (at most every 12 hours) and
> `daemonclient status` reports a newer tag (`workers/user-worker/src/update-check.ts`).
> That feed is the only way a self-hoster learns a fix exists. A change that
> ships to the hosted service without a tagged release reaches nobody who runs
> this themselves.
>
> There are currently **no published releases**, so every self-hosted install's
> update check finds nothing. Cutting the first one is an outstanding task.

## Unreleased

### Removed
- The optional HEIC processor (operator decision, 2026-11-20): `processor/`,
  `daemonclient processor`, setup's processor step, `/api/server/processor`,
  the deployment service's `POST /processor`, the portal's `/setup/processor`
  step and Photos' Automate dialog. HEIC thumbnails come from Photos' in-browser
  Fix HEIC tool.

### Changed
- The repository was split: operator-only material for the managed service
  moved to a private repository, and everything unreachable was deleted.
  `frontend/` (301-only), `photos/` (stock images), `screenshots/` (of the
  retired `frontend/` UI) and `e2e-tests/` (never ran) are gone.
- Documentation rebuilt around `docs/ARCHITECTURE.md`, a machine-readable
  `docs/openapi.yaml`, and a README per component directory.

### Added
- `docs/ARCHITECTURE.md` — the complete explanation of how the system works.
- `docs/openapi.yaml` — the worker API as an OpenAPI 3.1 document.
- `docs/ROADMAP.md` — what is planned, and what deliberately is not.
- CI coverage for `selfhost/`, including a guard on its dependency budget.
- `CODE_OF_CONDUCT.md`, issue templates, and a pull request template.

### Fixed
- **Self-hosted installs stopped reporting updates after the first `update`.**
  `BUILD_VERSION` — the value the daily release check compares against — was
  read by `setup` from the **gitignored** root `package.json` (which has no
  `version` key, so every install stamped `0.0.0`) and written by `update` as
  the **git short SHA**. The worker parses versions with
  `/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/`, so a SHA either fails to parse or reads
  as an enormous major version; either way the banner never appeared again.
  Both paths now read a tracked root `VERSION` file through one shared module.

  This matters more than a normal bug: the releases feed is the only channel by
  which a self-hoster learns a security fix exists.
- A `.gitignore` rule of `*.txt` was silently ignoring every `robots.txt` and
  `requirements.txt` in the tree; the ones that survived did so only because
  they predated the rule. `accounts-portal` and `daemonclient-site` had both
  lost theirs. Now `/*.txt`, and both files are tracked again.

### Security
- A Telegram `API_ID` and `API_HASH` were hardcoded in
  `backend-server/generate_session.py` and published in this repository's
  history. The file has moved and now reads them from the environment.

  Scope, stated precisely: these identify an *application*, not an account.
  Holding them does not let anyone sign in as anyone — that still needs a phone
  number and a login code. What they do allow is a third party presenting
  themselves to Telegram as this app, and abuse attributed to it can get the app
  restricted, which would break managed bot creation. Telegram does not offer
  rotation for an `api_hash`, so there is nothing to revoke; the practical
  answer is to watch for the app being flagged and register a fresh one if it
  is.

  The credential that *would* be account-level access is the Telethon session
  string. Those live in Firestore, are read at runtime, and have never been in
  git.
- The Firebase web API key remains in tracked source. It is a public
  identifier rather than a secret, but a fork inherits the operator's project,
  so it should be restricted by referrer and templated out.

---

## Earlier

This file starts here. For anything before it, `git log` is the record — the
project was developed in the open and every change is there with its reasoning
in the commit message.

Two prior milestones worth naming, since the code refers to them:

- **Schema 1.2.0** — added Drive's `files` table, and server-side SHA-1
  checksums so re-installs deduplicate instead of re-uploading a whole library.
- **27 July 2026** — self-hosted installs created before this date could have
  encryption switched on with no key, and stored photos unencrypted while
  reporting otherwise. See
  [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md#if-you-set-this-up-before-27-july-2026).
