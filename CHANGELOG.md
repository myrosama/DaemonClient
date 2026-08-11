# Changelog

Notable changes, newest first. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Releases matter more here than in most projects.** A self-hosted install
> checks this repository's **GitHub releases** feed once a day and shows a note
> in the dashboard when a newer tag exists (`immich-api-shim/src/update-check.ts`).
> That feed is the only way a self-hoster learns a fix exists. A change that
> ships to the hosted service without a tagged release reaches nobody who runs
> this themselves.
>
> There are currently **no published releases**, so every self-hosted install's
> update check finds nothing. Cutting the first one is an outstanding task.

## Unreleased

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
- CI coverage for `selfhost/`, including a guard asserting it stays
  dependency-free.
- `CODE_OF_CONDUCT.md`, issue templates, and a pull request template.

### Fixed
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
