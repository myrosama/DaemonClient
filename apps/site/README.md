# daemonclient-site — the landing page

Deployed to `daemonclient.uz`. Static HTML, no build step, no framework.

| File | What it is |
|---|---|
| `index.html` | the entire page — markup, styles and script inline |
| `sitemap.xml`, `robots.txt` | search indexing |
| `og-image.png` | link preview card |
| `uploads/` | images used by the page and by the repository README |

## Deploying

```bash
firebase deploy --only hosting:main
```

There is nothing to build. Edit `index.html` and deploy.

## Why it is plain HTML

It is one page whose job is to load fast and rank well. A framework would add a
build step, a bundle, and a hydration cost to a document that has no state. If
this ever grows into several pages, revisit — until then, the constraint is
keeping it honest.

It calls `auth.daemonclient.uz/check-session` so the call-to-action can point a
signed-in visitor at their dashboard instead of the sign-up funnel.
