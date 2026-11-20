# Roadmap

What is being worked on, what comes next, and what is deliberately not
happening. Kept short. If something here stops being true, edit it or delete it.
No dates: this says what ships next, not when.

## Now

**The iPhone app.** A native SwiftUI app over one shared Rust core
(`core/`), starting from HomeRoll's Swift code with its server layer replaced
by the core. The plan, the order and how the core is proven are in
[plan/ENGINE.md](plan/ENGINE.md) (SPEC D26, D27).

**The worker contract v2.** A change feed instead of sending the whole library
on every sync, plus bulk create for uploads from the phone. Draft:
[plan/CONTRACT_V2.md](plan/CONTRACT_V2.md).

**Keeping what is live working.** Photos and Drive on the web, each user's
worker and the accounts portal get bug fixes and security fixes as they come.

## Next

**The Android app.** Kotlin and Compose over the same core.

**Both websites rebuilt on the engine.** Photos and Drive move onto the same
Rust rules, compiled to WebAssembly, so one fix reaches every client (SPEC D25).
Until then the websites change only for fixes.

## Paused

**The self-host installer**, since 2026-09-30. Where to pick it up is in
[../EXECUTION_STATUS.md](../EXECUTION_STATUS.md) ("Paused 2026-09-30 — how to
resume"); its plans are in [plan/](plan/).

## Not happening

**Paid storage.** Telegram is the storage, and unlimited storage is the
product.

**Processing on servers.** Work that needs real CPU (HEIC decoding, video
copies, thumbnails) runs on the user's own device: the browser today, the phone
apps next. The optional HEIC processor was removed on 2026-11-20.
