# Landing-page design prompts (for Claude's design tool)

Three prompts. Paste one at a time. Each is self-contained. Bring the result back and
I'll implement it as a real, fast, SEO-clean page. Linked from [[PROGRAM]].

**Shared brand facts (true for all three — feed these in every time):**
- DaemonClient is a suite of **free, unlimited, end-to-end-encrypted, you-own-the-infrastructure** products. Files are split into chunks, AES-256-GCM encrypted on the user's device, and stored in the user's *own* cloud + Telegram. **No monthly fees, no storage limits, no company holding your data.** Open-source.
- Two live products: **Drive** (files) and **Photos** (photo/video library). More "coming soon."
- Domains: main `daemonclient.uz`, Drive `drive.daemonclient.uz`, Photos `photos.daemonclient.uz`, sign-in/up `accounts.daemonclient.uz`.
- **Color identity: Drive = blue, Photos = green, the umbrella brand = blue + green together.**

**Anti-"AI-generic" art-direction rules (state these in every prompt):**
- NO purple-to-pink SaaS gradient, NO three identical centered feature cards, NO floating isometric blobs, NO emoji bullets, NO vague copy ("Empower your workflow"). 
- Opinionated, editorial, confident. Real product screenshots/mock UI, not abstract illustration. Generous whitespace, a strong typographic hierarchy, one distinctive visual motif carried throughout. Purposeful motion only (reveal on scroll, subtle parallax), never decorative spinners. Dark-first, premium, trustworthy — closer to Linear / Vercel / Arc than to a template.

---

## PROMPT 1 — DaemonClient (main brand landing) · `daemonclient.uz` · green + blue

> Design a dark-first marketing landing page for **DaemonClient**, the umbrella brand for a suite of free, unlimited, end-to-end-encrypted, user-owned cloud products. This page's job: make a first-time visitor instantly understand "this is a private, free alternative to Google's cloud — and there's a Drive and a Photos product," then send them into the product they want.
>
> **Visual concept:** "Two worlds, one private brand." The brand color is a **duality of electric blue (Drive) and emerald green (Photos)** on a deep near-black canvas (#0B0E14). Use blue and green as two distinct, confident accents — never blended into mud. A recurring motif of **encrypted chunks/shards** (small geometric tiles that scatter and re-assemble) ties the page together and visually says "your data is split, sealed, and only yours." Typography: a strong modern grotesk for headlines (tight tracking, big sizes), a clean neutral sans for body. High contrast, editorial spacing.
>
> **Sections (in order):**
> 1. **Sticky top nav**: DaemonClient wordmark left; links: Products (dropdown: Drive, Photos, "More soon"), Why DaemonClient, Open Source; right: "Sign in" (ghost) + "Get started free" (solid, blue→green subtle accent). 
> 2. **Hero**: one bold sentence — *"Your cloud. Actually yours."* — subhead: *"Free, unlimited, end-to-end encrypted storage. Your files live in your own infrastructure — we never hold them."* Two product entry buttons side by side: a **blue "Open Drive →"** and a **green "Open Photos →"**. Background: the chunk-shard motif gently animating. A small trust line: "Open-source · Zero-knowledge · No monthly fees."
> 3. **Product showcase** (the core): two large, distinct panels — **Drive (blue)** and **Photos (green)** — each with a real mock of its UI, a one-liner, 3 concrete capabilities, and a "Explore Drive/Photos" link to its landing. Below them a muted **"More coming soon"** strip (e.g., Notes, Vault) as quiet placeholders.
> 4. **How it works** (3 steps, horizontal, with the shard motif): "1 Connect your own cloud + Telegram · 2 We deploy your private worker + database · 3 Everything you store is encrypted before it leaves your device." Emphasize "you own it, $0."
> 5. **Why it's different**: a comparison-style block vs typical cloud (no fees, no limits, no data access, open-source) — but make it editorial, not a checkmark table cliché.
> 6. **Final CTA**: "Start with Drive or Photos — free, in minutes." dual buttons again. Footer: products, GitHub, docs, contact, accounts sign-in.
>
> **Tone:** confident, privacy-first, a little rebellious ("actually yours"), trustworthy, technical-credible without being cold. Fully responsive; mobile nav collapses; motion subtle and performant. Deliverable: a complete, production-quality landing page, dark theme, with the blue+green duality and the chunk-shard motif as the signature.

---

## PROMPT 2 — DaemonClient Drive landing · `drive.daemonclient.uz/` · **blue**

> Design a dark-first product landing page for **DaemonClient Drive** — a free, unlimited, end-to-end-encrypted file storage product (a private, self-owned alternative to Google Drive / Dropbox). The page lives at the root of `drive.daemonclient.uz`; the actual app is at `/dashboard` and `/login`. Goal: convince a privacy- or cost-conscious user that they can store unlimited files for free, fully encrypted, that they alone control — and get them to sign in / sign up.
>
> **Visual concept:** "The vault." Deep, confident **blue** identity — electric blue (#1E6BFF) accents over a near-black/navy canvas (#070B16 → #0A1730). The signature motif: **a file dissolving into encrypted chunks that scatter into the user's own cloud** — communicate "chunked, AES-256-GCM encrypted, distributed, only you hold the key." Sharp, technical, secure, but premium and approachable. Strong grotesk headlines; mono accents for the technical/credibility bits (e.g., "AES-256-GCM").
>
> **Sections:**
> 1. **Nav**: Drive wordmark (blue accent) · links: Features, How it works, Open Source · right: "Sign in" + "Create free account" (the latter → accounts signup, returns to Drive).
> 2. **Hero**: *"Unlimited storage. Sealed before it leaves your device."* Subhead: *"DaemonClient Drive gives you limitless, end-to-end-encrypted file storage on infrastructure you own. No fees. No snooping. No limits."* Primary CTA "Get started free", secondary "See how it works". Visual: the chunk/vault motif, plus a real mock of the Drive dashboard (file grid/list, upload, in-browser viewer).
> 3. **Feature highlights** (not identical cards — vary layout): big-file/video **in-browser streaming with seeking**; **chunked + encrypted** distributed storage; **CLI** for power users; **drive-anywhere** (coming: mount from your phone's file manager + a desktop virtual disk via WebDAV). Each feature gets its own distinct visual treatment + concrete copy.
> 4. **Privacy/credibility**: zero-knowledge, AES-256-GCM, open-source, "we literally cannot read your files." Editorial, technical confidence.
> 5. **How it works** (3 steps, blue shard motif): connect cloud+Telegram → private worker+DB deployed → encrypted uploads.
> 6. **Final CTA** + footer (link back to main DaemonClient + to Photos).
>
> **Tone:** secure, technical-credible, premium, for people who hate paying for storage and hate being the product. Responsive, performant, subtle scroll motion. Deliverable: complete blue-identity landing page with the vault/chunk motif as signature.

---

## PROMPT 3 — DaemonClient Photos landing · `photos.daemonclient.uz` · **green**

> Design a dark-first product landing page for **DaemonClient Photos** — a free, unlimited, end-to-end-encrypted photo & video library (a private, self-owned alternative to Google Photos / iCloud). Goal: emotional + practical — "back up a lifetime of photos/videos, privately, for free, forever," and get the user to sign in / sign up (and know it works with the mobile app).
>
> **Visual concept:** "Memories, kept private." Warm, alive **green** identity — emerald (#10B981) / a richer forest depth over a near-black canvas (#07120D → #0B1A12). Where Drive is sharp/technical, Photos is **calmer, more human, more emotional** — but still premium and privacy-forward, not soft/cutesy. Signature motif: **a living photo grid / timeline** where tiles gently settle into place, with one or two becoming "encrypted" (a tasteful lock/seal shimmer) to show privacy. Real photo-grid mock UI. Headlines warm but confident.
>
> **Sections:**
> 1. **Nav**: Photos wordmark (green accent) · Features, How it works, Mobile app · "Sign in" + "Create free account" (→ accounts signup, returns to Photos).
> 2. **Hero**: *"A lifetime of photos. Unlimited. Truly private."* Subhead: *"Back up every photo and video, end-to-end encrypted, on storage you own — for free. No subscriptions, no limits, no one looking through your memories."* CTA "Get started free" + "How it works". Visual: the living photo-grid/timeline motif + a real mock of the photo timeline UI.
> 3. **Features** (varied layouts): **unlimited photo + video backup**; **end-to-end encrypted, you hold the key**; **works with the mobile app** (back up straight from your phone); **map, albums, favorites, search**. Be honest+positive about the experience.
> 4. **Mobile**: a section showing it backs up from the phone (app + screenshots), with a clear "set up on your phone in minutes."
> 5. **Privacy/credibility**: zero-knowledge, encrypted-before-upload, open-source, $0.
> 6. **Final CTA** + footer (back to main DaemonClient + to Drive).
>
> **Tone:** warm, reassuring, privacy-first, emotional-but-credible, for families/individuals who want their memories safe and free. Responsive, performant, gentle scroll reveals. Deliverable: complete green-identity landing page with the living-photo-grid motif as signature.

---

### After you bring designs back
I implement each as a real page: the **Drive landing** at the root of the new
`drive.daemonclient.uz` folder (app stays at `/dashboard`, `/login`); the **Photos
landing** wired into `photos.daemonclient.uz`; the **main landing** into `frontend/`
(served on `daemonclient.uz`). CTAs route to `accounts.daemonclient.uz/signup?continue=<origin>`.
Then T5 SEO makes them rank with sitelinks.
