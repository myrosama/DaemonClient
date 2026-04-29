export interface Env {
  SESSION_SECRET: string
  FIREBASE_API_KEY: string
  FIREBASE_PROJECT_ID: string
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

    // CORS — must echo exact origin when credentials are included
    const requestOrigin = request.headers.get('Origin')
    const origin = requestOrigin || 'https://accounts.daemonclient.uz'

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
        const body = await request.json() as { idToken: string; refreshToken: string; returnUrl: string }

        // Verify Firebase token
        const user = await verifyFirebaseToken(body.idToken, env.FIREBASE_API_KEY)
        if (!user) {
          return new Response(JSON.stringify({ error: 'Invalid token' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }

        // Create session token
        const sessionData: SessionData = {
          uid: user.uid,
          email: user.email,
          idToken: body.idToken,
          refreshToken: body.refreshToken,
          exp: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
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
        headers.set('Set-Cookie', `__session=${sessionToken}; Domain=.daemonclient.uz; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`)

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
