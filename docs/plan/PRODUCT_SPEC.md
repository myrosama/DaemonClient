# What we are building — the installer

An **interactive installer**: the thing a stranger runs once to stand up their
own DaemonClient. Described here as the user experiences it. This is the spec
every phase is checked against; where a phase document disagrees with it, this
wins.

> ### Naming — do not confuse these two
>
> | | |
> |---|---|
> | **The installer** (this document) | An interactive setup script. Run once. Creates their whole stack. Lives in `selfhost/`. |
> | **The DaemonClient CLI** | A *separate product* for automating DaemonClient **Drive** from a terminal — upload, download, sync. Currently the Python tool parked in the private ops repo. **We come back to it later.** |
>
> They share a brand and nothing else. The installer must not claim the
> `daemonclient` command name, because that name belongs to the Drive CLI.
>
> **Chosen entry point:** `npm create daemonclient@latest` — the idiomatic npm
> pattern for setup tools, which resolves to a package called
> `create-daemonclient`. Verified available on npm, along with
> `daemonclient` itself, which stays reserved for the Drive CLI.

---

## The journey

```
  daemonclient.uz  →  copy one line  →  paste into a terminal
                                              │
   1 ─ email + password        held in memory, account created at the end
   2 ─ Telegram                bot token, then channel id — each verified before accepting
   3 ─ Cloudflare              open a pre-scoped link, paste a token — verified before accepting
   4 ─ Firebase                sign in to their Google account; the script does the rest
                                              │
                                    ONE URL, printed once
                                              │
                     they open it, sign in with the email and password
                     from step 1, and they are inside their own copy of
                     the dashboard — Photos and Drive working, entirely
                     their infrastructure
```

Nothing in that flow sends anything to us. The finished install talks to
exactly one address of ours, ever: the GitHub releases feed, to ask whether a
newer version exists.

## The end state, precisely

The last line the CLI prints is a URL to **their own deployment of the accounts
dashboard** — the same application as `accounts.daemonclient.uz`, built from
this repository, deployed to their Firebase Hosting, pointed at their worker.
From there Photos and Drive are one click away and work immediately.

Not: a workers.dev API address they have to do something with. Not: three URLs
and an explanation. **One URL, and they are in.**

---

## Step by step, with what each one must actually do

### 1 · Email and password

Asked first, because it is the only thing the user already knows the answer to,
and starting a setup with a question you cannot fail is good design.

**The ordering problem, stated plainly.** Accounts live in Firebase, and
Firebase is not configured until step 4. So the credentials are held in memory
through the run and the account is created at the very end, once the project
exists. Two consequences that must be designed for, not discovered:

- The password sits in process memory for the length of the setup. It must
  never be written to `.daemonclient-selfhost.json`, never logged, and never
  echoed at the prompt.
- If the run is interrupted after step 1, resuming cannot recover the password —
  the resume path has to ask for it again rather than proceeding with a blank.

### 2 · Telegram

Two values, asked one at a time, each **verified against the live API before
the wizard moves on**.

| Value | Verified how |
|---|---|
| Bot token | `getMe` — confirms the token is real and returns the bot's username to show back |
| Channel or group id | `getChat`, then `getChatMember` for the bot — confirms it is present **and** an administrator |
| Can it actually post? | send a message, then delete it |

That last check is not paranoia and is already the reason the current code does
it: a bot can be a member of a channel and still be unable to write to it, and
finding that out on the user's first upload instead of during setup is the
difference between a product and a demo.

The user creates the bot themselves via BotFather. We do not do it for them —
that is precisely what the managed service does, and self-hosting exists so
that nobody but them ever holds those credentials.

### 3 · Cloudflare

Open a link, create a token, paste it back. Verified before accepting.

**The improvement to chase:** a link that arrives at the token screen with the
required permissions already selected, so the user presses Continue → Create →
Copy rather than hunting three permission rows out of a long list. Cloudflare's
dashboard does support pre-filled token templates, but the URL parameters for
it are **undocumented**, so this needs a spike with a real browser before it
goes in the plan as a certainty. The fallback is the current behaviour: a plain
link plus an exact list of the three permissions.

Verification must check the token *can do the things we need* — not merely that
it authenticates. The existing `REQUIRED_TOKEN_PERMISSIONS` probe already works
this way and stays.

### 4 · Firebase

`firebase login` opens their browser, they sign in to their own Google account,
and the script provisions the project: create it, register a web app, read the
config, enable email sign-in, create the account from step 1.

Four of those five are confirmed available in `firebase-tools`. Enabling the
email provider has no CLI command and needs the Identity Toolkit Admin API —
see `MASTER_PLAN.md` Phase 4. The floor, if that proves impossible, is one
toggle on one page rather than the current eight-value copy-paste.

### 5 · The URL

Everything up to here has been questions. This step is the CLI working while
the user watches: deploy the worker, run migrations, seed encryption keys,
build three web apps, deploy them to their Firebase Hosting, wire
`ALLOWED_ORIGINS`, create their account, health-check the result.

It is several minutes of real work, and the interface has to make that feel
deliberate rather than hung. Then: one URL.

---

## What "cool CLI" means concretely

Not decoration. Four properties, each of which fixes a way a wizard fails:

1. **Every question is answerable.** Before asking for a value, say where to get
   it — the exact page, the exact button.
2. **Nothing is accepted unverified.** Every credential is checked against the
   live service before the wizard advances. A setup that fails at step 5 because
   of a typo in step 2 has wasted the user's time and their trust.
3. **Long work is legible.** A spinner with a changing label, and a task list
   that keeps completed steps visible, so a four-minute deploy reads as progress
   rather than a hang.
4. **Interruption is safe.** Ctrl-C at any prompt exits cleanly with a message
   saying how to resume — never a half-written state file or a stack trace.

## The constraint that governs all of it

> *"Self-hosting means self-hosting — in no way tied to our central system. The
> only thing that touches us is the update check."*

Every step above runs against the user's own accounts. The one-line installer
is fetched from us once and then never again.
