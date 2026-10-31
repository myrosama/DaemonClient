# App Store — what the Review Guidelines mean for our apps

Read on 2026-10-31 from Apple's App Store Review Guidelines
(developer.apple.com/app-store/review/guidelines) and Telegram's Bot Platform
Developer Terms (telegram.org/tos/bot-developers). Quotes are verbatim. This
is a working checklist, not legal advice; re-read both documents before
submission (P4) — they change.

## Decisions only the operator can make

| # | Issue | What the rules say | Options |
|---|---|---|---|
| A1 | **Telegram as storage** | Telegram Bot Terms 5.2(e): *"You must not leverage your TPA … in conjunction with external interfaces (i.e., frontends), frameworks or tools, to develop external services or applications that diverge significantly from the intended use cases of Bot Platform (e.g., cloud storage sites)."* Apple 5.2.2: *"If your app uses … a third-party service, ensure that you are specifically permitted to do so under the service's terms of use. Authorization must be provided upon request."* | The whole product rests on this; code cannot fix it. (a) Submit as is: each user runs their own bot and accepted Telegram's terms themselves — risk of rejection under 5.2.2 if Apple asks, and of Telegram acting against bots. (b) Describe the app as an encrypted client for the user's own server and channel, with no "unlimited free storage" claims in metadata. (c) Add a second storage backend so Telegram is one option. (d) Ask Telegram for permission in writing. |
| A2 | **Home-screen name "Photos"** (SPEC D20) | 4.1(b) *"Submitting apps which impersonate other apps or services is considered a violation of the Developer Code of Conduct"*; 2.3.7 *"Choose a unique app name … don't try to pack any of your metadata with … popular app names"*. The iOS permission prompt will read "“Photos” Would Like to Access Your Photos". | Store name "DaemonClient Photos" is fine. For the home-screen name, something unmistakable — e.g. "DC Photos" or "DaemonClient" — removes the risk; "Photos" may be rejected. |
| A3 | **Whose developer account** | 5.2.1 *"Apps should be submitted by the person or legal entity that owns or has licensed the intellectual property and other relevant rights."* The plan is a friend's paid account. | Own Apple Developer account (best), or a written licence from the operator to the friend, kept on file. |
| A4 | **Account deletion** | 5.1.1(v) *"If your app supports account creation, you must also offer account deletion within the app."* | The app offers "Create account", so it must offer deletion. Needs a deletion flow on the accounts side (Linux machine) that the app opens or calls — what exactly gets deleted (Firebase account, worker, D1; the Telegram channel stays the user's) is a product decision. |

## What we must build or change (owned by plan tasks)

| Guideline | Requirement | Our status → action | Task |
|---|---|---|---|
| 2.1(a) | Fully working build; *"include demo account info (and turn on your back-end service!)"* | A **review account** with sample photos, separate from the operator's and the test account | P4 |
| 5.1.1(i) | Privacy policy link in App Store Connect **and inside the app**; it must name every third party with access to data | Policy must name: Telegram (stores the encrypted files), Cloudflare (the user's worker: metadata), Google Firebase (sign-in), and say what DaemonClient itself sees. Link from Settings and sign-in | P2 (link), P4 (policy page) |
| 5.1.1(v) | Account deletion inside the app | "Delete account" in Settings → the flow from A4 | P2 2.9 |
| 5.1.2(i) | Disclose and get permission before sharing personal data with third parties | Sign-up / first-run explains that photos are encrypted on the phone and stored in the user's Telegram channel | P2 |
| 2.3 / 2.3.1 | Metadata matches the app; *"Notes for Review"* describe features specifically | Review notes explain: own account, own bot and channel, client-side encryption, why photo-library and location permissions are asked | P4 |
| 2.3.10 | No other platforms' names or icons in the iOS app or metadata | Remove Android mentions from iOS screens and listing | P2 2.10, P4 |
| 4.1(c), 5.2.1 | No other developer's name, brand or icon | Remove what is left of Immich's brand from what users see: in-app links to `demo.immich.app`, `discord.immich.app`, `docs.immich.app`; Immich "support/licence" (purchase) screens; any "Immich" text. Keep the AGPL attribution in the licences screen (allowed and required) | P2 2.10 |
| 5.2.2 | Permission to use third-party services | Map tiles come from `tiles.immich.cloud` — Immich's server, not ours. The map is hidden (operator decision); remove the tile URLs or use a provider we may use | P2 2.10 |
| 3.1.1 | Unlocking features or content needs in-app purchase | DaemonClient is free today. Immich's licence-purchase flow must go (above). Any future paid plan sold in the app must use in-app purchase | P2 2.10 |
| 2.5.4 | Background services only for their intended purpose | Uploads: background `URLSession` (task completion) and `processing` — fine. "Always" location exists only to read the Wi-Fi name for Wi-Fi-only backup (iOS needs location for that); keep only if that option stays, and explain it in the review notes | P2 2.6 |
| 2.5.2 | No downloaded code that changes the app | The Rust core is compiled in; nothing is downloaded. Keep it that way (no code push services) | — |
| 4.8 | A third-party/social login needs an equivalent private option (e.g. Sign in with Apple) | Email + password on our own account system only — not needed. If Google sign-in is ever added, Sign in with Apple must be added too | — |
| 1.2 | User-generated content: filtering, reporting, blocking, contact info | Applies if users can share with *other users*. Keep sharing private (to chosen people); publish contact information; add "report" if public links stay | P2 2.10 |
| Export rules | App Store Connect asks whether the app uses non-exempt encryption | **`Info.plist` now says `ITSAppUsesNonExemptEncryption = false` — wrong once the core encrypts files with AES-GCM.** Set it to `true` and answer the export questions (standard algorithms, mass-market); France may need a declaration | P4 (before the first TestFlight) |
| Privacy manifest | App-level `PrivacyInfo.xcprivacy` (required-reason APIs, data collected, no tracking) | The Runner target has none | P4 |
| 4.2 | More than a repackaged website | Native backup, viewer and on-device encryption — fine | — |

## Already fine

- Sign-in with our own account system (4.8 exemption).
- Encryption and transfers happen in the app; nothing is downloaded and run.
- The Photos icon ("fanned gallery") is our own artwork, not Apple's.
