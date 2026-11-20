# daemonclient-proxy — the Telegram CORS relay

A ~60-line Cloudflare Worker whose entire job is to add CORS headers to
`api.telegram.org`.

## Why it has to exist

The Telegram Bot API sends no `Access-Control-Allow-Origin` header, so a browser
cannot call it directly. A relay that only streams bytes and adds CORS headers
lets the browser do the chunking and encryption itself, without any worker
assembling files. Requests went through here:

```
browser ──▶ daemonclient-proxy?url=https://api.telegram.org/... ──▶ Telegram
```

The websites now use each user's own worker's `/proxy` route instead. This
standalone deployment is legacy: it only serves clients that have no worker to
route through yet.

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
