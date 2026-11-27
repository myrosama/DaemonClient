# I1 — HomeRoll in `apps/ios`, under our identity

**Task I1 of `docs/plan/ENGINE.md` §9.** Written before the code (GATES.md,
Gate 1). Decisions it follows: D27 (start from HomeRoll), D28 (distinct from
Apple's Photos; named "Phosphor Photos" with D31), D30 (English + Russian), the I0b requirements
(no credential in a shared container — no App Group, no extensions).

**Not in I1:** removing features the worker does not serve (I2, I3), Free Up
(hidden in I3; no build reaches a phone before then), the core (I4 on).
HomeRoll's own server layer stays, so Gate 2 compares with the I0 baseline.

## Steps

1. **Import with history kept small and upstream reachable:**
   `git subtree add --squash --prefix apps/ios <HomeRoll> main` at `bd90811`
   (the placeholder README removed first). One squashed commit says exactly
   what came from upstream; later upstream fixes can come in with
   `git subtree pull --squash`. Then I1's own changes in a separate commit,
   so the diff shows only what we changed.
2. **Out:** `server/` (Immich add-ons), `tools/`, `sidestore.json`, `docs/`
   (Immich setup, screenshots), HomeRoll's `README.md` (replaced by ours,
   crediting HomeRoll). HomeRoll's `LICENSE` (GPL-3.0) stays in `apps/ios/`.
3. **Extensions and App Group out:** the `FotosShare` and `FotosWidget`
   targets, `Share/`, `Widget/`, `Shared/AppGroup.swift`, `WidgetFeeder.swift`
   and every call to them; the App Group entitlement (the app then has no
   entitlements file); `Shared/FileChunks.swift` moves to `App/Core/` (backup
   uses it).
4. **Identity:** project `DCPhotos`, bundle id `uz.daemonclient.photos`,
   display name **"Phosphor Photos"**; the Keychain service, BGTask ids and the
   background session id renamed to `uz.daemonclient.photos.*`; the
   `homeroll` URL scheme no longer registered (external links could open
   hidden photos — I0b); "HomeRoll" in the UI (login title, version lines,
   diagnostics) becomes "Phosphor Photos"; the app icon is ours
   (`apps/brand/icons/photos-ios-1024.png`).
5. **Languages (D30):** the string catalogs switch their source language to
   English, keep English and Russian, drop German. HomeRoll's German keys stay
   in the Swift code for now (invisible to users; I11 renames them); the
   Info.plist permission texts become ours, in English and Russian.
6. **NOTICE:** HomeRoll credited (copyright its authors, GPL-3.0, combined
   under AGPL-3.0 §13); `apps/ios/README.md` says where the code came from
   and how to build.

## Tests (written first)

`apps/ios/tools/check-identity.sh` + a self-test, run in CI. It fails on the
imported code and passes after I1:
- no `org.homeroll`, `group.`, `AppGroup`, `WidgetFeeder` or URL-scheme
  registration anywhere in `apps/ios`;
- `project.yml`: bundle id `uz.daemonclient.photos`, display name
  `Phosphor Photos`, exactly one target, no App Group;
- every string catalog: source language `en`, no `de`, every key has an
  English value (or is the empty key);
- no user-visible "HomeRoll" outside comments and NOTICE / README / LICENSE.

## Gate 2 (Simulator, test account, compared with I0)

Built with XcodeGen and `sim-run.sh`; signed in by token; the home screen
shows **"Phosphor Photos"** with our icon; the library, thumbnails and the viewer
work as in I0; English and Russian (launched with `-AppleLanguages (ru)`)
both show translated screens; no German anywhere. Screenshots of the test
account are not committed or shared (D30).

## Gate 3

Two separate reviews: security (what the identity change could break — the
Keychain item, background tasks, anything left in a shared container) and
spec (this plan, D27/D28/D30, I0b).
