# DaemonClient — SEO / GEO / AEO Strategy

Goal (brand structure): a search for **"DaemonClient"** surfaces the main landing
with sitelinks to Drive / Photos / login; **"DaemonClient Drive"** → the Drive
landing; **"DaemonClient Photos"** → the Photos landing. Each product reinforces
the parent brand entity.

## Entity graph (how the sites link)

```
            DaemonClient (Organization + main WebSite)  daemonclient.uz
                 │ isPartOf / publisher
        ┌────────┴─────────┐
   Drive WebSite      Photos WebSite
 drive.daemonclient   photos.daemonclient
        │                   │
  SoftwareApplication  SoftwareApplication
```

Every page declares the shared `Organization` (`@id daemonclient.uz/#organization`,
with `sameAs` → GitHub + Telegram) and links its product back to it via
`isPartOf` / `publisher`. This is what teaches Google/AI engines that Drive and
Photos are one brand → enables sitelinks + correct entity attribution (GEO).

## Per-surface checklist

| Signal | Drive (`drive/`) | Status |
|---|---|---|
| `<title>` ≤ 60 chars, brand + value | "DaemonClient Drive — Free Unlimited Encrypted Cloud Storage" | ✅ |
| meta description 150–160, with hook | ✅ | ✅ |
| canonical, viewport, theme-color | ✅ | ✅ |
| Open Graph + Twitter card + og-image | ✅ (og-image.png) | ✅ |
| JSON-LD `@graph`: Organization + WebSite(+SearchAction) + WebSite + SoftwareApplication | ✅ | ✅ |
| robots.txt (+ sitemap pointer) | ✅ disallows /login,/dashboard | ✅ |
| sitemap.xml | ✅ root | ✅ |
| App shell (`app.html`) `noindex` | ✅ | ✅ |
| Cross-links to main + Photos | ✅ (nav/footer) | ✅ |

## Pending content work (next, not blocking ship)

- **AEO — FAQ section + `FAQPage` schema** on the Drive landing. Highest-value
  remaining win (featured snippets, People-Also-Ask, AI answer engines). Must be
  VISIBLE Q&A matching the schema (Google requirement) — so add a styled FAQ
  block to `drive/index.html` first, then the schema. Suggested questions:
  "Is DaemonClient Drive really free?", "How are my files encrypted?", "Where are
  my files stored?", "Is it a Google Drive alternative?", "Do I own my storage?".
- **Main landing rebuild** (`frontend/` → new folder) must carry the same
  `@graph` Organization + a `WebSite` with `SearchAction`, and link out to Drive
  + Photos (the sitelink targets). This is what makes the "DaemonClient" query
  show sitelinks.
- **Photos landing** (being generated) needs the mirrored head: Organization,
  Photos WebSite `isPartOf` main, SoftwareApplication, canonical photos.daemonclient.uz.
- Submit all three sitemaps in Google Search Console; verify entity with the
  Rich Results Test.

## Verify with tools we actually have

- Structured data: validator.schema.org / Rich Results Test (manual), or parse in
  CI (we already JSON.parse the block on build).
- Performance/LCP (a ranking factor): `chrome-devtools` `lighthouse_audit` /
  `cloudflare:web-perf` against the deployed Drive URL.
- `docs/SKILL.md` (seo-geo-aeo) is an audit tool — run it against the live URL
  post-deploy for a full signal-by-signal report.
