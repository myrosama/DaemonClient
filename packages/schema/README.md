# schema — the D1 schema, defined once

Two files, no build step, no dependencies:

- `schema.mjs` — `MIGRATION_SQL`, `DRIVE_MIGRATION_SQL`, `splitStatements()`
- `schema.d.mts` — types for the TypeScript side

## Why this is its own directory

The schema used to exist three times: inline in `deployment-service`, in a
never-executed copy inside the worker, and recovered by the self-host CLI
**string-scraping the deployment service's TypeScript**.

That is exactly how managed and self-hosted installs came to differ in the one
place it mattered most. The seed inserts `zke_password` and `zke_salt` **empty**
and relies on a second step to fill them. The managed provisioner ran that step.
The CLI did not. So every self-hosted install had encryption switched on with no
key to encrypt with — and the worker treated "no key" and "encryption off" as
the same thing, storing photos in Telegram unencrypted under their original
filenames while the padlock in the UI said otherwise.

Two copies and a scraper cannot be kept in step by discipline. There is now one
module and both provisioners import it.

**If you add a column, add it here and nowhere else.**

## Why plain `.mjs`

The deployment service is TypeScript bundled by wrangler; the self-host CLI is
dependency-free `.mjs` run straight from a clone. An `.mjs` file with no imports
of its own is the only form both consume without either growing a build step.

## Two properties the seed depends on

**`INSERT OR IGNORE`, never `OR REPLACE`.** The seeded key rows are empty
strings. Replacing a live `zke_password` with `''` would make every photo
already in the user's channel permanently undecryptable.

**It must be replayable.** `daemonclient update` runs it on every invocation and
setup runs it again when resuming an interrupted install. A plain `INSERT`
raises `UNIQUE constraint failed: config.key` the second time — which does not
match the already-exists pattern the callers swallow — so `update` aborted
before deploying, on every install that had already been set up.

## `splitStatements()`

Cloudflare's D1 HTTP query endpoint executes **one statement per request**, so
callers cannot post the whole script. This splits it, and drops comment-only
lines because a bare comment is not a statement and D1 rejects it.
