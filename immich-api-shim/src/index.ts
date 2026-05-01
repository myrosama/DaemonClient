import { handleAuth } from './auth';
import { handleServer } from './server';
import { handleTimeline } from './timeline';
import { handleAssets } from './assets';
import { handleUser } from './user';
import { handleAlbums } from './albums';
import { handleStubs } from './stubs';
import { handleSyncStream } from './sync';
import { handlePolicy } from './policy';
import { handleFeatureFlags } from './feature-flags';
import { handleSearch } from './search';
import { linkExistingLivePhotos } from './link-live-photos';
import { requireAuth } from './helpers';
import { proxyToUserWorker } from './proxy';
import type { D1Database } from '@cloudflare/workers-types';

// Path prefixes whose data lives in a per-user worker (D1 + ZKE keys + bot
// token). When this shim runs as the central router (no env.DB), these paths
// are proxied to the user's own worker. When it runs AS the per-user worker
// (env.DB bound), they're handled locally.
const PER_USER_PATHS = [
  '/api/assets',
  '/api/asset',
  '/api/timeline',
  '/api/users',
  '/api/albums',
  '/api/policy',
  '/api/sync',
  '/api/search',
  '/api/admin',
];

function isPerUserPath(path: string): boolean {
  return PER_USER_PATHS.some(p => path === p || path.startsWith(p + '/'));
}

export const WORKER_VERSION = '1.0.0';

export interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  APP_IDENTIFIER: string;
  TELEGRAM_PROXY: string;
  ALLOWED_ORIGINS: string;
  DB?: D1Database;
  ENCRYPTION_MASTER_KEY?: string;
  waitUntil?: (promise: Promise<any>) => void;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',');
  const isAllowed = allowed.includes(origin) || origin.includes('localhost');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Cookie',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (ctx) {
      env.waitUntil = ctx.waitUntil.bind(ctx);
    }
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const requestId = request.headers.get('x-request-id') || crypto.randomUUID();

    try {
      let response: Response;

      // ROUTER MODE: when this shim runs as the central worker (no D1 bound)
      // and the path is owned by per-user data, forward it to the user's own
      // worker — bypasses ISP blocks on *.workers.dev because clients only
      // ever talk to the central custom domain. Falls through to local
      // Firestore handlers if the user has no workerUrl in their session yet.
      if (!env.DB && isPerUserPath(path)) {
        const proxied = await proxyToUserWorker(request, env);
        if (proxied) {
          const newHeaders = new Headers(proxied.headers);
          for (const [k, v] of Object.entries(cors)) newHeaders.set(k, v);
          newHeaders.set('x-request-id', requestId);
          newHeaders.set('X-Worker-Version', WORKER_VERSION);
          newHeaders.set('X-Routed-Via', 'central-proxy');
          return new Response(proxied.body, { status: proxied.status, headers: newHeaders });
        }
        // proxyToUserWorker returned null → no session/workerUrl yet; fall
        // through to the normal handlers (which will Firestore-fallback).
      }

      if (path === '/api/health' && request.method === 'GET') {
        response = new Response(JSON.stringify({
          version: WORKER_VERSION,
          timestamp: Date.now(),
          database: env.DB ? 'connected' : 'not_configured'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else if (path === '/proxy') {
        const target = url.searchParams.get('url');
        if (!target) {
          response = new Response('Missing url parameter', { status: 400 });
        } else {
          let body: BodyInit | undefined;
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            body = await request.arrayBuffer();
          }
          const fwdHeaders = new Headers();
          const ct = request.headers.get('Content-Type');
          if (ct) fwdHeaders.set('Content-Type', ct);
          const upstream = await fetch(target, { method: request.method, headers: fwdHeaders, body });
          response = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
        }
      } else if (path.startsWith('/api/auth')) {
        response = await handleAuth(request, env, path);
      } else if (path.startsWith('/api/server') || path === '/api/server-info/config') {
        response = await handleServer(request, env, path);
      } else if (path.startsWith('/api/timeline')) {
        response = await handleTimeline(request, env, path, url);
      } else if (path.startsWith('/api/assets') || path.startsWith('/api/asset')) {
        response = await handleAssets(request, env, path, url);
      } else if (path.startsWith('/api/users')) {
        response = await handleUser(request, env, path);
      } else if (path.startsWith('/api/albums')) {
        response = await handleAlbums(request, env, path);
      } else if (path === '/api/policy/flags') {
        response = await handleFeatureFlags(request, env, path);
      } else if (path.startsWith('/api/policy')) {
        response = await handlePolicy(request, env, path);
      } else if (path === '/api/sync/stream') {
        response = await handleSyncStream(request, env);
      } else if (path.startsWith('/api/search')) {
        response = await handleSearch(request, env, path);
      } else if (path === '/api/admin/link-live-photos' && request.method === 'POST') {
        const session = await requireAuth(request, env);
        response = await linkExistingLivePhotos(request, env, session.uid, session.idToken);
      } else {
        response = await handleStubs(request, env, path);
      }

      // Add CORS and version to every response
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) {
        newHeaders.set(k, v);
      }
      newHeaders.set('x-request-id', requestId);
      newHeaders.set('X-Worker-Version', WORKER_VERSION);
      return new Response(response.body, { status: response.status, headers: newHeaders });
    } catch (err: any) {
      const msg = err.message || 'Internal error';
      const isAuth = msg === 'Not authenticated' || msg === 'Session expired';
      return new Response(JSON.stringify({ message: msg }), {
        status: isAuth ? 401 : 500,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId, ...cors },
      });
    }
  },
};
