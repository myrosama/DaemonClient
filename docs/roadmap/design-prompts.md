# Landing-page design prompts — FINAL (for Claude's design tool)

Three ready-to-paste prompts. For each: **upload the logo + the relevant screenshot**
(`docs/roadmap/reference/`), then paste the prompt. Bring the result back and I implement
it pixel-faithfully. Order: **Drive first**, then Photos, then Main. Linked from [[PROGRAM]].

## Brand assets & EXACT palette (upload + state these every time)

**Logo (from the live app):** a **blue cloud + green stacked layers** — the blue+green
identity is real; build on it. Reference screenshots to upload:
- `docs/roadmap/reference/photos-timeline.png` — live Photos grid (Photos landing mock).
- `docs/roadmap/reference/drive-app.png` — live Drive login (logo + dark theme). *Also
  screenshot your Drive dashboard when logged in — best mock for the Drive landing.*

| Role | Hex |
|---|---|
| Drive primary (electric blue) | `#1E6BFF` |
| Drive accent (cloud blue, logo) | `#38BDF8` |
| Photos primary (emerald, logo) | `#10B981` |
| Photos accent (mint) | `#34D399` |
| Dark canvas (base) | `#0B0E14` |
| Drive canvas (navy) | `#070B16` → `#0A1730` |
| Photos canvas (forest-black) | `#07120D` → `#0B1A12` |
| Text high / muted | `#F4F6FB` / `#8A93A6` |

Main landing uses **both** `#1E6BFF` and `#10B981` as distinct accents on `#0B0E14` —
never blended into muddy teal.

**Anti-"AI-generic" rules (state in every prompt):** NO purple→pink SaaS gradient, NO
three identical centered feature cards, NO floating isometric blobs, NO emoji bullets, NO
vague "empower your workflow" copy. Editorial, confident, dark, premium — Linear/Vercel/Arc,
not a template. Generous whitespace, strong type hierarchy, one signature motif per page,
purposeful scroll-reveal motion only. Fully responsive.

---

## PROMPT 1 — DaemonClient Drive landing · `drive.daemonclient.uz/` · **blue** (DO FIRST)

> Design a complete, production-quality marketing landing page for "DaemonClient Drive." Build it as a single responsive page, dark theme, modern and editorial — Linear / Vercel / Arc polish, NOT a generic SaaS template. This is the public landing at the root of `drive.daemonclient.uz`; the app lives at `/dashboard` and `/login`, so every CTA goes to sign in / create account.
>
> Brand & assets: attached are the DaemonClient logo (blue cloud + green stacked layers) and a screenshot of the current app. This is DaemonClient Drive — use the logo, lean into a confident **blue** identity.
>
> Exact colors (don't substitute): primary electric blue `#1E6BFF`, lighter cloud-blue accent `#38BDF8`, near-black navy canvas `#070B16`→`#0A1730`, text `#F4F6FB`, muted `#8A93A6`. Blue is the hero accent; premium and high-contrast, never neon-soup.
>
> What it is (use this real copy, not filler): free, unlimited, end-to-end-encrypted file storage on infrastructure *you* own — a private alternative to Google Drive/Dropbox. Files are chunked and AES-256-GCM encrypted on your device before they leave it. No monthly fees, no storage limits, no company that can read your files. Open-source.
>
> Signature motif: a file dissolving into encrypted shards/chunks that scatter into "your own cloud" — carry it subtly through hero + section dividers.
>
> Sections: (1) sticky nav — logo + "DaemonClient Drive"; Features, How it works, Open Source; "Sign in" (ghost) + "Create free account" (solid blue). (2) Hero — headline **"Unlimited storage. Sealed before it leaves your device."** subhead "DaemonClient Drive gives you limitless, end-to-end-encrypted file storage on infrastructure you own. No fees. No snooping. No limits." CTAs "Get started free" / "See how it works"; beside it a clean mock of the Drive file dashboard (grid + upload + in-browser preview) with the shard motif. (3) Features (varied layouts, NOT identical cards): in-browser **streaming with seeking** for big files/video; **chunked + AES-256-GCM** distributed storage; a **CLI** for power users; **drive-anywhere** (coming soon: mount from your phone's file manager + a desktop virtual disk). Mono font for tokens like "AES-256-GCM". (4) Privacy/credibility — zero-knowledge, encrypted-before-upload, open-source: "We literally cannot read your files." (5) How it works — 3 steps w/ blue shard motif: "1 Connect your own cloud + Telegram → 2 Your private server + database are deployed → 3 Everything you upload is encrypted on your device first." Emphasize "you own it — $0." (6) Final CTA "Your files. Actually yours. Free." + footer linking to the main DaemonClient site and DaemonClient Photos, GitHub, docs, contact.
>
> Rules: no purple→pink gradient, no isometric blobs, no emoji bullets, no vague copy. Big tight-tracked grotesk headlines + clean body sans, generous whitespace, purposeful scroll-reveal motion, mobile nav collapses. Deliver a complete, polished, dark, blue-identity page with the chunk-shard motif as signature.

---

## PROMPT 2 — DaemonClient Photos landing · `photos.daemonclient.uz` · **green**

> Design a complete, production-quality marketing landing page for "DaemonClient Photos." Single responsive page, dark theme, editorial and premium — Linear/Vercel/Arc polish, NOT a template. Goal: emotional + practical — "back up a lifetime of photos & videos, privately, free, forever" — and drive sign in / create account; note it works with the mobile app.
>
> Brand & assets: attached are the DaemonClient logo (blue cloud + green stacked layers) and a screenshot of the live photo timeline. This is DaemonClient Photos — use the logo, lean into a warm, alive **green** identity (where Drive is sharp/technical, Photos is calmer and more human — but still privacy-forward and premium, not cutesy).
>
> Exact colors (don't substitute): primary emerald `#10B981`, mint accent `#34D399`, forest-black canvas `#07120D`→`#0B1A12`, text `#F4F6FB`, muted `#8A93A6`.
>
> What it is (real copy, not filler): free, unlimited, end-to-end-encrypted photo & video backup on storage you own — a private alternative to Google Photos / iCloud. Every photo and video is encrypted on your device; no subscriptions, no limits, no one looking through your memories. Open-source.
>
> Signature motif: a living photo grid / timeline where tiles gently settle into place, with one or two showing a tasteful encrypted "seal/lock shimmer" to signal privacy. Use a real photo-grid mock (reference the attached timeline screenshot).
>
> Sections: (1) sticky nav — logo + "DaemonClient Photos"; Features, How it works, Mobile app; "Sign in" + "Create free account" (green). (2) Hero — headline **"A lifetime of photos. Unlimited. Truly private."** subhead "Back up every photo and video, end-to-end encrypted, on storage you own — for free. No subscriptions, no limits, no one looking through your memories." CTAs "Get started free" / "How it works"; beside it the living photo-grid/timeline mock. (3) Features (varied layouts): **unlimited photo + video backup**; **end-to-end encrypted, you hold the key**; **works with the mobile app** (back up from your phone); **map, albums, favorites, search**. (4) Mobile — a section showing phone backup (app + phone mock) and "set up on your phone in minutes." (5) Privacy/credibility — zero-knowledge, encrypted-before-upload, open-source, $0. (6) Final CTA + footer linking to the main DaemonClient site and DaemonClient Drive.
>
> Rules: no purple→pink gradient, no isometric blobs, no emoji bullets, no vague copy. Warm-but-confident headlines, generous whitespace, gentle scroll reveals, mobile nav collapses. Deliver a complete, polished, dark, green-identity page with the living-photo-grid motif as signature.

---

## PROMPT 3 — DaemonClient main brand landing · `daemonclient.uz` · **green + blue**

> Design a complete, production-quality marketing landing page for **DaemonClient**, the umbrella brand for a suite of free, unlimited, end-to-end-encrypted, user-owned cloud products. Single responsive page, dark theme, editorial and premium — Linear/Vercel/Arc polish, NOT a template. Job: a first-time visitor instantly grasps "a private, free alternative to Google's cloud — with a Drive and a Photos product," then enters the product they want.
>
> Brand & assets: attached are the DaemonClient logo (blue cloud + green stacked layers) and screenshots of both products. Use the logo. Identity = a **duality of electric blue (Drive) and emerald green (Photos)** on a deep near-black canvas — two distinct, confident accents, never blended into mud.
>
> Exact colors (don't substitute): blue `#1E6BFF` (Drive), green `#10B981` (Photos), base canvas `#0B0E14`, text `#F4F6FB`, muted `#8A93A6`.
>
> Signature motif: encrypted chunks/shards that scatter and re-assemble — "your data is split, sealed, and only yours" — tying the page together; render some shards blue, some green.
>
> Sections: (1) sticky nav — DaemonClient wordmark; Products (dropdown: Drive, Photos, "More soon"), Why DaemonClient, Open Source; "Sign in" (ghost) + "Get started free" (solid, blue→green accent). (2) Hero — headline **"Your cloud. Actually yours."** subhead "Free, unlimited, end-to-end encrypted storage. Your files live in your own infrastructure — we never hold them." Two product buttons side by side: blue **"Open Drive →"** and green **"Open Photos →"**; chunk-shard motif behind; trust line "Open-source · Zero-knowledge · No monthly fees." (3) Product showcase (core): two large distinct panels — **Drive (blue)** and **Photos (green)** — each with a real mock (use the attached screenshots), a one-liner, 3 concrete capabilities, and "Explore Drive/Photos →" linking to that product's landing. Below, a muted **"More coming soon"** strip. (4) How it works — 3 steps w/ shard motif: "1 Connect your own cloud + Telegram · 2 We deploy your private worker + database · 3 Everything is encrypted before it leaves your device." Emphasize "you own it, $0." (5) Why different — editorial comparison vs typical cloud (no fees/limits/data-access, open-source); not a checkmark-table cliché. (6) Final CTA "Start with Drive or Photos — free, in minutes." dual buttons + footer (products, GitHub, docs, contact, sign-in).
>
> Rules: no purple→pink gradient, no isometric blobs, no emoji bullets, no vague copy. Big tight-tracked grotesk headlines + clean body sans, generous whitespace, purposeful scroll-reveal motion, mobile nav collapses. Deliver a complete, polished, dark page with the blue+green duality and the chunk-shard motif as signature.

---

### After designs come back
I implement each: **Drive** landing at the root of the new `drive.daemonclient.uz` folder
(app at `/dashboard`,`/login`); **Photos** into `photos.daemonclient.uz`; **main** into
`frontend/` (`daemonclient.uz`). CTAs → `accounts.daemonclient.uz/signup?continue=<origin>`
(I build the `?continue=` handler). Then T5 SEO → sitelinks.
