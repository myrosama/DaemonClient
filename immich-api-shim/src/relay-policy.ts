// Small, pure rules for who may use this worker and how. Kept apart from the
// request handler so each can be tested on its own (relay-policy.test.ts).

/**
 * The bot a relayed Telegram request is for, from the path Telegram uses:
 * `/bot<TOKEN>/<method>` or `/file/bot<TOKEN>/<path>`. Null when there is none.
 */
export function telegramBotToken(target: URL): string | null {
  const match = target.pathname.match(/^\/(?:file\/)?bot([^/]+)\//);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Equal strings, compared without stopping at the first difference. */
export function sameSecret(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * Whether `origin` may read this worker's responses: an exact match against the
 * configured list (comma-separated). Anything else — including look-alikes such
 * as `https://localhost.example.com` — is refused.
 */
export function isAllowedOrigin(origin: string, allowedCsv: string): boolean {
  if (!origin) return false;
  return allowedCsv.split(',').map((entry) => entry.trim()).filter(Boolean).includes(origin);
}

/**
 * The session token a request carries. An explicit `Authorization: Bearer`
 * header wins over cookies: a browser also sends any cookie set for the
 * domain (the shared sign-in cookie among them), which must never shadow the
 * credential the caller chose to send.
 */
export function sessionTokenFrom(authorization: string | null, cookie: string | null): string | null {
  const auth = authorization || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const match = (cookie || '').match(/(?:^|;\s*)(?:immich_access_token|__session)=([^;]+)/);
  return match ? match[1] : null;
}
