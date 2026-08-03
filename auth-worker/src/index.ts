export interface Env {
  SESSION_SECRET: string
  FIREBASE_API_KEY: string
  FIREBASE_PROJECT_ID: string
  /** Cloudflare Turnstile secret. Set with `wrangler secret put TURNSTILE_SECRET`. */
  TURNSTILE_SECRET: string
}

/**
 * Canonical Turnstile siteverify. Fails CLOSED: a network error, a non-2xx, a
 * non-JSON body or `success !== true` all deny the request, because the point
 * is to refuse traffic we cannot prove is human.
 */
async function verifyTurnstile(token: string, clientIp: string | null, secret: string): Promise<boolean> {
  if (!secret) return false // unconfigured server must not silently allow everything
  if (!token) return false
  try {
    const body = new URLSearchParams({ secret, response: token })
    if (clientIp) body.set('remoteip', clientIp)
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return false
    const result = await res.json() as { success?: boolean }
    return result.success === true
  } catch {
    return false
  }
}

interface SessionData {
  uid: string
  email: string
  idToken: string
  refreshToken: string
  exp: number
  scope: string
}

async function hmacSign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`session:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

async function verifyFirebaseToken(idToken: string, apiKey: string): Promise<{ uid: string; email: string } | null> {
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken })
    })

    if (!res.ok) return null

    const data = await res.json() as any
    if (!data.users || data.users.length === 0) return null

    const user = data.users[0]
    return { uid: user.localId, email: user.email }
  } catch {
    return null
  }
}

function hashIp(ip: string | null): string {
  if (!ip) return 'unknown'
  // Simple hash for privacy
  const encoder = new TextEncoder()
  const data = encoder.encode(ip)
  return btoa(String.fromCharCode(...data)).substring(0, 16)
}

async function logActivity(env: Env, uid: string, idToken: string, activity: any) {
  try {
    const activityId = crypto.randomUUID()
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/artifacts/default-daemon-client/users/${uid}/activity/${activityId}`

    await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          timestamp: { timestampValue: new Date().toISOString() },
          action: { stringValue: activity.action },
          service: { stringValue: activity.service },
          ipAddress: { stringValue: activity.ipAddress },
          userAgent: { stringValue: activity.userAgent }
        }
      })
    })
  } catch (err) {
    console.error('Failed to log activity:', err)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS — must echo an exact origin when credentials are included, but ONLY
    // for our own origins. Reflecting arbitrary Origins with credentials:true
    // let any website read a visitor's login state / CSRF the logout.
    const ALLOWED_ORIGINS = new Set([
      'https://daemonclient.uz',
      'https://www.daemonclient.uz',
      'https://accounts.daemonclient.uz',
      'https://photos.daemonclient.uz',
      'https://drive.daemonclient.uz',
    ])
    const requestOrigin = request.headers.get('Origin')
    const origin = requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : 'https://accounts.daemonclient.uz'

    const corsHeaders = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // Create session endpoint
    if (url.pathname === '/create-session' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          idToken: string; refreshToken: string; returnUrl: string; 'cf-turnstile-response'?: string
        }

        // Prove a human is here before minting a session that is valid across
        // every *.daemonclient.uz app. Runs first so a bot burns no Firebase
        // lookup quota getting rejected.
        const human = await verifyTurnstile(
          body['cf-turnstile-response'] || '',
          request.headers.get('CF-Connecting-IP'),
          env.TURNSTILE_SECRET,
        )
        if (!human) {
          return new Response(JSON.stringify({ error: 'Verification failed' }), {
            status: 403,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }

        // Verify Firebase token
        const user = await verifyFirebaseToken(body.idToken, env.FIREBASE_API_KEY)
        if (!user) {
          return new Response(JSON.stringify({ error: 'Invalid token' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }

        // Create session token. Lifetime matches the rest of the ecosystem
        // (long-lived sessions; 400 days is the browser cookie cap) — the old
        // 7-day expiry made the landing page think logged-in users were
        // logged out after a week.
        const SESSION_MS = 400 * 24 * 60 * 60 * 1000
        const sessionData: SessionData = {
          uid: user.uid,
          email: user.email,
          idToken: body.idToken,
          refreshToken: body.refreshToken,
          exp: Date.now() + SESSION_MS,
          scope: 'global'
        }

        const payloadJson = JSON.stringify(sessionData)
        const payloadB64 = btoa(payloadJson)
        const signature = await hmacSign(payloadB64, env.SESSION_SECRET)
        const sessionToken = `${payloadB64}.${signature}`

        // Log activity
        await logActivity(env, user.uid, body.idToken, {
          action: 'login',
          service: 'accounts',
          ipAddress: hashIp(request.headers.get('CF-Connecting-IP')),
          userAgent: request.headers.get('User-Agent') || 'unknown'
        })

        // Set cookie
        const headers = new Headers(corsHeaders)
        headers.set('Content-Type', 'application/json')
        headers.set('Set-Cookie', `__session=${sessionToken}; Domain=.daemonclient.uz; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${400 * 24 * 60 * 60}`)

        return new Response(JSON.stringify({ redirectUrl: body.returnUrl }), {
          status: 200,
          headers
        })
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // Session check — lets the landing page (and any *.daemonclient.uz origin)
    // ask "is this browser logged in?" so CTAs can point at the dashboard
    // instead of the signup funnel. Verifies the HMAC + expiry; never returns
    // the token contents beyond the email.
    if (url.pathname === '/check-session' && request.method === 'GET') {
      const respond = (body: object) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        })
      try {
        const cookie = request.headers.get('Cookie') || ''
        const match = cookie.match(/(?:^|;\s*)__session=([^;]+)/)
        if (!match) return respond({ loggedIn: false })
        const [payloadB64, signature] = match[1].split('.')
        if (!payloadB64 || !signature) return respond({ loggedIn: false })
        const expected = await hmacSign(payloadB64, env.SESSION_SECRET)
        if (expected !== signature) return respond({ loggedIn: false })
        const session = JSON.parse(atob(payloadB64)) as SessionData
        if (!session.exp || session.exp < Date.now()) return respond({ loggedIn: false })
        return respond({ loggedIn: true, email: session.email })
      } catch {
        return respond({ loggedIn: false })
      }
    }

    // Hand an allowlisted app a FRESH Firebase ID token for the shared session.
    //
    // This is what makes one sign-in serve all three apps. Firebase persists its
    // session per origin, so signing in on accounts.daemonclient.uz leaves
    // Photos and Drive looking signed-out. They call this instead, then trade
    // the ID token for their own session at their per-user worker
    // (POST /api/auth/exchange).
    //
    // The refresh token stays in the HttpOnly cookie and is NEVER returned —
    // only the short-lived (1 hour) ID token crosses into JavaScript, which is
    // exactly what the Firebase SDK would hold anyway. Reading this requires
    // credentials plus an allowlisted Origin, so a third-party page cannot.
    if (url.pathname === '/session-token' && request.method === 'GET') {
      const respond = (body: object, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        })
      try {
        const cookie = request.headers.get('Cookie') || ''
        const match = cookie.match(/(?:^|;\s*)__session=([^;]+)/)
        if (!match) return respond({ loggedIn: false }, 401)

        const [payloadB64, signature] = match[1].split('.')
        if (!payloadB64 || !signature) return respond({ loggedIn: false }, 401)
        const expected = await hmacSign(payloadB64, env.SESSION_SECRET)
        if (expected !== signature) return respond({ loggedIn: false }, 401)

        const session = JSON.parse(atob(payloadB64)) as SessionData
        if (!session.exp || session.exp < Date.now()) return respond({ loggedIn: false }, 401)
        if (!session.refreshToken) return respond({ loggedIn: false }, 401)

        // Always mint a fresh one. The ID token stored at sign-in expires after
        // an hour, while the shared session is long-lived, so returning the
        // stored copy would work for an hour and then silently stop.
        const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${env.FIREBASE_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`
        })
        if (!res.ok) {
          // A revoked or rotated refresh token means the shared session is dead.
          // Clear it so the apps stop retrying and ask for a real sign-in.
          const headers = new Headers({ ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          headers.set('Set-Cookie', `__session=; Domain=.daemonclient.uz; Path=/; Max-Age=0`)
          return new Response(JSON.stringify({ loggedIn: false }), { status: 401, headers })
        }
        const data = await res.json() as any
        if (!data.id_token) return respond({ loggedIn: false }, 401)

        return respond({ loggedIn: true, idToken: data.id_token, email: session.email })
      } catch {
        return respond({ loggedIn: false }, 401)
      }
    }

    // Logout endpoint
    if (url.pathname === '/logout') {
      const headers = new Headers(corsHeaders)
      headers.set('Set-Cookie', `__session=; Domain=.daemonclient.uz; Path=/; Max-Age=0`)
      headers.set('Location', 'https://daemonclient.uz')

      return new Response(null, {
        status: 302,
        headers
      })
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders })
  }
}
