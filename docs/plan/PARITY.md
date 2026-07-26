# One codebase, two ways to run it

**The requirement, in the operator's words:** *"our own centralised version must
and will give the same services for the users who self deployed — no difference.
Both will have Immich and DaemonClient Photos and Drive. If there is a bug we
only fix once and push, so both types of users get the update."*

This is a hard requirement, not an aspiration. Every task in the master plan is
checked against it.

---

## Where we already stand

The product code has **no idea** whether it is hosted or self-hosted. Upload,
sync, thumbnails, albums, EXIF, live photos, Drive, WebDAV, the background heal
jobs — not one of them branches on the deployment mode.

Five places in the whole worker behave differently, and all five are plumbing:

| Where | Difference | Why it must exist |
|---|---|---|
| `helpers.ts` requireAuth | self-host returns after signature check | no Firebase refresh token to refresh |
| `helpers.ts` firestoreGet | returns null instead of calling Google | config lives in their own D1 |
| `server.ts` serverConfig | `externalDomain` from their address | never hand a self-hoster our domain |
| `assets.ts` webAppOrigin | same, for a user-facing message | same reason |
| `index.ts` status | reports `"self-hosted"` vs `"managed"` | a label |

Everything else is shared by construction:

- **The worker** — one source tree. Hosted builds it into the deployment
  service's embedded bundle; self-host builds the same tree with wrangler.
- **The database schema** — both read `MIGRATION_SQL` from the same file, plus
  the same self-healing `ALTER`s in `ensureDeduplicationSchema`.
- **Photos and Drive** — the same web apps, deployed to different hosts.
- **The mobile app** — literally the same binary. It points at a different
  server URL. One app in the store serves both.

So "no difference in services" is already true. What is *not* yet guaranteed is
the second half: **fix once, and both actually receive it.**

---

## The one asymmetry that cannot be removed

We can push a new build to a hosted user's worker, because we hold the
credentials for it. We cannot push to a self-hosted one — and must not be able
to. An install we can reach into is not self-hosted; principle P3 says a
self-hoster depends on nothing we run, including us.

So delivery differs even though the artifact does not:

```
              one commit, one release
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
   HOSTED                          SELF-HOSTED
   we push                         they pull
   deployment-service redeploys    worker sees the new release tag,
   every user's worker             shows a banner, one command applies it
   (no user action)                (their timing, their machine)
```

This is a feature. A self-hoster choosing when to update is the point. What we
owe them is that the update **exists, is visible, and is one command** — not
that it happens behind their back.

---

## What has to be built to make it real

Today the two halves can silently drift: hosted gets a fix the moment the deploy
pipeline runs, while self-hosters only learn about it if a GitHub *release* was
also cut. Nothing enforces that both happen. Three gaps to close:

### 1. One release action, both destinations

A single command or CI job that, from one tagged commit:

- builds the worker,
- deploys the hosted fleet (deployment-service, central worker, auto-update),
- publishes the GitHub release the self-hosted update check watches.

Cutting a release must not be something anyone can forget half of. If it cannot
do both, it should do neither and say why.

### 2. CI that proves both flavours work from the same commit

The suite must run in both modes. A self-host-only regression is otherwise
invisible until a stranger hits it — and they have no way to tell us apart from
their own misconfiguration.

Concretely: test both `SELF_HOST=1` and unset for every path that branches, and
assert the five divergence points stay the only ones (a test that greps for new
`isSelfHost` call sites and fails when the count grows without a note).

### 3. Version honesty

Both flavours report the same version string, from the same source, at
`/api/health` and in the dashboard. A bug report should identify the build
without anyone guessing.

---

## The compatibility rule this forces

One mobile app in the store talks to servers of many ages: a hosted user is
always current, a self-hoster may be months behind. So:

**The server may add to the sync stream and to API responses. It may not remove
or repurpose a field, and it may not tighten a request format, without a version
gate.** An older app must keep working against a newer server, and a newer app
must degrade gracefully against an older server.

This matters more here than in most projects, because of a failure mode this
codebase has already been bitten by: the app parses the sync stream in a strict
isolate, and a single unexpected value aborts **all** sync permanently. A field
change that a hosted user never notices — because their app and server updated
together — can brick a self-hoster whose server is older.

---

## How this is enforced

Gate 2 (principles fit) asks of every task:

- Does this add a sixth way hosted and self-hosted behave differently? If so, is
  it genuinely unavoidable plumbing, or is it a feature diverging?
- Would this change reach both kinds of user, through the mechanism above?
- Does it remove or repurpose anything an older client depends on?
