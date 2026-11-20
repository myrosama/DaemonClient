# daemonclient-proxy — the Telegram CORS relay

A ~60-line Cloudflare Worker whose entire job is to add CORS headers to
`api.telegram.org`.

## Why it has to exist

The Telegram Bot API sends no `Access-Control-Allow-Origin` header, so a browser
cannot call it directly. But the browser calling Telegram directly is the whole
design — it is what keeps file bytes out of the worker and inside the free tier.
So requests go through here instead:

```
browser ──▶ daemonclient-proxy?url=https://api.telegram.org/... ──▶ Telegram
```

The per-user worker has an equivalent `/proxy` route; this is the standalone
deployment used by clients that have no worker to route through yet.

## The allowlist is exact, and that is deliberate

```js
t.protocol === "https:" && t.hostname === "api.telegram.org" && t.port === ""
```

Not a suffix rule. `endsWith(".telegram.org")` looks equivalent and is not:
`аpi.telegram.org` with a Cyrillic **а** normalises to
`xn--pi-6kc.telegram.org`, a real subdomain in the real zone, and would pass.
Every caller in this repository builds exactly `https://api.telegram.org/...`,
so the wider rule buys nothing and costs a bypass.

This worker was previously an **open relay**: it forwarded any URL for any
caller with no authentication, passed the caller's `Authorization` and `Cookie`
headers through, and reflected every response header back with
`Access-Control-Allow-Origin: *`. That is usable for reaching private
addresses, laundering traffic through this account, and burning its quota. Do
not widen it.

## Running it

```bash
npm install
npm test
npx wrangler deploy
```
