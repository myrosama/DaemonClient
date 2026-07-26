# Documentation

## If you want to run DaemonClient yourself

- **[SELF_HOSTING.md](SELF_HOSTING.md)** — set up your own instance on your own
  Telegram, Cloudflare and Firebase accounts. Start here.

## If you use the hosted service

- **[SETUP_GUIDE.md](SETUP_GUIDE.md)** — signing up and connecting your storage
  at daemonclient.uz.

## If you want to work on the code

- **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — where things live, and the four
  hard constraints that explain most of the odd-looking code.
- **[../SECURITY.md](../SECURITY.md)** — reporting a vulnerability, and the
  security model.

## Design and planning

Current work:

| | |
|---|---|
| [plan/MASTER_PLAN.md](plan/MASTER_PLAN.md) | the phased plan of record |
| [plan/SCRATCHPAD.md](plan/SCRATCHPAD.md) | what is done and what is next, updated continuously |
| [plan/ALTERNATIVES.md](plan/ALTERNATIVES.md) | research into other ways of building each piece |
| [roadmap/SELFHOST_CLI_DESIGN.md](roadmap/SELFHOST_CLI_DESIGN.md) | **authoritative** design for the setup CLI, verified against real tool behaviour |

Background and history:

| | |
|---|---|
| [roadmap/SELFHOST_PIVOT.md](roadmap/SELFHOST_PIVOT.md) | the original brief for going open-source and self-hostable |
| [roadmap/SELFHOST_DESIGN.md](roadmap/SELFHOST_DESIGN.md) | first architecture pass; superseded in places by the CLI design above |
| [roadmap/PROGRAM.md](roadmap/PROGRAM.md) | the multi-product picture: Photos, Drive, accounts |
| [roadmap/MOBILE_APP.md](roadmap/MOBILE_APP.md) | the mobile fork's history and constraints |
| [roadmap/CLOUDFLARE_OAUTH.md](roadmap/CLOUDFLARE_OAUTH.md) | the hosted service's one-click Cloudflare flow. **Not** used by self-hosting — that path uses `wrangler login`, which is Cloudflare's own OAuth app rather than ours. |
| [seo/PLAN.md](seo/PLAN.md) | search strategy for the public site |

When a document stops being true, fix it or delete it. A stale design doc is
worse than none, because someone will follow it.
