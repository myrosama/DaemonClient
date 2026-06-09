# DaemonClient SEO Plan & Runbook

> A concrete, copy-paste-ready SEO plan grounded in the **actual** repo state
> (verified 2026-06-07). Inspect each snippet, drop it into the named file, then
> rebuild + redeploy that site. This document **changes no code** — it is the
> instruction set you execute later.

## 0. The product map (verified against `firebase.json` + `.firebaserc`)

DaemonClient is one Firebase project (`daemonclient-c0625`) with **5 Hosting
targets**, fronted by DNS on `*.daemonclient.uz`:

| Subdomain | Hosting target | Served from (repo) | What it is | Index it? |
|---|---|---|---|---|
| `daemonclient.uz` | `main` | `daemonclient-site/` | **The real landing page** (brand + Drive/Photos/Accounts overview). Static HTML. | **YES — primary** |
| `drive.daemonclient.uz` | `drive` | `drive/dist/` | Drive marketing landing (`index.html`) + app shell (`app.html`) | **YES** (landing only) |
| `photos.daemonclient.uz` | `photos` | `immich/web/build/` | Immich (SvelteKit) photos **app** — no marketing page exists yet | **NO** (today: app-only) |
| `accounts.daemonclient.uz` | `accounts` | `accounts-portal/dist/` | Signup/login/account portal (React SPA) | **YES** (root only) |
| `app.daemonclient.uz` | `app` | `frontend/dist/` | **Legacy** full landing page (pre-suite). Duplicate-content risk. | **NO — see §1.A** |

Key routing facts that drive the whole plan:

- **Photos** (`firebase.json` target `photos`): `rewrites: ** → /app.html`. That
  `app.html` hardcodes `<meta name="robots" content="noindex">`. **So the entire
  photos host is already `noindex`** — every URL there serves the same noindex app
  shell. There is **no `index.html`, no prerendered landing** in
  `immich/web/build/` (verified). The `/photos/*.webp` cat images staged in the
  build are clearly intended for a future Photos marketing page **that does not
  exist yet**.
- **Drive** is the clean model: `index.html` (marketing, indexable) is split from
  `app.html` (login/dashboard), and `robots.txt` disallows `/login` + `/dashboard`.
- **Accounts** SPA hardcodes `canonical = https://accounts.daemonclient.uz/`, so its
  client-side `/login` and `/signup` routes already consolidate to the root.
- The `daemonclient-proxy` worker is a generic CORS fetch-proxy, **not** a hosting
  router — it has no bearing on canonicalization. www/non-www + trailing-slash are
  handled by Firebase + the `<link rel="canonical">` tag.

---

## 1. Current-state audit (what exists TODAY)

### Per-site `<head>` + crawl-file gap table

Legend: ✅ present & correct · ⚠️ present but wrong/weak · ❌ missing

| Signal | `daemonclient.uz` (landing) | `drive.` | `photos.` (Immich app) | `accounts.` | `app.` (legacy) |
|---|---|---|---|---|---|
| `<title>` | ✅ good | ✅ good | ⚠️ "DaemonClient Photos" (but noindex) | ✅ good | ⚠️ dup of landing |
| meta description | ✅ | ✅ | ✅ (noindex) | ✅ | ⚠️ dup |
| `<html lang>` | ✅ `en` | ✅ `en` | ❌ none on `<html>` | ✅ `en` | ✅ `en` |
| canonical | ❌ **missing** | ✅ self | ❌ (noindex app) | ✅ self | ⚠️ points to `daemonclient.uz/` (**collision**) |
| Open Graph | ❌ **missing** | ✅ full | ❌ | ✅ full | ⚠️ full but dup of landing |
| Twitter card | ❌ **missing** | ✅ | ❌ | ✅ | ⚠️ dup |
| `og:image` target exists? | ❌ file missing | ⚠️ points to `daemonclient.uz/og-image.png` (**404**) | — | ⚠️ same 404 ref | ⚠️ dup |
| JSON-LD | ❌ **missing** | ✅ Org+WebSite+SoftwareApplication+Offer | ❌ | ❌ | ⚠️ has some |
| favicon link + file | ❌ **none** (only `uploads/logo.png`) | ✅ | ✅ | ✅ | ✅ |
| robots meta | (indexable, ok) | (indexable, ok) | ✅ `noindex` (correct) | (indexable, ok) | ❌ should be noindex |
| `robots.txt` | ⚠️ `Allow: /` only | ✅ good | ⚠️ lists auth paths in sitemap ref | ❌ **missing** | ⚠️ `Allow: /` |
| `sitemap.xml` | ⚠️ lists 4 cross-host roots | ✅ minimal | ❌ **lists `/auth/login` + `/signup`** (anti-pattern) | ❌ **missing** | ❌ **lists `/login`,`/signup`,`/dashboard`,cross-host** |

### The 6 concrete problems to fix (in priority order)

1. **`og-image.png` is missing from the landing root** (`daemonclient-site/`), yet
   **both Drive and Accounts** hardcode `https://daemonclient.uz/og-image.png` as
   their OG/Twitter image. One missing file → broken social previews for **three**
   products. (Drive bundles its own `drive/dist/og-image.png`, but its `<meta>`
   still points at the missing landing copy.)
2. **Landing `<head>` is bare** — only `<title>` + description. No canonical, OG,
   Twitter, JSON-LD, or favicon. The brand's #1 ranking target is its weakest page.
3. **`app.daemonclient.uz` (legacy `frontend/dist`) is a duplicate landing** that
   sets `canonical → daemonclient.uz/` and ships a sitemap claiming
   `/login`,`/signup`,`/dashboard`,`/photos`, and cross-host roots. Brand-term
   duplicate of both the real landing and Drive. (See §1.A for the decision.)
4. **Photos sitemap (`immich/web/build/sitemap.xml`) lists `/auth/login` and
   `/signup`** — the exact anti-pattern. They can't even index (whole host is
   noindex) and `/signup` 302s off-domain. Strip them.
5. **Accounts has no `robots.txt` and no `sitemap.xml`.**
6. **Landing & Photos have no structured data**; landing also lacks `<html>`-level
   completeness (favicon).

### §1.A — Decision on `app.daemonclient.uz`

`frontend/dist` predates the suite. You can't tell from the repo alone whether it
still serves traffic, so decide by what's live:

- **If `app.` is dead / unused →** drop the `app` Hosting target (or 301 the whole
  host to `https://drive.daemonclient.uz/` — Drive replaced it). Cleanest.
- **If `app.` must stay live →** make it **non-competing**: add
  `<meta name="robots" content="noindex,follow">` to `frontend/dist/index.html`,
  **delete `frontend/dist/sitemap.xml`** (or replace with an empty allow), and set
  its canonical to whichever URL it should defer to. Never let two hosts both
  canonical to `daemonclient.uz/` with full marketing copy.

> Recommended: **301 `app.` → `drive.`**. It removes a duplicate, consolidates link
> equity into Drive, and matches the roadmap (`app.` was the old Drive).

---

## 2. Per-site `<head>` recommendations (copy-paste-ready)

> Descriptions are all ≤155 chars. Replace the placeholder image only if you ship a
> per-product OG image; otherwise the shared `https://daemonclient.uz/og-image.png`
> is fine **once you create that file** (see §8, action #1).

### 2.1 Landing — `daemonclient-site/index.html`

Replace the current lines 1–7 (`<!DOCTYPE …>` through the `<meta name="description">`)
with this block. This is the biggest single win.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">

<!-- Primary -->
<title>DaemonClient — Free, unlimited, end-to-end encrypted cloud suite</title>
<meta name="description" content="DaemonClient is a free, unlimited, end-to-end encrypted cloud suite you own: Drive for files, Photos for your library, one account.">
<link rel="canonical" href="https://daemonclient.uz/">
<meta name="theme-color" content="#0B0E14">
<link rel="icon" type="image/png" href="/uploads/logo.png">
<link rel="apple-touch-icon" href="/uploads/logo.png">

<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="DaemonClient">
<meta property="og:title" content="DaemonClient — Free, unlimited, encrypted cloud suite">
<meta property="og:description" content="Drive + Photos on infrastructure you own. End-to-end encrypted, unlimited, open source, no monthly fees.">
<meta property="og:url" content="https://daemonclient.uz/">
<meta property="og:image" content="https://daemonclient.uz/og-image.png">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="DaemonClient — Free, unlimited, encrypted cloud suite">
<meta name="twitter:description" content="Drive + Photos on infrastructure you own. End-to-end encrypted, unlimited, open source.">
<meta name="twitter:image" content="https://daemonclient.uz/og-image.png">
```

(Keep the existing `<link rel="preconnect">` font lines that follow.)
Add the JSON-LD from **§7.1** just before `</head>`.

### 2.2 Drive — `drive/dist/index.html` (and the Vite source that generates it)

Drive is already strong. **One fix:** its OG/Twitter image points at the missing
landing file. Either (a) create `daemonclient.uz/og-image.png` (preferred — it also
fixes Accounts), or (b) repoint Drive to its own bundled image:

```html
<!-- change both occurrences -->
<meta property="og:image" content="https://drive.daemonclient.uz/og-image.png">
<meta name="twitter:image" content="https://drive.daemonclient.uz/og-image.png">
```

> Edit the **source** template (`drive/` Vite `index.html`), not just `dist/`, or the
> next build overwrites it.

### 2.3 Photos — two parts

**(a) The app shell `immich/web/src/app.html`** — keep it `noindex` (correct as-is).
Add `lang` for accessibility/SEO hygiene only:

```html
<html lang="en" class="dark">
```

Leave `<meta name="robots" content="noindex" />` exactly as it is. This host should
**not** be indexed while it is app-only.

**(b) A real Photos marketing page (NEW — deploy task, not a code edit here).**
"DaemonClient Photos" currently has **nothing crawlable to rank**. To rank it you
must publish an **indexable** page that escapes *both* the global `noindex` and the
`** → /app.html` rewrite. Options, simplest first:

- **Option A (recommended): host the Photos landing on the main site.** Create
  `daemonclient-site/photos/index.html` (a real `/photos` page on
  `daemonclient.uz`), reuse the staged cat images, and rank that. Simple, no Immich
  build changes, and it strengthens the apex domain. The "Photos" nav entry on the
  landing already exists.
- **Option B: serve a static landing on `photos.` root.** Add a prerendered
  `index.html` to `immich/web/build/` and change the firebase `photos` rewrite so
  `/` (and `/about`, `/features`) serve that file *instead of* `app.html`, with its
  own indexable head (no `noindex`). More invasive (touches the Immich build +
  `firebase.json`).

Head block for whichever Photos page you ship (it MUST omit `noindex`):

```html
<title>DaemonClient Photos — Private, unlimited, encrypted photo backup</title>
<meta name="description" content="DaemonClient Photos is a private, unlimited, end-to-end encrypted photo & video library on infrastructure you own. A self-hosted Google Photos alternative.">
<link rel="canonical" href="https://photos.daemonclient.uz/">  <!-- or https://daemonclient.uz/photos/ for Option A -->
<meta name="theme-color" content="#10B981">
<meta property="og:type" content="website">
<meta property="og:site_name" content="DaemonClient">
<meta property="og:title" content="DaemonClient Photos — Private, unlimited, encrypted photo backup">
<meta property="og:description" content="A private, unlimited, end-to-end encrypted photo & video library you own. Self-hosted Google Photos alternative.">
<meta property="og:url" content="https://photos.daemonclient.uz/">
<meta property="og:image" content="https://daemonclient.uz/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="DaemonClient Photos — Private, unlimited, encrypted photo backup">
<meta name="twitter:description" content="A private, unlimited, end-to-end encrypted photo & video library you own.">
<meta name="twitter:image" content="https://daemonclient.uz/og-image.png">
```

Plus the SoftwareApplication JSON-LD from **§7.2**.

### 2.4 Accounts — `accounts-portal/` (Vite `index.html`)

Accounts already has good OG/Twitter/canonical. **Keep the root indexable** so it can
rank for "DaemonClient Accounts". Its hardcoded self-canonical means `/login` and
`/signup` client-routes consolidate to root automatically — do **not** add `noindex`.
Only fixes needed: ensure the OG image resolves (see action #1) and **add the missing
`robots.txt` + `sitemap.xml`** (§3.4, §4).

Optionally tighten the title toward the brand query:

```html
<title>DaemonClient Accounts — One account for Drive & Photos</title>
<meta name="description" content="Sign in or create your free DaemonClient account — one login for encrypted Drive and Photos. Unlimited storage, no monthly fees.">
```

### 2.5 `app.` legacy — `frontend/dist/index.html`

Only if you keep it live (else 301 the host). Make it stop competing:

```html
<meta name="robots" content="noindex,follow">
<link rel="canonical" href="https://drive.daemonclient.uz/">
```

…and delete `frontend/dist/sitemap.xml`.

---

## 3. `robots.txt` per subdomain

Principle: **allow marketing/overview pages; disallow auth/app/dashboard utility
pages and build assets.** Every host serves its **own** `/robots.txt` referencing its
**own** `/sitemap.xml`.

### 3.1 Landing — `daemonclient-site/robots.txt` (replace existing)

```
User-agent: *
Allow: /

Sitemap: https://daemonclient.uz/sitemap.xml
```
*(If you add `daemonclient-site/photos/` per §2.3 Option A, it's covered by `Allow: /`.)*

### 3.2 Drive — `drive/dist/robots.txt` (already good; keep)

```
# DaemonClient Drive
User-agent: *
Allow: /
Disallow: /login
Disallow: /dashboard

Sitemap: https://drive.daemonclient.uz/sitemap.xml
```

### 3.3 Photos — `immich/web/build/robots.txt` (replace existing)

While Photos is app-only (whole host noindex), keep crawlers out of app/auth/build
paths. If you ship a Photos landing (§2.3 Option B), add `Allow: /$` for the root.

```
User-agent: *
# App is private; nothing here is a search landing page (yet).
Disallow: /auth/
Disallow: /admin/
Disallow: /api/
Disallow: /_app/
Disallow: /folders
Disallow: /user-settings
Disallow: /photos
Disallow: /albums
Disallow: /search
Disallow: /trash

# Public share links may be linked but should not be crawled/indexed.
Disallow: /share/
Disallow: /s/

# When a marketing landing ships (Option B), uncomment:
# Allow: /$

Sitemap: https://photos.daemonclient.uz/sitemap.xml
```

> **Also strip the bad URLs from the Photos sitemap** (§4.3) — `robots.txt` alone
> won't fix the sitemap claiming `/auth/login` + `/signup`.

### 3.4 Accounts — `accounts-portal/dist/robots.txt` (NEW — create)

Root is the landing; client-routed `/login`,`/signup` self-canonical to root, so a
light robots is enough. Block nothing real (it's an SPA), just point at the sitemap:

```
User-agent: *
Allow: /
# /login and /signup are client routes that canonicalize to / — no need to crawl them.

Sitemap: https://accounts.daemonclient.uz/sitemap.xml
```

> Add to the Vite **source** `public/` so builds keep it.

### 3.5 `app.` legacy — `frontend/dist/robots.txt`

If kept live: `Disallow: /` (it's noindexed and 301-superseded anyway). If you 301
the host, this file is moot.

---

## 4. Sitemap strategy

**Decision: one sitemap PER HOST.** Each host serves `/sitemap.xml` listing **only
its own URLs**. Reasons: each deploy stays self-contained, no host lists another
host's URLs, and no product root is duplicated across two sitemaps. (Under a GSC
**Domain** property, all of these are still discovered together — see §6.)

> Today's landing sitemap lists all 4 host roots, and the legacy `app.` + Photos
> sitemaps list auth/dashboard URLs. Replace them with the per-host files below.
> **Only ever list indexable, canonical, 200-OK URLs** (no `/login`, `/signup`,
> `/dashboard`, no redirect targets).

### 4.1 Landing — `daemonclient-site/sitemap.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://daemonclient.uz/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <!-- Add ONLY when these real pages exist on the landing host: -->
  <!-- <url><loc>https://daemonclient.uz/photos/</loc><priority>0.8</priority></url> -->
  <!-- <url><loc>https://daemonclient.uz/security/</loc><priority>0.6</priority></url> -->
  <!-- <url><loc>https://daemonclient.uz/privacy/</loc><priority>0.5</priority></url> -->
</urlset>
```

> Do **not** put `drive.`/`photos.`/`accounts.` roots here — each ships its own
> sitemap. (They are still cross-linked in-page, which is what passes authority.)

### 4.2 Drive — `drive/dist/sitemap.xml` (already correct; keep)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://drive.daemonclient.uz/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
```

### 4.3 Photos — `immich/web/build/sitemap.xml` (replace — remove auth/signup)

**While app-only**, the host is noindex; the honest sitemap is just the root (it will
simply not get indexed until a real landing exists), OR ship an empty urlset. Use the
root form; switch the `<loc>` to `https://daemonclient.uz/photos/` if you take §2.3
Option A.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://photos.daemonclient.uz/</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
```

> The current file's `/auth/login` and `/signup` entries are the user's exact
> anti-pattern — **delete them**. `/signup` even 302-redirects off-domain.
> SvelteKit regenerates `build/` on each Immich web build, so also fix the source
> that emits this sitemap (search the Immich web build config / static dir) or it
> returns.

### 4.4 Accounts — `accounts-portal/dist/sitemap.xml` (NEW — create)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://accounts.daemonclient.uz/</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
```

> Add via the Vite **source** `public/sitemap.xml` so it survives `npm run build`.

### 4.5 `app.` legacy

Delete `frontend/dist/sitemap.xml` (and the source that emits it). If you 301 the
host, the sitemap is gone with it.

---

## 5. Answering your explicit question

> **"Should I request every URL possible (e.g. `photos.daemonclient.uz/auth/login`)
> and have them all link to each other?"**

**No. Do the opposite.** Submitting login/signup/dashboard/app URLs **hurts**:

- **They are not search landing pages.** Nobody searches Google to reach your login
  form; they search a brand or a problem ("encrypted photo backup"). Auth pages have
  no rankable content.
- **They create thin / duplicate / soft-404 content** and **waste crawl budget** —
  Google spends crawls on dead-end utility pages instead of your real pages.
- **For your SPAs they literally can't index** anyway: the whole Photos host is
  `noindex`, and Accounts' sub-routes self-canonical to root. Listing them just
  feeds Search Console "Excluded/Discovered – not indexed" noise.
- `photos.../signup` even **302-redirects to another domain** — a redirect is never a
  valid sitemap entry.

### What to do instead

1. **`noindex` / disallow utility pages.** Auth (`/auth/*`, `/login`, `/signup`),
   dashboards (`/dashboard`), the Immich app UI, and build assets (`/_app/`, `/api/`)
   → `Disallow` in `robots.txt` and/or `noindex`. Never in a sitemap.
2. **Create real, indexable marketing pages worth ranking.** Today you have:
   landing, Drive landing, Accounts root. **Gaps to build** (highest value first):
   - a **Photos marketing page** (you have none — §2.3),
   - then **`/security`** and **`/privacy`** (huge for a privacy product; also
     trust/E-E-A-T),
   - then optionally **`/features`**, **`/about`**, and a **docs or blog** section
     (long-tail queries: "self-hosted Google Photos alternative", "zero-knowledge
     Google Drive alternative", "back up photos to your own server").
   Each new page = a new query surface. Auth URLs = zero.
3. **Internal-link the MARKETING pages with descriptive anchors.** Your landing
   already cross-links well (Drive/Photos/Accounts buttons + footer). Make every
   product page link **back** to the landing and **across** to the sibling product
   with keyword-rich anchor text ("DaemonClient Photos", "encrypted Drive"), not
   "click here". This passes authority between hosts. (Minor: the landing footer
   labels the `#drive` anchor "CLI" — relabel to "Drive" or point CLI elsewhere.)
   **Do not** spam cross-host links from utility/app pages — only marketing pages
   should be link hubs.
4. **Canonicalize to prevent duplicate content.** Pick **one** host form and make
   everything agree:
   - **non-www, https** everywhere (you already use `https://drive.daemonclient.uz/`,
     etc.). In Cloudflare DNS, ensure `www.daemonclient.uz` **301-redirects** to the
     apex (or simply don't create a `www` record). Firebase serves https only.
   - **Trailing slash:** be consistent. Your canonicals use a trailing slash on roots
     (`.../`) — keep that, and let Firebase `cleanUrls`/redirects normalize the rest.
   - Every indexable page carries a **self-referential `<link rel="canonical">`** to
     its chosen URL. This collapses `http`/`https`, `www`/non-www, and `?utm=` /
     trailing-slash variants into one indexed URL. **This is the #1 reason to add the
     missing canonical to the landing (§2.1).**

> TL;DR: index a **handful of real pages** (landing + per-product + a few content
> pages), `noindex` everything transactional, and let descriptive in-page links —
> not sitemap stuffing — connect them.

---

## 6. Google Search Console runbook (step-by-step)

### 6.1 Create ONE Domain property (covers all subdomains)

1. Go to <https://search.google.com/search-console> → **Add property**.
2. Choose **Domain** (left card) → enter **`daemonclient.uz`** (no `https://`, no
   subdomain). A Domain property automatically covers `daemonclient.uz` **and every
   subdomain** (`drive.`, `photos.`, `accounts.`, `app.`) and both http/https.
3. Google shows a **TXT record** to add to DNS.

### 6.2 DNS TXT verification (Cloudflare — your DNS host)

1. Cloudflare dashboard → `daemonclient.uz` → **DNS → Records → Add record**.
2. **Type:** `TXT` · **Name:** `@` (the apex) · **Content:** paste the
   `google-site-verification=…` string exactly · **TTL:** Auto · **Proxy:** N/A for
   TXT.
3. Save. Back in GSC click **Verify**. (DNS can take minutes to hours; if it fails,
   wait and retry — don't delete the record.)

### 6.3 Submit each host's sitemap individually

Even with one Domain property, submit each per-host sitemap so GSC tracks them
separately. **GSC → Sitemaps → "Add a new sitemap"**, enter each full URL:

```
https://daemonclient.uz/sitemap.xml
https://drive.daemonclient.uz/sitemap.xml
https://photos.daemonclient.uz/sitemap.xml      (after stripping auth URLs)
https://accounts.daemonclient.uz/sitemap.xml    (after you create it)
```
*(Do not submit an `app.` sitemap — you're removing it.)*

### 6.4 Request indexing for the key pages

**GSC → URL Inspection** (top search bar), paste a URL, then **Request Indexing**.
Do this for, in order:

1. `https://daemonclient.uz/`
2. `https://drive.daemonclient.uz/`
3. `https://accounts.daemonclient.uz/`
4. the Photos marketing page **once it exists** (§2.3)

For each, also click **Test Live URL** → confirm "URL is available to Google" and
that the rendered page shows your title/description (catches the SPA-renders-empty
trap). **Do not** request indexing for any `/login`, `/signup`, `/dashboard`, or
`photos.` app URL.

### 6.5 Bonus — Bing Webmaster Tools (import from GSC)

1. <https://www.bing.com/webmasters> → sign in → **Import** → "Import from Google
   Search Console" → authorize → pick the `daemonclient.uz` property. Bing pulls your
   verified sites + sitemaps automatically.
2. Verify the sitemaps came across; add any missing host sitemap manually.
   (Powers Bing **and** DuckDuckGo, ~10% of search.)

---

## 7. Structured data (JSON-LD)

Reuse Drive's existing graph as the template (it already has
**Organization + WebSite + SoftwareApplication + Offer**, with shared `@id`s).

### 7.1 Landing — add before `</head>` in `daemonclient-site/index.html`

Defines the canonical **Organization** + **WebSite** that the product pages reference
by `@id`:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://daemonclient.uz/#organization",
      "name": "DaemonClient",
      "url": "https://daemonclient.uz/",
      "logo": "https://daemonclient.uz/uploads/logo.png",
      "description": "DaemonClient is a free, end-to-end-encrypted cloud suite you own — Drive (files) and Photos — with one central account.",
      "sameAs": [
        "https://github.com/myrosama/DaemonClient",
        "https://t.me/daemonclient"
      ]
    },
    {
      "@type": "WebSite",
      "@id": "https://daemonclient.uz/#website",
      "name": "DaemonClient",
      "url": "https://daemonclient.uz/",
      "publisher": { "@id": "https://daemonclient.uz/#organization" }
    }
  ]
}
</script>
```

> Confirm the GitHub/Telegram URLs are real before shipping (Drive's JSON-LD already
> uses these two — reuse the verified values).

### 7.2 Photos page — add to whichever Photos landing you ship (§2.3)

Mirrors Drive's `SoftwareApplication`, tied to the same Organization/WebSite `@id`:

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": "https://photos.daemonclient.uz/#app",
      "name": "DaemonClient Photos",
      "applicationCategory": "MultimediaApplication",
      "operatingSystem": "Web, Android, iOS",
      "url": "https://photos.daemonclient.uz/",
      "description": "A private, unlimited, end-to-end encrypted photo and video library on infrastructure you own — a self-hosted Google Photos alternative.",
      "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD" },
      "isPartOf": { "@id": "https://daemonclient.uz/#website" },
      "publisher": { "@id": "https://daemonclient.uz/#organization" }
    }
  ]
}
</script>
```

### 7.3 Drive

Already has the full graph — **no change** beyond fixing the og:image reference
(§2.2). If you want rich-result eligibility later, add an
`aggregateRating`/`review` only when you have **genuine** ratings (fake ratings →
manual penalty).

### 7.4 Accounts

Optional. A `WebPage` referencing `#organization` is enough; not a ranking priority.

---

## 8. Prioritized "Do this first" checklist (impact × effort)

| # | Action | File(s) | Why | Effort |
|---|---|---|---|---|
| **1** | **Create `og-image.png`** at the landing root | `daemonclient-site/og-image.png` (1200×630) | One file fixes broken social previews for landing **+ Drive + Accounts** (both hardcode this URL) | **XS** |
| **2** | **Fill the landing `<head>`**: canonical, OG, Twitter, favicon, theme-color | `daemonclient-site/index.html` (§2.1) | The #1 brand-ranking page is currently bare; canonical also dedups variants | **S** |
| **3** | **Add Organization + WebSite JSON-LD** to landing | `daemonclient-site/index.html` (§7.1) | Brand knowledge-panel eligibility; anchors the product-page graph | **S** |
| **4** | **Strip auth/signup URLs from the Photos sitemap** (+ its source) | `immich/web/build/sitemap.xml` (§4.3) | Removes the exact anti-pattern; stops crawl-budget waste & soft-404s | **XS** |
| **5** | **Resolve `app.daemonclient.uz` duplicate** — 301 → `drive.`, else noindex + delete its sitemap | `firebase.json` / `frontend/dist/*` (§1.A, §2.5) | Kills a brand-term duplicate that canonicals to your landing | **S–M** |
| 6 | Add **`robots.txt` + `sitemap.xml` to Accounts** | `accounts-portal/public/*` (§3.4, §4.4) | Two files it's missing entirely | XS |
| 7 | **Tighten Photos `robots.txt`** to disallow app/auth/assets | `immich/web/build/robots.txt` (§3.3) | Keeps crawlers off the noindex app | XS |
| 8 | Repoint **Drive og:image** (or rely on #1) + verify GitHub/Telegram links | `drive/` source `index.html` (§2.2) | Closes the last broken-preview ref | XS |
| 9 | **Set up GSC Domain property + DNS TXT + submit sitemaps** | external (§6) | Nothing ranks until Google can see + trust the sitemaps | M |
| 10 | **Build a Photos marketing page** (Option A: `daemonclient-site/photos/`) | new page (§2.3) | "DaemonClient Photos" has **no indexable page today** — required to rank the query | M |
| 11 | Add **`/security` + `/privacy`** content pages, cross-linked | landing host | Trust/E-E-A-T + long-tail for a privacy product | M |
| 12 | Relabel landing footer `#drive` "CLI" anchor; ensure cross-product anchors are descriptive | `daemonclient-site/index.html` | Clean internal-link signals | XS |
| 13 | Import GSC → **Bing Webmaster Tools** | external (§6.5) | Bing + DuckDuckGo coverage, ~free | XS |

**Sequencing:** items **1–4 are sub-30-minute, no-build-risk wins** (mostly static
files on the landing + Immich build) — do them in one sitting and redeploy
`main` + `photos`. Then **5–9** (the cleanup + GSC). Then **10–13** (new content,
which needs builds/deploys you run later).

> **Every fix above is a file edit you apply later, then rebuild + redeploy the
> affected Hosting target** (`firebase deploy --only hosting:<target>`). This plan
> makes **no** changes itself.
