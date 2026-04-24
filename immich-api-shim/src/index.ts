import { handleAuth } from './auth';
import { handleServer } from './server';
import { handleTimeline } from './timeline';
import { handleAssets } from './assets';
import { handleUser } from './user';
import { handleStubs } from './stubs';

export interface Env {
  FIREBASE_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  APP_IDENTIFIER: string;
  TELEGRAM_PROXY: string;
  ALLOWED_ORIGINS: string;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      let response: Response;

      if (path.startsWith('/api/auth')) {
        response = await handleAuth(request, env, path);
      } else if (path.startsWith('/api/server') || path === '/api/server-info/config') {
        response = await handleServer(request, env, path);
      } else if (path.startsWith('/api/timeline')) {
        response = await handleTimeline(request, env, path, url);
      } else if (path.startsWith('/api/assets') || path.startsWith('/api/asset')) {
        response = await handleAssets(request, env, path, url);
      } else if (path.startsWith('/api/users')) {
        response = await handleUser(request, env, path);
      } else {
        response = await handleStubs(request, env, path);
      }

      // Add CORS to every response
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) {
        newHeaders.set(k, v);
      }
      return new Response(response.body, { status: response.status, headers: newHeaders });
    } catch (err: any) {
      return new Response(JSON.stringify({ message: err.message || 'Internal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  },
};
