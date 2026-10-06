# Clean-up proposal — `immich/`            2026-10-06

**Status: PROPOSAL — nothing is deleted until the operator approves it and the
Linux machine has verified the website still builds and deploys.** (SPEC D12,
§5.7; P0 Task 0.6.)

`immich/` holds the whole upstream Immich monorepo. DaemonClient ships only the
website (`web/`, live at photos.daemonclient.uz) and the mobile app
(`mobile/`). Everything below was checked with `grep`/`git ls-files` on
2026-10-06; the evidence for each row is in the last column.

## What we use — keep

| Path | Tracked files | Why it stays (evidence) |
|---|---|---|
| `web/` | 770 | The live Photos website. |
| `mobile/` | 1,602 | The Photos app. |
| `i18n/` | 81 | Translations for both: `web/svelte.config.js:71` (`$i18n: '../i18n'`); `mobile/bin/generate_keys.dart:101`, `mobile/mise.toml:162`. |
| `open-api/` | 20 | `web/package.json`: `"@immich/sdk": "workspace:*"` → `open-api/typescript-sdk`; the spec is also the source of the mobile app's generated Dart client. |
| `FORK.md`, `LICENSE`, `README.md` | — | Attribution and the AGPL licence must stay with the code. |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.pnpmfile.cjs`, `.gitignore`, `.gitattributes`, `.editorconfig` | — | The website's build runs through this pnpm workspace (edited, see below). |
| `mise.toml` | — | Monorepo root for `mobile/mise.toml` (edited, see below). |

## Not used by anything we build or deploy — propose to delete

| Path | Tracked files | Size | Evidence it is unused |
|---|---|---|---|
| `server/` | 631 | 4.9 MB | Not deployed (`FORK.md:18`); the API is `immich-api-shim`. No import from `web/` or `mobile/` (`grep -rn '\.\./server'` → none). |
| `machine-learning/` | 48 | 0.9 MB | Not deployed (`FORK.md:18`); no references. |
| `e2e/`, `e2e-auth-server/` | 87 + 5 | 0.8 MB | Upstream server tests; `e2e/test-assets` is a git submodule (`.gitmodules`) we never fetch. |
| `cli/` | 23 | 0.2 MB | Upstream's Immich CLI; not shipped. |
| `docs/` | 297 | 16 MB | Upstream's docs site; ours is `docs-site/`. |
| `design/` | 13 | 2.3 MB | Upstream design files; no reference from `web/` or `mobile/`. |
| `plugins/` | 10 | 52 KB | A pnpm workspace package that `web/` does not depend on. |
| `docker/`, `deployment/`, `.devcontainer/`, `.dockerignore`, `Makefile` | 10 + 18 + 7 + 1 + 1 | 0.2 MB | Docker/dev-server tooling for the upstream server. |
| `.github/` (inside `immich/`) | 35 | 0.2 MB | GitHub never runs workflows from a sub-folder; it is listed as a pnpm package only for a prettier script. |
| `misc/`, `readme_i18n/` | 3 + 18 | 0.2 MB | Upstream's misc and translated READMEs. |
| `fastlane/` | 2 | — | Upstream's store-listing text; ours gets written in P4. |

Total: about 1,200 tracked files and ~26 MB of source, plus the time and
disk every `pnpm install` spends on the server's dependencies (`sharp`,
`bcrypt`, `nestjs`…).

## What has to change with the deletion

1. `pnpm-workspace.yaml` `packages:` → only `i18n`, `open-api/typescript-sdk`,
   `web`. Drop the `ignoredBuiltDependencies` / `onlyBuiltDependencies` /
   `packageExtensions` entries that only served deleted packages.
2. `pnpm-lock.yaml` regenerated with `pnpm install` (a large diff, expected).
3. `immich/mise.toml`: `config_roots` → `mobile`, `web`; drop the tools only
   the server needed (it currently makes mise install Node, pnpm, Terragrunt
   and OpenTofu whenever someone works under `immich/`, and pins Flutter
   **3.41.6** while `mobile/` pins 3.41.7). Keep the `open-api/typescript-sdk`
   tasks if the web build uses them.
4. `.gitmodules`: remove the `e2e/test-assets` entry.
5. `FORK.md`: update the "what we use" table.

## Verification before it lands

- **Linux machine:** a clean clone of the branch → `pnpm install` → the exact
  command the deploy uses for `photos` → deploy to a preview channel (not
  production) and open it. Only then merge.
- **MacBook:** `flutter pub get`, translations, `flutter build ios --simulator`
  and an Android build still pass.
- Upstream merges get easier for the kept folders and impossible to conflict
  in the deleted ones; record the deletion in `FORK.md` so a future
  `git merge upstream/main` knows to drop those paths again.

## Separate, later: unused Immich features inside the apps

Not part of this proposal — P2 Task 2.10 lists them. The Linux machine's
approved web decisions (memory `project_photos_audit_decisions.md`: delete
admin / buy / register / onboarding / maintenance screens; hide map and smart
search) are the starting list, so web and app match.
