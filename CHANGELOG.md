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
- A live Telegram `API_ID` and `API_HASH` were found hardcoded in
  `backend-server/generate_session.py` and published in this repository's
  history. The file has moved and now reads them from the environment.
  **Removing a file does not unpublish it — these credentials need revoking at
  [my.telegram.org](https://my.telegram.org).**
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
