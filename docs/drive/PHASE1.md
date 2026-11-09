# New Drive — Phase 1 design note

Spec: `docs/drive/FILEBROWSER_SPEC.md` (draft PR #5, branch
`docs/drive-file-browser`), §7 Phase 1. Code: branch `feat/drive-web`.

Phase 1 turns the imported File Browser frontend into a static, rebranded,
locked-down shell served at `drive.daemonclient.uz/next/`. It has no backend
yet: the adapter, sign-in and service worker are Phase 3. The beta shares an
origin with the current Drive app, so the shell is hardened before it does
anything. Nothing is live: `/next/` has only been deployed to a preview
channel.

## What was done

| Step | Commit | Notes |
|---|---|---|
| Import `e8a388f` unmodified | `e5f96fa` | `frontend/` only, as `drive-web/`. Gate 3 checked it blob for blob against upstream. |
| Licence and NOTICE | `f55462d`, `c35493e` | Upstream has no NOTICE file and no per-file notices at `e8a388f`. Changed files carry a header; changed JSON and generated files are listed in `drive-web/MODIFIED.md`. Every build writes `THIRD_PARTY_LICENSES.txt` (every production dependency, File Browser, and the Roboto fonts: Apache-2.0 per googlefonts/roboto v2). |
| Strip | `60e0f20` | Users, global settings, the shell, tus, sharing, Copy, the login page and reCAPTCHA. Moving (drag, cut and paste) stays. The token is no longer written to `localStorage` or a cookie. A signed-out visit shows `/403` until Phase 3 sends it to the accounts portal. |
| Static config | `20c50f7` | The Go template and `window.FileBrowser` became `src/utils/constants.ts` and Vite's `base: "/next/"`. The legacy plugin (inline loader scripts) and pre-compression are gone. |
| Rebrand | `d550134`, `c35493e`, `4977b12` | Name, manifest, the approved Drive icon, Drive's blue. A credits line with the source link (AGPL-3.0 §13), "Based on File Browser" and the licences shows in the sidebar, in Help and on the error pages. Error reports open an issue here. `noindex`. |
| No CDN; epub | `c7bba73` | Ace fetched modes and themes from `cdn.jsdelivr.net`; they are now bundled (`ace-builds/esm-resolver`) and Ace's script-URL workers are off. The epub reader opens no popups, runs no book scripts and sends no credentials. |
| Hosting | `b8a2d91`, `f3b04ef` | `npm run build:all` in `drive/` builds the landing page, the current app and `next/` (drive-web's own build, so the typecheck runs). `/next/assets/**` → 404 when missing; `/next/**` → the app. |
| CSP and Trusted Types | `f3b04ef` | See below. |
| CI | `4977b12` | A `drive-web` job: lint, tests, build. |

## CSP for `/next/**`

```
default-src 'none'; manifest-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:;
font-src 'self' data:; media-src 'self' blob:; connect-src 'self';
worker-src 'self'; frame-src 'self'; object-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'none';
require-trusted-types-for 'script'; trusted-types vue dompurify default
```

Plus `Cross-Origin-Opener-Policy: same-origin`. Pages are never cached;
assets are cached for an hour (a 404 for a missing asset is cached too, so it
must not outlive a rollback).

**Trusted Types.** Vue and DOMPurify create their own policies. A `default`
policy (`src/utils/trusted-types.ts`, loaded first) passes other libraries'
HTML strings (Ace, video.js, epub.js `srcdoc`) through DOMPurify. `DOMParser`
input passes unchanged: a parsed document is inert, and epub.js parses a
book's XML with it, which HTML sanitising destroys. The policy claims
DOMPurify's policy name first and refuses to re-enter, so it can't recurse.
It defines no `createScript` or `createScriptURL`, so a script URL can't be
built from a string. Vue sends `v-html` through its own pass-through policy,
so Trusted Types doesn't guard it: the lint rule `vue/no-v-html` does, with
one exception for the sanitised markdown preview.

Checked in Chrome on the preview: an `onerror` handler assigned via
`innerHTML` comes out stripped; `script.src = "..."` throws; an epub
`container.xml` parses and its rootfile is found; Ace with the editor chunk
loaded renders, loads its JavaScript mode and its twilight theme from the
bundle, with no console errors.

**Where it differs from spec §5, and why:**
- A `default` Trusted Types policy beside the named `vue` and `dompurify`
  ones (spec: named policies only). Ace, video.js and epub.js assign plain
  strings to HTML sinks, and the app can't name a policy for code it doesn't
  own. The default policy runs DOMPurify's default config, so those strings
  can't carry scripts or event handlers, but `<style>` and forms survive it;
  phase 3 narrows it once those libraries' real inputs are known (see epub
  below).
- `style-src 'unsafe-inline'`: Ace and video.js inject `<style>` elements and
  the loading screen has one. Styles can't run code, and markdown previews
  can no longer carry styles (below).
- `data:` in `img-src` and `font-src`: Vite inlines small assets; the icon and
  video fonts are inlined.
- `form-action 'none'` (spec: `'self'`): stricter; the one form calls
  `preventDefault`.
- PDFs preview in an `<iframe>` instead of `<object>`, so `object-src 'none'`
  holds.
- `connect-src 'self'`: Phase 1 talks to nothing. Phase 3 adds exact hosts.

## v-html and other HTML sinks

- `Editor.vue` markdown preview, the only `v-html`: `marked` output goes
  through DOMPurify with `<style>`, forms and `style=` forbidden and named
  properties sanitised, so a document can't restyle the app or draw a fake
  form. Images can only come from the origin, `blob:` or `data:`.
- `utils/buttons.ts` writes icon names with `textContent`.
- Every `window.open` passes `noopener`; every `target="_blank"` link has
  `rel="noopener noreferrer"`.

## Gate 2 (natural conditions)

A Firebase preview channel with the real rewrites and headers; the live site
is untouched (`drive.daemonclient.uz/next/` still serves the landing page).
`https://daemonclient-drive--next-p1-2cvubfrq.web.app`, expires 2026-11-16.

```
/next/                            200 no-cache, COOP same-origin, the CSP above
/next/files/a                     200 no-cache                  (the app)
/next/assets/does-not-exist.js    404 public, max-age=3600
/next/assets/index-*.js           200 public, max-age=3600
/next/THIRD_PARTY_LICENSES.txt    200 text/plain
/                                 200 the landing page
/dashboard                        200 the current app
```

Chrome, clean profile: `/next/` routes to `/next/403`, which shows the
credits line; console empty. With a test user injected into the store,
`/next/settings/profile` renders 43 editor themes; console empty. The Ace
check above ran on this build. Earlier builds caught two bugs that are fixed:
`ace is not defined` on the settings page, and `/next/` redirecting to itself
(a Firebase redirect matched `/next/` too; removed).

## Gate 3 (three separate agents)

**Security:** no HIGH. Fixed: Trusted Types, the CSP tightened to the spec,
COOP, the missing-asset response, the markdown sanitiser config, `noopener`,
the DOMPurify and vue-i18n bumps.

**Spec conformance:** fixed H1 (licences file), H2 (Trusted Types), M1 (CSP
vs §5; the remaining differences are listed above), M2 (credits visible
where signed-out visitors land), M3 (CI job; `build:all` typechecks), L2
(colours), L3 (missing assets), L5 (licence bookkeeping), the dead CSS,
cookie helper and tus type from L6, and L8 (this note).

**Second security review** (a fresh agent, on the fix commits `c35493e`,
`f3b04ef`, `4977b12`): no HIGH; script execution stays closed. Fixed in
`6d0e1b8`: the default policy broke epub parsing (MEDIUM); `v-html` bypasses
Trusted Types (lint rule); the recursion guard; `frame-src blob:` dropped.

**Accepted, tracked:**
- **Shared scheduler module → Phase 3** (L1). Photos' scheduler
  (`immich/web/src/service-worker/media-scheduler.ts`) imports a Photos-only
  type, and its second user, Drive's service worker, arrives in Phase 3.
  Phase 3 extracts it first; both service workers import the one module, no
  copy in drive-web; `media-scheduler.spec.ts` and `media-session.spec.ts`
  re-run; Photos gets its own Gate 2; NOTICE's Nuke paragraph gets the new
  path. The spec (§1, §4 Streaming, §7) needs the matching edit on PR #5,
  with the owner's OK.
- **Move tests → Phase 4** (L7). Removing Copy made Ctrl+drag and paste
  always move. The handlers are inside `<script setup>`; Phase 4 rewrites
  moves against the adapter with the spec's move tests (a folder can't move
  into itself), which will cover this.
- **Phase 3/4 UI leftovers** (L6): the checksum buttons in Info (§4 drops
  checksums), preference saves still calling `users.update` (§4: local
  storage), the "change password" link to the portal, the "copy/move" label
  in Profile, `user.d.ts` fields, and 11 unused Ace worker chunks (~3 MB, never
  fetched).
- **Deploys** (L4): `npm run build` in `drive/` empties `dist/`, so it drops
  `next/`. Until `/next/` goes live it doesn't matter; from then on Drive
  deploys use `npm run build:all`. Self-hosted Drive doesn't build `next/`
  (spec: self-hosted Drive deferred).

## Carried into Phase 3 (from the security review)

- **No tokens in URLs.** Thumbnails, `<img>`, `<audio>`, video `<source>`,
  `<track>`, the PDF iframe, the epub URL, the download anchors, `window.open`
  and `<link rel=prefetch>` all take URLs from the URL builders. Upstream
  authenticated them with a cookie, now removed; in Phase 3 the `/next/`
  service worker serves them, never `?auth=`.
- **Service-worker responses carry their own headers**, since Firebase's
  don't apply: port the current app's stream headers (sandbox CSP, nosniff,
  attachment for unknown types, `text/plain` for HTML and text), add
  `frame-ancestors 'self'` and `Cross-Origin-Resource-Policy: same-origin`,
  and pick the content type from an allowlist, never from the stored type.
- **Handoff to the right worker.** Post the token and key only to the
  registration whose scope is exactly `origin + "/next/"`, never to
  `navigator.serviceWorker.controller`, with a message type unique to the new
  worker; the new worker accepts a handoff only when `event.source.url` is
  inside its scope.
- **Session.** `Authorization: Bearer` instead of `X-Auth`; drop the
  `X-Renew-Token` path; one renewal at a time with bounded retries; the token
  never goes to the Firebase origin (today `renew()` would post it to
  `/next/api/renew`). Permissions are enforced by the worker; the decoded
  token only drives the UI.
- **Sign-out:** the auth hub sign-out, a `BroadcastChannel` to other tabs,
  clearing IndexedDB, the handoff, and the `book-progress`, `book-size` and
  `editorFontSize` keys.
- **The other pages on the origin.** Before a token lives in `/next/`, every
  other page on `drive.daemonclient.uz` gets a script CSP as strict as the
  app allows (or the owner accepts the gap in writing), and the `$el.__vue__`
  mixin in `main.ts` goes.
- **epub under Trusted Types.** Parsing works now, but chapters still don't
  render right: the default policy turns a chapter's `srcdoc` into body
  content only (checked: `<head>`, `<link rel=stylesheet>`, `<style>` and
  `<meta>` are dropped), DOMPurify strips `blob:` images, and epub.js writes
  its theme CSS with `innerHTML` inside the chapter frame, which has no
  default policy and throws. Likely fix: epub.js's `method: "blobUrl"` (then
  `frame-src` needs `blob:` again) plus `blob:` in `style-src`/`font-src`;
  the chapter frame keeps its no-scripts sandbox, which is the real barrier.
  Test with a real book.
- **The service worker needs a named policy.** `serviceWorker.register` takes
  a TrustedScriptURL: add a policy (e.g. `drive-sw`) whose `createScriptURL`
  accepts only `origin + "/next/sw.js"`, and add it to `trusted-types`. Never
  give `default` a `createScriptURL`.
- **The PDF iframe** has no `sandbox`, so its safety rests on the worker's
  headers; Chromium may refuse to render PDFs under a sandbox CSP. Check both
  in Gate 2: a `.pdf` whose bytes are HTML must not render as HTML, and real
  PDFs still render.
- **Narrow the default policy** once instrumented: DOMPurify's default config
  keeps `style=`, a non-leading `<style>`, forms and arbitrary ids. Nothing
  untrusted reaches an element sink today; log `DOMPurify.removed` in dev
  builds during Gate 2 to see what the libraries really send.
- `Cross-Origin-Opener-Policy: same-origin` rules out popup sign-in; the
  portal redirect is unaffected.
- **Gate 2 under the CSP:** video.js (not exercised yet: no player was
  started in phase 1) and its bundled vtt.js for subtitles, epub, the PDF
  iframe with the worker's headers, Ace's modes.
- `return_url` built from `location` only; the portal validates it.
