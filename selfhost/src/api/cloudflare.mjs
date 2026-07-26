// Cloudflare API calls used during setup.
//
// The token stays on the user's machine and is sent only to api.cloudflare.com.
// We ask for the narrowest set of permissions that can still create a D1
// database and deploy a Worker, and we verify the token before using it so a
// wrong-scope token fails with a clear message instead of a 403 mid-deploy.

const API = 'https://api.cloudflare.com/client/v4';

async function cf(token, path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Cloudflare returned ${res.status} with an unreadable body`);
  if (!data.success) {
    const msg = (data.errors || []).map((e) => `${e.message}${e.code ? ` (${e.code})` : ''}`).join('; ');
    throw new Error(msg || `Cloudflare returned ${res.status}`);
  }
  return data.result;
}

/** Verify the token is live. Returns its status. */
export async function verifyToken(token) {
  const result = await cf(token, '/user/tokens/verify');
  if (result.status !== 'active') throw new Error(`Token status is "${result.status}"`);
  return result;
}

/** Accounts this token can act on. A token scoped to one account returns one. */
export async function listAccounts(token) {
  return cf(token, '/accounts');
}

export async function listD1(token, accountId) {
  return cf(token, `/accounts/${accountId}/d1/database`);
}

export async function createD1(token, accountId, name) {
  return cf(token, `/accounts/${accountId}/d1/database`, { method: 'POST', body: { name } });
}

/** Run SQL against a D1 database. Used for migrations and for writing the
 *  first admin account, so the install never needs a bootstrap endpoint. */
export async function queryD1(token, accountId, databaseId, sql, params = []) {
  return cf(token, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: { sql, params },
  });
}

/** The workers.dev subdomain for this account, e.g. "alice" in
 *  alice.workers.dev. Needed to tell the user their worker's URL. */
export async function getWorkersSubdomain(token, accountId) {
  const result = await cf(token, `/accounts/${accountId}/workers/subdomain`);
  return result?.subdomain || null;
}

export async function enableWorkersDev(token, accountId, scriptName) {
  return cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
    method: 'POST',
    body: { enabled: true },
  });
}

/** Upload a Worker with its bindings, as a multipart module upload. */
export async function deployWorker(token, accountId, scriptName, scriptBody, bindings) {
  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2024-09-23',
    compatibility_flags: ['nodejs_compat'],
    bindings,
  };

  const boundary = `----DaemonClient${Math.random().toString(36).slice(2)}`;
  const parts = [
    `--${boundary}\r\n`,
    'Content-Disposition: form-data; name="metadata"\r\n',
    'Content-Type: application/json\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n',
    'Content-Type: application/javascript+module\r\n\r\n',
    scriptBody,
    `\r\n--${boundary}--\r\n`,
  ].join('');

  const res = await fetch(`${API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: parts,
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) {
    const msg = (data?.errors || []).map((e) => e.message).join('; ');
    throw new Error(msg || `Worker upload failed with ${res.status}`);
  }
  return data.result;
}

/** Store a value as a Worker secret rather than a plain-text var, so it is not
 *  readable from the Cloudflare dashboard's environment listing. */
export async function putWorkerSecret(token, accountId, scriptName, name, text) {
  return cf(token, `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`, {
    method: 'PUT',
    body: { name, text, type: 'secret_text' },
  });
}

export const REQUIRED_TOKEN_PERMISSIONS = [
  'Account · Workers Scripts · Edit',
  'Account · D1 · Edit',
  'Account · Account Settings · Read',
];
