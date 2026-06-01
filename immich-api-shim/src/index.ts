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
import type { D1Database } from '@cloudflare/workers-types';

export const WORKER_VERSION = '1.0.0';

export interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  APP_IDENTIFIER: string;
  TELEGRAM_PROXY: string;
  ALLOWED_ORIGINS: string;
  DB?: D1Database;
  ENCRYPTION_MASTER_KEY?: string;
  DEPLOYMENT_SERVICE_URL?: string;
  waitUntil?: (promise: Promise<any>) => void;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = env.ALLOWED_ORIGINS.split(',');
  const isAllowed = allowed.includes(origin) || origin.includes('localhost');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Cookie, Range',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    // Expose range/media headers so the browser's video element and SW can read them.
    // Without this, cross-origin 206 responses hide Content-Range and Accept-Ranges,
    // which breaks seek/duration on web and confuses AVPlayer diagnostics.
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag, X-Worker-Version',
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

      // OCR — Immich frontend probes every asset for OCR text; we don't
      // implement it. Answer here so the network panel stays clean.
      if (path.match(/^\/api\/assets\/[^/]+\/ocr$/) && request.method === 'GET') {
        return new Response(JSON.stringify({ ocr: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors, 'X-Worker-Version': WORKER_VERSION },
        });
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
      } else if (path.startsWith('/api/assets') || path.startsWith('/api/asset') ||
                 path === '/api/notifications' || path === '/api/map/markers' ||
                 path.startsWith('/api/trash')) {
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
