import { useState, useEffect, useCallback, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { auth, db } from './config/firebase'
import firebase from './config/firebase'
import { Button } from './components/ui/Button'
import { Input } from './components/ui/Input'
import { Card } from './components/ui/Card'
import { toast } from './components/ui/Toast'
import { SetupWorker } from './pages/SetupWorker'
import { consumeOAuthState, CF_OAUTH_REDIRECT_URI, DEPLOYMENT_WORKER } from './config/cloudflareOauth'
import { thumbHashToDataURL } from 'thumbhash'

// Render a stored thumbhash (base64) into a tiny blurred data-URL preview —
// real photo content, no authenticated image fetch needed.
function thumbhashToUrl(b64) {
  if (!b64) return null
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return thumbHashToDataURL(bytes)
  } catch {
    return null
  }
}
import {
  LayoutDashboard,
  User,
  Shield,
  LogOut,
  Image,
  FolderOpen,
  Loader2,
  Check,
  X,
  ExternalLink,
  ChevronRight,
  Bot,
  Hash,
  Eye,
  EyeOff,
  Palette,
  Lock,
  Clock,
  Globe,
  Monitor,
  ArrowLeft,
  Server,
  Copy,
  Smartphone,
} from 'lucide-react'

// ============================================================================
// CONSTANTS
// ============================================================================

const APP_ID = 'default-daemon-client'
const RENDER_BACKEND = 'https://daemonclient-elnj.onrender.com'
// Custom domain — *.workers.dev is blocked on some mobile carriers.
const AUTH_WORKER = 'https://auth.daemonclient.uz'

const AVATAR_COLORS = [
  '#E11D48', '#DB2777', '#C026D3', '#9333EA', '#7C3AED',
  '#6366F1', '#4F46E5', '#2563EB', '#0284C7', '#0891B2',
  '#0D9488', '#059669', '#16A34A', '#65A30D', '#CA8A04',
  '#D97706', '#EA580C', '#DC2626',
]

// ============================================================================
// HELPER: Firestore paths
// ============================================================================

function userPath(uid) {
  return `artifacts/${APP_ID}/users/${uid}`
}

function configPath(uid) {
  return `artifacts/${APP_ID}/users/${uid}/config`
}

// ============================================================================
// HELPER: Session management
// ============================================================================

async function createSession(idToken, refreshToken, returnUrl = '/dashboard') {
  const res = await fetch(`${AUTH_WORKER}/create-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ idToken, refreshToken, returnUrl }),
  })
  return res
}

async function destroySession() {
  await fetch(`${AUTH_WORKER}/logout`, {
    method: 'POST',
    credentials: 'include',
  })
}

// ============================================================================
// DAEMON LOGO SVG
// ============================================================================

function DaemonLogo({ size = 44, className = '' }) {
  return (
    <img
      src="/logo.png"
      alt="DaemonClient"
      width={size}
      height={size}
      className={`object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  )
}

// ============================================================================
// CLUSTER BACKGROUND — scattered dot constellations
// ============================================================================

function AnimatedBackground() {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let raf

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    const COUNT = 75
    const MAX_DIST = 150
    const particles = Array.from({ length: COUNT }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 1.3 + 0.7,
    }))

    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (const p of particles) {
        p.x += p.vx
        p.y += p.vy
        if (p.x < 0 || p.x > canvas.width)  p.vx *= -1
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1
      }

      // connecting lines
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x
          const dy = particles[i].y - particles[j].y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < MAX_DIST) {
            ctx.beginPath()
            ctx.strokeStyle = `rgba(255,255,255,${(1 - d / MAX_DIST) * 0.1})`
            ctx.lineWidth = 0.5
            ctx.moveTo(particles[i].x, particles[i].y)
            ctx.lineTo(particles[j].x, particles[j].y)
            ctx.stroke()
          }
        }
      }

      // dots
      for (const p of particles) {
        ctx.beginPath()
        ctx.fillStyle = 'rgba(255,255,255,0.2)'
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(tick)
    }

    tick()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
    />
  )
}

// ============================================================================
// DOT GRID BACKGROUND
// ============================================================================

function DotGridPage({ children, className = '' }) {
  return (
    <div className={`min-h-screen dot-grid flex flex-col relative ${className}`}>
      <AnimatedBackground />
      {children}
    </div>
  )
}

// ============================================================================
// TERMINAL BAR — decorative header for setup pages
// ============================================================================

function TerminalBar({ command = 'curl -fsL https://daemonclient.uz/install.sh | bash' }) {
  return (
    <div className="w-full flex justify-center pt-6 px-4">
      <div className="inline-flex items-center gap-3 bg-[#111318] border border-white/[0.08] rounded-lg px-5 py-2.5">
        <div className="flex gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
          <div className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
        </div>
        <span className="font-mono text-[12px] text-linear-text-secondary tracking-wide select-none">
          {command}
        </span>
      </div>
    </div>
  )
}

// ============================================================================
// AUTH FOOTER
// ============================================================================

function AuthFooter() {
  return (
    <div className="mt-6 text-center">
      <div className="flex items-center justify-center gap-4 text-[11px] text-linear-text-secondary">
        <a href="https://daemonclient.uz/terms" className="hover:text-linear-text transition-colors">Terms</a>
        <a href="https://daemonclient.uz/privacy" className="hover:text-linear-text transition-colors">Privacy</a>
        <a href="https://daemonclient.uz/help" className="hover:text-linear-text transition-colors">Help</a>
      </div>
    </div>
  )
}

// ============================================================================
// SPINNER
// ============================================================================

function Spinner({ size = 20, className = '' }) {
  return (
    <Loader2
      size={size}
      className={`animate-spin text-linear-purple ${className}`}
    />
  )
}

function FullScreenSpinner({ message }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-linear-bg">
      <Spinner size={32} />
      {message && (
        <p className="mt-4 text-sm text-linear-text-secondary">{message}</p>
      )}
    </div>
  )
}

// ============================================================================
// LAYOUT — Topbar (used for all protected pages)
// ============================================================================

function Layout({ children, user }) {
  const navigate = useNavigate()
  const location = useLocation()

  const handleLogout = async () => {
    try {
      await auth.signOut()
      await destroySession()
      navigate('/login')
    } catch (error) {
      console.error('Logout error:', error)
    }
  }

  if (!user) return <>{children}</>

  const initials = user.displayName
    ? user.displayName.charAt(0).toUpperCase()
    : user.email.charAt(0).toUpperCase()

  const isDashboard = location.pathname === '/dashboard'

  return (
    <div className={`min-h-screen ${isDashboard ? '' : 'bg-linear-bg'}`}>
      {/* Top bar */}
      <header className={`h-13 border-b flex items-center justify-between px-6 sticky top-0 backdrop-blur-xl z-20 ${
        isDashboard
          ? 'border-white/[0.08] bg-black/25'
          : 'border-white/[0.06] bg-linear-bg/90'
      }`}>
        <Link to="/dashboard" className="flex items-center gap-2.5">
          <DaemonLogo size={30} />
          <span className={`text-[15px] font-semibold ${isDashboard ? 'text-white' : 'text-linear-text'}`}>
            DaemonClient
          </span>
        </Link>

        <div className="flex items-center gap-3">
          {!isDashboard && (
            <Link
              to="/dashboard"
              className="flex items-center gap-1.5 text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors"
            >
              <ArrowLeft size={13} />
              Dashboard
            </Link>
          )}
          <button
            onClick={handleLogout}
            className={`flex items-center gap-1.5 text-[13px] transition-colors ${
              isDashboard ? 'text-white/60 hover:text-white' : 'text-linear-text-secondary hover:text-linear-text'
            }`}
          >
            <LogOut size={13} strokeWidth={1.8} />
          </button>
          <div className="w-8 h-8 rounded-full bg-linear-purple flex items-center justify-center shrink-0">
            <span className="text-white text-[13px] font-semibold">{initials}</span>
          </div>
        </div>
      </header>

      <main className={isDashboard ? '' : 'max-w-3xl mx-auto p-8'}>{children}</main>

      {/* Footer — hidden on dashboard (it has its own) */}
      {!isDashboard && (
        <footer className="mt-auto py-6 border-t border-white/[0.04] px-8">
          <div className="flex items-center justify-between text-[11px] text-linear-text-secondary">
            <div className="flex gap-4">
              <a href="https://daemonclient.uz/help" className="hover:text-linear-text transition-colors">Help</a>
              <a href="https://daemonclient.uz/terms" className="hover:text-linear-text transition-colors">Terms</a>
              <a href="https://daemonclient.uz/privacy" className="hover:text-linear-text transition-colors">Privacy</a>
            </div>
          </div>
        </footer>
      )}
    </div>
  )
}

// ============================================================================
// LOGIN PAGE
// ============================================================================

function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleLogin = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const userCredential = await auth.signInWithEmailAndPassword(email, password)
      const idToken = await userCredential.user.getIdToken()
      const refreshToken = userCredential.user.refreshToken

      const params = new URLSearchParams(window.location.search)
      const returnUrl = params.get('return_url') || '/dashboard'

      // Create cross-domain session (non-blocking — Firebase Auth handles core auth)
      try {
        const res = await createSession(idToken, refreshToken, returnUrl)
        if (res.ok) {
          const data = await res.json()
          if (data.redirectUrl && data.redirectUrl.startsWith('http')) {
            window.location.href = data.redirectUrl
            return
          }
        }
      } catch (sessionErr) {
        console.warn('Session creation failed (non-critical):', sessionErr)
      }

      // Navigate — route guards will redirect to correct step
      navigate(returnUrl)
    } catch (err) {
      const msg = err.code === 'auth/user-not-found'
        ? 'No account found with this email'
        : err.code === 'auth/wrong-password'
        ? 'Incorrect password'
        : err.code === 'auth/invalid-credential'
        ? 'Invalid email or password'
        : err.code === 'auth/too-many-requests'
        ? 'Too many attempts. Try again later.'
        : err.message || 'Sign in failed'
      setError(msg)
      setLoading(false)
    }
  }

  return (
    <DotGridPage className="items-center justify-center px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-[400px] relative z-10"
      >
        {/* Single card — logo + title + form all inside */}
        <div className="bg-[#13151B] border border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 overflow-hidden">

          {/* Logo + title */}
          <div className="text-center pt-9 pb-6 px-8">
            <div className="flex justify-center mb-4">
              <DaemonLogo size={64} />
            </div>
            <h1 className="text-[21px] font-semibold text-linear-text tracking-tight">
              Sign in to DaemonClient
            </h1>
          </div>

          {/* Form */}
          <div className="px-8 pb-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                  Email address
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  required
                  error={!!error}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                  Password
                </label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter a password"
                    required
                    error={!!error}
                    className="w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-linear-text-secondary hover:text-linear-text transition-colors"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-[13px] text-linear-error">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-full bg-daemon-green hover:bg-daemon-green-hover text-white text-[14px] font-semibold transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-1"
              >
                {loading ? (
                  <>
                    <Spinner size={14} className="text-white" />
                    Signing in…
                  </>
                ) : 'Sign In'}
              </button>
            </form>

            {/* Forgot password — below button */}
            <div className="text-center mt-3">
              <button
                type="button"
                className="text-[12px] text-linear-text-secondary hover:text-linear-text transition-colors"
              >
                Forgot password?
              </button>
            </div>
          </div>

          {/* Bottom — create account + terms */}
          <div className="border-t border-white/[0.06] px-8 py-5 text-center space-y-3">
            <p className="text-[13px] text-linear-text-secondary">
              New to DaemonClient?{' '}
              <Link
                to="/signup"
                className="text-daemon-green hover:text-daemon-green-hover transition-colors font-medium"
              >
                Create account
              </Link>
            </p>
            <div className="flex items-center justify-center gap-5 text-[11px] text-linear-text-secondary/50">
              <a href="https://daemonclient.uz/terms" className="hover:text-linear-text-secondary transition-colors">Terms</a>
              <a href="https://daemonclient.uz/privacy" className="hover:text-linear-text-secondary transition-colors">Privacy</a>
              <a href="https://daemonclient.uz/help" className="hover:text-linear-text-secondary transition-colors">Help</a>
            </div>
          </div>
        </div>
      </motion.div>
    </DotGridPage>
  )
}

// ============================================================================
// SIGNUP PAGE
// ============================================================================

function SignupPage() {
  // Warm the setup service while the user types: Render's free tier naps and
  // takes up to a minute to wake — by the time the account exists and they
  // click "Create My Secure Storage", the service is already hot.
  useEffect(() => {
    fetch(`${RENDER_BACKEND}/`).catch(() => {})
  }, [])

  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSignup = async (e) => {
    e.preventDefault()
    setError('')

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)

    try {
      const userCredential = await auth.createUserWithEmailAndPassword(email, password)
      const user = userCredential.user
      // Set display name if provided
      if (displayName.trim()) {
        try { await user.updateProfile({ displayName: displayName.trim() }) } catch (e) {}
      }
      const idToken = await user.getIdToken()

      // Kick the automated Telegram setup in the BACKGROUND. Two hard rules
      // learned from the double-bot bug:
      //  1. Set the in-flight lock BEFORE the request — SetupPage's guards
      //     read it; the old unlocked call here plus a click on /setup was
      //     the double-bot recipe.
      //  2. Never await the full response — the server holds it for the whole
      //     30-90s creation, and a signup spinner that hangs for minutes is
      //     exactly what makes users refresh and re-trigger.
      try {
        localStorage.setItem(`dc_setup_inflight_${user.uid}`, String(Date.now()))
        fetch(`${RENDER_BACKEND}/startSetup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ data: { uid: user.uid, email: user.email } }),
          keepalive: true,
        }).catch(() => {
          // Request never reached the server → release so /setup can retry now.
          localStorage.removeItem(`dc_setup_inflight_${user.uid}`)
        })
      } catch (setupErr) {
        console.warn('Setup call failed, will retry on setup page:', setupErr)
      }

      // Create session (non-blocking — cross-domain cookie is nice-to-have)
      try {
        const refreshToken = user.refreshToken
        await createSession(idToken, refreshToken, '/setup')
      } catch (sessionErr) {
        console.warn('Session creation failed (non-critical):', sessionErr)
      }

      // Log signup activity
      try {
        await db.collection(`${userPath(user.uid)}/activity`).add({
          type: 'signup',
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          userAgent: navigator.userAgent,
          ip: 'client',
        })
      } catch (e) {
        // non-critical
      }

      navigate('/setup')
    } catch (err) {
      const msg = err.code === 'auth/email-already-in-use'
        ? 'An account with this email already exists'
        : err.code === 'auth/weak-password'
        ? 'Password is too weak'
        : err.code === 'auth/invalid-email'
        ? 'Invalid email address'
        : err.message || 'Sign up failed'
      setError(msg)
      setLoading(false)
    }
  }

  return (
    <DotGridPage className="items-center justify-center px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-[400px] relative z-10"
      >
        <div className="bg-[#13151B] border border-white/[0.09] rounded-2xl shadow-2xl shadow-black/60 overflow-hidden">

          {/* Logo + title */}
          <div className="text-center pt-9 pb-6 px-8">
            <div className="flex justify-center mb-4">
              <DaemonLogo size={64} />
            </div>
            <h1 className="text-[21px] font-semibold text-linear-text tracking-tight">
              Create your account
            </h1>
          </div>

          {/* Form */}
          <div className="px-8 pb-6">
            <form onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                  Full Name
                </label>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Your Name"
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                  Email address
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  required
                  error={!!error}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                  Password
                </label>
                <div className="relative">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    required
                    error={!!error}
                    className="w-full pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-linear-text-secondary hover:text-linear-text transition-colors"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-[13px] text-linear-error">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-full bg-daemon-green hover:bg-daemon-green-hover text-white text-[14px] font-semibold transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-1"
              >
                {loading ? (
                  <>
                    <Spinner size={14} className="text-white" />
                    Creating account…
                  </>
                ) : 'Create account'}
              </button>
            </form>
          </div>

          {/* Bottom — sign in + terms */}
          <div className="border-t border-white/[0.06] px-8 py-5 text-center space-y-3">
            <p className="text-[13px] text-linear-text-secondary">
              Already have an account?{' '}
              <Link
                to="/login"
                className="text-daemon-green hover:text-daemon-green-hover transition-colors font-medium"
              >
                Sign in
              </Link>
            </p>
            <div className="flex items-center justify-center gap-5 text-[11px] text-linear-text-secondary/50">
              <a href="https://daemonclient.uz/terms" className="hover:text-linear-text-secondary transition-colors">Terms</a>
              <a href="https://daemonclient.uz/privacy" className="hover:text-linear-text-secondary transition-colors">Privacy</a>
              <a href="https://daemonclient.uz/help" className="hover:text-linear-text-secondary transition-colors">Help</a>
            </div>
          </div>
        </div>
      </motion.div>
    </DotGridPage>
  )
}

// ============================================================================
// SETUP PAGE — Telegram Bot/Channel Setup
// ============================================================================

function SetupPage() {
  const navigate = useNavigate()
  const [showManualForm, setShowManualForm] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [botToken, setBotToken] = useState('')
  const [channelId, setChannelId] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [alreadyConfigured, setAlreadyConfigured] = useState(false)
  // Did we get the first Firestore snapshot back? Until we have, we don't know
  // whether the user already has a telegram doc — clicking Start Setup before
  // this is true would re-call /startSetup and create a duplicate bot/channel.
  const [snapshotReady, setSnapshotReady] = useState(false)
  // Anything in the telegram doc at all (even partial) means /startSetup is
  // already in flight or completed. Don't run it again.
  const [docExists, setDocExists] = useState(false)

  // Wake the setup service the moment the page renders. Render's free tier
  // naps after inactivity and takes up to a minute to cold-start — warming it
  // while the user is still reading means their click lands on a hot service.
  useEffect(() => {
    fetch(`${RENDER_BACKEND}/`).catch(() => {})
  }, [])

  const handleStartAutomatedSetup = async () => {
    if (alreadyConfigured) {
      navigate('/setup/ownership')
      return
    }

    const uid = auth.currentUser.uid
    // Survives a page reload during the slow (30-90s) creation window, when the
    // Firestore doc doesn't exist yet so `docExists` can't protect us.
    const inflightKey = `dc_setup_inflight_${uid}`
    const startedTs = parseInt(localStorage.getItem(inflightKey) || '0', 10)
    const recentlyStarted = startedTs && Date.now() - startedTs < 240000

    // HARD RULE: never POST /startSetup when a bot/channel already exists (even
    // a partial doc) OR a create is already in flight. A second create spawns a
    // duplicate bot+channel; the new channelId overwrites the doc, so the user
    // joins one channel while finalize searches the other → "could not find you
    // in the channel." This guard makes the client safe on its own, without
    // depending on the server-side idempotency (which needs a Render redeploy).
    const alreadyInFlight = docExists || recentlyStarted

    setError('')
    setIsLoading(true)

    const t0 = Date.now()
    const stages = [
      [8, 'Waking the setup service… free hosting naps, this can take a minute.'],
      [40, 'Creating your private bot and storage channel… (30–90 seconds)'],
      [110, 'Still working — Telegram rate-limits bot creation. Almost there…'],
    ]
    let ticker = null
    const startTicker = () => {
      ticker = setInterval(() => {
        const s = Math.round((Date.now() - t0) / 1000)
        for (let i = stages.length - 1; i >= 0; i--) {
          if (s >= stages[i][0]) { setStatusMessage(stages[i][1]); break }
        }
      }, 3000)
    }

    try {
      if (!alreadyInFlight) {
        setStatusMessage('Contacting the setup service…')
        // Mark in-flight BEFORE the call so a reload mid-creation can't re-trigger.
        localStorage.setItem(inflightKey, String(Date.now()))
        startTicker()
        const idToken = await auth.currentUser.getIdToken()
        const response = await fetch(`${RENDER_BACKEND}/startSetup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ data: { uid, email: auth.currentUser.email } }),
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok && response.status !== 202) {
          // Hard failure → nothing was created; release the lock so a retry works.
          localStorage.removeItem(inflightKey)
          throw new Error(result.error?.message || 'The setup service returned an error.')
        }
      } else {
        setStatusMessage('Your private storage is already being created — finishing up…')
        startTicker()
      }

      // Poll (up to 3 min) for the COMPLETE config to land in Firestore.
      const configDocRef = db.collection(configPath(uid)).doc('telegram')
      const deadline = Date.now() + 180000
      while (Date.now() < deadline) {
        const docSnap = await configDocRef.get({ source: 'server' }).catch(() => null)
        const d = docSnap && docSnap.exists ? docSnap.data() : null
        if (d && d.botToken && d.botUsername && d.channelId) {
          localStorage.removeItem(inflightKey)
          if (ticker) clearInterval(ticker)
          setStatusMessage('Your private storage is ready! Continuing…')
          navigate('/setup/ownership')
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 2500))
      }
      // Don't tell them to click again — that's what created duplicates. The
      // in-flight lock holds; refreshing will resume the wait.
      throw new Error(
        'This is taking longer than usual. Your setup is still finishing — please wait a moment, then refresh. Do NOT start over; that would create a duplicate.'
      )
    } catch (err) {
      console.error('Setup error:', err)
      setStatusMessage('')
      if (err.message.includes('Failed to fetch')) {
        setError('Could not reach the setup service. Check your connection and try again.')
      } else {
        setError(err.message || 'An unexpected error occurred.')
      }
    } finally {
      if (ticker) clearInterval(ticker)
      setIsLoading(false)
    }
  }

  const handleSaveManualSetup = async () => {
    if (!botToken.trim() || !channelId.trim()) {
      setError('Bot Token and Channel ID are required.')
      return
    }
    setIsLoading(true)
    setError('')
    try {
      const configDocRef = db
        .collection(configPath(auth.currentUser.uid))
        .doc('telegram')
      await configDocRef.set({
        botToken: botToken.trim(),
        channelId: channelId.trim(),
        setupTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
      })
      navigate('/setup/ownership')
    } catch (err) {
      setError(`Save failed: ${err.message}`)
    } finally {
      setIsLoading(false)
    }
  }

  // Real-time listener for setup completion (in case backend writes config).
  // Also doubles as a guard: if telegram is already set up when this page loads,
  // mark alreadyConfigured and route forward — never re-trigger /startSetup,
  // which would create a duplicate bot+channel.
  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    const unsubscribe = db
      .collection(configPath(uid))
      .doc('telegram')
      .onSnapshot((doc) => {
        setSnapshotReady(true)
        const data = doc.exists ? (doc.data() || {}) : null
        // ANY presence of botToken (even partial) means the bot exists and we
        // must NEVER call /startSetup again. A FRESH setup_started_at lock
        // (written by the server before the slow creation) counts too — during
        // the 30-90s creation window the doc has no botToken yet, and treating
        // that window as "nothing exists" armed the button for a second create.
        const startedAt = data?.setup_started_at?.toDate ? data.setup_started_at.toDate().getTime() : 0
        const lockFresh = !!startedAt && Date.now() - startedAt < 240000
        setDocExists(!!(data && (data.botToken || lockFresh)))
        const complete = !!(data && data.botToken && data.botUsername && data.channelId)
        if (!complete) return
        setAlreadyConfigured(true)
        const transferred = data.ownership_transferred || data.ownershipTransferred
        setStatusMessage('Setup complete! Redirecting...')
        setTimeout(() => navigate(transferred ? '/setup/worker' : '/setup/ownership'), 800)
      })
    return () => unsubscribe()
  }, [navigate])

  // Auto-resume: if a creation is already in flight (signup fired it, a
  // reload, or another tab), enter the waiting/polling flow instead of showing
  // an armed button — clicking that button during the creation window was the
  // main double-bot path. handleStartAutomatedSetup skips the POST when
  // in-flight and just polls for the finished config.
  const autoResumed = useRef(false)
  useEffect(() => {
    if (autoResumed.current || !snapshotReady || alreadyConfigured || isLoading) return
    const uid = auth.currentUser?.uid
    if (!uid) return
    const startedTs = parseInt(localStorage.getItem(`dc_setup_inflight_${uid}`) || '0', 10)
    const recentlyStarted = startedTs && Date.now() - startedTs < 240000
    if (docExists || recentlyStarted) {
      autoResumed.current = true
      handleStartAutomatedSetup()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotReady, docExists, alreadyConfigured, isLoading])

  const handleLogout = async () => {
    await auth.signOut()
    await destroySession()
    navigate('/login')
  }

  return (
    <DotGridPage>
      {/* Terminal bar at top */}
      <TerminalBar />

      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-[480px]"
        >
          <div className="text-center mb-7">
            <h1 className="text-[22px] font-semibold text-linear-text">
              DaemonClient Setup
            </h1>
            <p className="text-[13px] text-linear-text-secondary mt-1.5">
              Create your private, secure DaemonClient storage
            </p>
          </div>

          <div className="bg-[#111318] border border-white/[0.08] rounded-xl overflow-hidden shadow-xl shadow-black/40">
            <AnimatePresence mode="wait">
              {!showManualForm ? (
                <motion.div
                  key="options"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-5 space-y-3"
                >
                  {/* Automated setup */}
                  <div className="relative border border-linear-purple/30 bg-linear-purple/[0.04] rounded-lg p-5">
                    <span className="absolute -top-2.5 right-4 bg-linear-purple text-white text-[11px] font-medium px-2.5 py-0.5 rounded-full">
                      Recommended
                    </span>
                    <h2 className="text-[15px] font-semibold text-linear-text">
                      Automated Setup
                    </h2>
                    <p className="text-[13px] text-linear-text-secondary mt-1.5 leading-relaxed">
                      We create and configure a private bot and channel for you automatically.
                    </p>
                    <Button
                      onClick={handleStartAutomatedSetup}
                      disabled={isLoading || !!statusMessage || !snapshotReady}
                      className="w-full mt-4 h-9 text-[14px] font-medium"
                    >
                      {!snapshotReady ? (
                        <span className="flex items-center justify-center gap-2">
                          <Spinner size={14} className="text-white" />
                          Checking…
                        </span>
                      ) : isLoading ? (
                        <span className="flex items-center justify-center gap-2">
                          <Spinner size={14} className="text-white" />
                          Setting up...
                        </span>
                      ) : docExists && !alreadyConfigured ? (
                        'Resume Setup'
                      ) : (
                        'Create My Secure Storage'
                      )}
                    </Button>
                  </div>

                  {/* Manual setup */}
                  <div className="border border-white/[0.07] rounded-lg p-5">
                    <h2 className="text-[15px] font-semibold text-linear-text">
                      Manual Setup
                    </h2>
                    <p className="text-[13px] text-linear-text-secondary mt-1.5 leading-relaxed">
                      For advanced users with an existing bot and channel.
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => setShowManualForm(true)}
                      className="w-full mt-4 h-9 text-[13px]"
                    >
                      Enter Credentials Manually
                    </Button>
                  </div>

                  {/* Status / error */}
                  {statusMessage && (
                    <motion.div
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-3 bg-linear-purple/10 border border-linear-purple/20 rounded-lg flex items-center gap-3"
                    >
                      <Spinner size={15} />
                      <p className="text-[13px] text-linear-purple">{statusMessage}</p>
                    </motion.div>
                  )}
                  {error && !statusMessage && (
                    <p className="text-[13px] text-linear-error text-center">{error}</p>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="manual"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-5 space-y-4"
                >
                  <h2 className="text-[15px] font-semibold text-linear-text text-center">
                    Enter Your Credentials
                  </h2>
                  <div>
                    <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                      Telegram Bot Token
                    </label>
                    <Input
                      type="password"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder="From @BotFather"
                      className="w-full"
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] text-linear-text-secondary mb-1.5 font-medium">
                      Private Channel ID
                    </label>
                    <Input
                      type="text"
                      value={channelId}
                      onChange={(e) => setChannelId(e.target.value)}
                      placeholder="From @userinfobot"
                      className="w-full"
                    />
                  </div>
                  {error && <p className="text-[13px] text-linear-error">{error}</p>}
                  <Button onClick={handleSaveManualSetup} disabled={isLoading} className="w-full h-9 text-[14px] font-medium">
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Spinner size={14} className="text-white" />
                        Saving...
                      </span>
                    ) : (
                      'Save & Continue'
                    )}
                  </Button>
                  <button
                    onClick={() => setShowManualForm(false)}
                    className="w-full text-center text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors"
                  >
                    Back to setup options
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-5 text-center">
            <button
              onClick={handleLogout}
              className="text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors"
            >
              Sign out
            </button>
          </div>
        </motion.div>
      </div>
    </DotGridPage>
  )
}

// ============================================================================
// OWNERSHIP PAGE — Transfer bot/channel ownership
// ============================================================================

// ── Browser-driven bot responder ────────────────────────────────────────────
// A freshly-created per-user bot has NO update consumer, so when the user taps
// START it sits silent and they think it's broken ("the bot doesn't respond, I
// get stuck"). Fix it with ZERO server cost: while the user is on this page,
// THEIR OWN browser long-polls getUpdates for the bot (api.telegram.org sends
// Access-Control-Allow-Origin:*, so the cross-origin call is allowed), replies
// to /start with a friendly message, and watches for the channel-join via
// chat_member updates. Every signal is REAL — the wizard advances the instant
// the user actually does each step, instead of guessing with a blind countdown.
function useBotResponder(config, active) {
  const [botStarted, setBotStarted] = useState(false)
  const [channelJoined, setChannelJoined] = useState(false)
  const detectedUserRef = useRef(null)

  useEffect(() => {
    if (!active || !config?.botToken) return
    const token = config.botToken
    const channelId = config.channelId != null ? String(config.channelId) : null
    const ac = new AbortController()
    let stopped = false
    let offset = 0

    const api = (method, params) => {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      return fetch(`https://api.telegram.org/bot${token}/${method}${qs}`, { signal: ac.signal })
        .then((r) => r.json())
        .catch(() => null)
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const WELCOME =
      "✅ You're connected to DaemonClient!\n\n" +
      'This bot quietly stores your end-to-end encrypted photos in your own ' +
      'private channel — nobody else can read them. Head back to your browser ' +
      'to finish setup; just a few seconds left.'

    const loop = async () => {
      // A leftover webhook would block getUpdates with 409. Clearing it is a
      // no-op on a fresh bot and makes the poller robust either way.
      await api('deleteWebhook')
      while (!stopped) {
        const res = await api('getUpdates', {
          offset: String(offset),
          timeout: '25',
          allowed_updates: JSON.stringify(['message', 'chat_member', 'my_chat_member']),
        })
        if (stopped) break
        if (!res || !res.ok) { await wait(2000); continue } // 409/transient → back off
        for (const u of res.result || []) {
          offset = u.update_id + 1
          // Any first message from a human (the /start) → reply once + mark started.
          const msg = u.message
          if (msg && msg.from && !msg.from.is_bot) {
            if (!detectedUserRef.current) {
              detectedUserRef.current = { id: msg.from.id, username: msg.from.username || null }
            }
            if (typeof msg.text === 'string' && msg.text.trim().toLowerCase().startsWith('/start')) {
              await api('sendMessage', { chat_id: String(msg.chat.id), text: WELCOME })
            }
            setBotStarted(true)
          }
          // Channel join (best-effort: only delivered if the bot is a channel
          // admin; if it never arrives the UI falls back to the manual timer).
          const cm = u.chat_member || u.my_chat_member
          const m = cm?.new_chat_member
          if (cm && channelId && String(cm.chat?.id) === channelId && m && !m.user?.is_bot) {
            if (['member', 'administrator', 'creator', 'restricted'].includes(m.status)) {
              setChannelJoined(true)
            }
          }
        }
      }
    }
    loop()
    return () => { stopped = true; ac.abort() }
  }, [active, config?.botToken, config?.channelId])

  return { botStarted, channelJoined, detectedUser: detectedUserRef.current }
}

function OwnershipPage() {
  const navigate = useNavigate()
  const [config, setConfig] = useState(null)
  const [step, setStep] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [countdown, setCountdown] = useState(10)
  const [isButtonDisabled, setIsButtonDisabled] = useState(true)
  const [hasClickedLink, setHasClickedLink] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [transferStatus, setTransferStatus] = useState(null)

  // Live detection from the user's browser (zero server cost). Runs through
  // steps 1–2; stops on the finalizing screen.
  const { botStarted, channelJoined } = useBotResponder(config, !isLoading && !!config && step < 3)

  // Auto-advance the instant the bot actually responds — no more dead countdown.
  useEffect(() => {
    if (botStarted && step === 1) {
      const t = setTimeout(() => { setStep(2); setHasClickedLink(false) }, 1100)
      return () => clearTimeout(t)
    }
  }, [botStarted, step])

  // Fetch config. If telegram doc is missing or incomplete (half-written by a
  // failed /startSetup), bounce the user back to /setup so they can re-trigger
  // setup — instead of leaving them staring at a spinner with no @bot to open.
  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const configDocRef = db
          .collection(configPath(auth.currentUser.uid))
          .doc('telegram')
        const docSnap = await configDocRef.get()
        const data = docSnap.exists ? docSnap.data() : null
        const complete = !!(data && data.botToken && data.botUsername && data.channelId)
        if (!complete) {
          navigate('/setup', { replace: true })
          return
        }
        setConfig(data)
      } catch (err) {
        setError('Error fetching configuration: ' + err.message)
      } finally {
        setIsLoading(false)
      }
    }
    fetchConfig()
  }, [navigate])

  // Countdown timer
  useEffect(() => {
    if (isLoading) return
    setIsButtonDisabled(true)
    setCountdown(10)
    if (hasClickedLink) {
      const interval = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(interval)
            setIsButtonDisabled(false)
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(interval)
    }
  }, [step, hasClickedLink, isLoading])

  const handleLinkClicked = () => {
    if (!hasClickedLink) setHasClickedLink(true)
  }

  const handleNextStep = () => {
    setStep(2)
    setHasClickedLink(false)
  }

  const handleFinalize = async () => {
    setIsProcessing(true)
    setStep(3)
    setError('')
    setTransferStatus({
      bot: { status: 'pending', message: 'Verifying user and transferring bot ownership...' },
      channel: { status: 'pending', message: 'Attempting to transfer channel ownership...' },
    })
    try {
      const idToken = await auth.currentUser.getIdToken()
      const response = await fetch(`${RENDER_BACKEND}/finalizeTransfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ data: { uid: auth.currentUser.uid } }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(result.error?.message || 'Server returned an error.')
      }
      setTransferStatus({
        bot: { status: result.bot_transfer_status, message: result.bot_transfer_message },
        channel: { status: result.channel_transfer_status, message: result.channel_transfer_message },
      })

      // Log activity
      try {
        await db.collection(`${userPath(auth.currentUser.uid)}/activity`).add({
          type: 'setup_complete',
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          userAgent: navigator.userAgent,
        })
      } catch (e) {}

      toast.success('Ownership transferred! Setting up your backend...')

      // Deliberately NO navigate() here. The backend wrote
      // ownership_transferred=true; AuthOnly's live useSetupStage snapshot
      // flips the stage to 'worker' the moment the SERVER confirms it and
      // redirects automatically — the step-3 status panel stays visible until
      // then. Manually navigating raced that read and bounced users back to
      // step 1 of this page ("it just goes back").
    } catch (err) {
      setError(`Error: ${err.message}`)
      setStep(2)
      setIsProcessing(false)
      setHasClickedLink(false)
    }
  }

  const handleLogout = async () => {
    await auth.signOut()
    await destroySession()
    navigate('/login')
  }

  // Recovery for a corrupted setup (e.g. a duplicate bot/channel left the doc
  // pointing at a channel the user never joined → "could not find you").
  // Wipes the telegram config + in-flight lock so /setup can rebuild cleanly.
  const handleStartOver = async () => {
    try {
      const uid = auth.currentUser?.uid
      if (uid) {
        localStorage.removeItem(`dc_setup_inflight_${uid}`)
        await db.collection(configPath(uid)).doc('telegram').delete()
      }
    } catch (e) {
      console.warn('Start-over cleanup failed (continuing):', e)
    }
    navigate('/setup', { replace: true })
  }

  if (isLoading) {
    return <FullScreenSpinner message="Loading your bot and channel details..." />
  }

  const StatusItem = ({ status, message }) => {
    const icon =
      status === 'pending' ? (
        <Spinner size={18} />
      ) : status === 'success' ? (
        <div className="w-5 h-5 rounded-full bg-linear-success/20 flex items-center justify-center">
          <Check size={12} className="text-linear-success" />
        </div>
      ) : (
        <div className="w-5 h-5 rounded-full bg-linear-error/20 flex items-center justify-center">
          <X size={12} className="text-linear-error" />
        </div>
      )
    const textColor =
      status === 'success'
        ? 'text-linear-success'
        : status === 'failed'
        ? 'text-linear-error'
        : 'text-linear-text-secondary'

    return (
      <li className="flex items-start gap-3 py-2">
        <div className="shrink-0 mt-0.5">{icon}</div>
        <p className={`text-[13px] ${textColor}`}>{message}</p>
      </li>
    )
  }

  return (
    <DotGridPage>
      <TerminalBar />
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-[440px]"
        >
          {/* Step indicator */}
          <div className="flex items-center justify-center gap-2 mb-6">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className={`h-1.5 rounded-full transition-all ${
                  n === 2
                    ? 'w-6 bg-daemon-green'
                    : n < 2
                    ? 'w-4 bg-daemon-green/40'
                    : 'w-4 bg-white/[0.12]'
                }`}
              />
            ))}
          </div>

          <div className="bg-[#111318] border border-white/[0.08] rounded-xl overflow-hidden shadow-xl shadow-black/40">
            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-6 space-y-5 text-center"
                >
                  <div>
                    <p className="text-[11px] font-semibold text-linear-purple uppercase tracking-widest mb-2">
                      Step 1 of 2
                    </p>
                    <h1 className="text-[20px] font-semibold text-linear-text">
                      Start Your Bot
                    </h1>
                    <p className="text-[13px] text-linear-text-secondary mt-2 leading-relaxed">
                      Click the link below, press <strong className="text-linear-text">START</strong> in Telegram, then come back here.
                    </p>
                  </div>

                  <a
                    href={config ? `https://t.me/${config.botUsername}` : '#'}
                    target="dc-telegram"
                    rel="noopener noreferrer"
                    onClick={handleLinkClicked}
                    className="inline-flex items-center gap-2 bg-[#2AABEE] hover:bg-[#229ED9] text-white text-[13px] font-semibold px-6 py-2.5 rounded-lg transition-colors"
                  >
                    {config?.botUsername ? (
                      <>
                        Open @{config.botUsername}
                        <ExternalLink size={13} />
                      </>
                    ) : (
                      <Spinner size={14} className="text-white" />
                    )}
                  </a>

                  {botStarted ? (
                    <div className="flex items-center justify-center gap-2 text-[13px] text-daemon-green font-medium">
                      <Check size={15} /> Bot connected — continuing…
                    </div>
                  ) : hasClickedLink ? (
                    <div className="flex items-center justify-center gap-2 text-[12px] text-linear-text-secondary">
                      <Spinner size={13} /> Waiting for the bot to start…
                    </div>
                  ) : null}

                  <Button onClick={handleNextStep} disabled={!botStarted && isButtonDisabled} className="w-full h-9 text-[14px] font-medium">
                    {botStarted ? 'Continue →' : isButtonDisabled && hasClickedLink ? `Skip ahead (${countdown}s)` : 'Next Step →'}
                  </Button>
                </motion.div>
              )}

              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-6 space-y-5 text-center"
                >
                  <div>
                    <p className="text-[11px] font-semibold text-linear-purple uppercase tracking-widest mb-2">
                      Step 2 of 2
                    </p>
                    <h1 className="text-[20px] font-semibold text-linear-text">
                      Join Your Channel
                    </h1>
                    <p className="text-[13px] text-linear-text-secondary mt-2 leading-relaxed">
                      Click the link to join your secure storage channel, then finalize the transfer.
                    </p>
                  </div>

                  <a
                    href={config ? config.invite_link : '#'}
                    target="dc-telegram"
                    rel="noopener noreferrer"
                    onClick={handleLinkClicked}
                    className="inline-flex items-center gap-2 bg-[#2AABEE] hover:bg-[#229ED9] text-white text-[13px] font-semibold px-6 py-2.5 rounded-lg transition-colors"
                  >
                    Join Secure Channel
                    <ExternalLink size={13} />
                  </a>

                  {channelJoined ? (
                    <div className="flex items-center justify-center gap-2 text-[13px] text-daemon-green font-medium">
                      <Check size={15} /> Channel joined — ready to finalize!
                    </div>
                  ) : hasClickedLink ? (
                    <div className="flex items-center justify-center gap-2 text-[12px] text-linear-text-secondary">
                      <Spinner size={13} /> Waiting for you to join the channel…
                    </div>
                  ) : null}

                  <Button onClick={handleFinalize} disabled={!channelJoined && isButtonDisabled} className="w-full h-9 text-[14px] font-medium">
                    {!channelJoined && isButtonDisabled && hasClickedLink ? `Finalize (${countdown}s)` : 'Finalize Transfer'}
                  </Button>
                </motion.div>
              )}

              {step === 3 && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="p-6"
                >
                  <h1 className="text-[18px] font-semibold text-linear-text text-center mb-5">
                    Finalizing Setup...
                  </h1>
                  <div className="space-y-1 bg-linear-bg/60 rounded-lg p-4">
                    {transferStatus && (
                      <>
                        <StatusItem status={transferStatus.bot.status} message={transferStatus.bot.message} />
                        <StatusItem status={transferStatus.channel.status} message={transferStatus.channel.message} />
                      </>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {error && (
              <div className="px-6 pb-5 text-center">
                <p className="text-[13px] text-linear-error mb-3">{error}</p>
                {/* Recovery: if the bot/channel got into a bad state (e.g. a
                    duplicate left the config pointing at a channel you never
                    joined), wipe it and rebuild cleanly. */}
                <button
                  onClick={handleStartOver}
                  className="text-[12px] text-linear-text-secondary hover:text-linear-text underline underline-offset-2 transition-colors"
                >
                  Still stuck? Start setup over
                </button>
              </div>
            )}
          </div>

          <div className="mt-5 text-center">
            <button
              onClick={handleLogout}
              className="text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors"
            >
              Sign out
            </button>
          </div>
        </motion.div>
      </div>
    </DotGridPage>
  )
}

// ============================================================================
// DASHBOARD PAGE
// ============================================================================

// ── iCloud-style gradient background presets ──────────────────────────────────
const BG_PRESETS = [
  {
    id: 'ocean',
    name: 'Ocean',
    swatch: ['#0A1628', '#1A4AAF'],
    bg: 'linear-gradient(160deg, #050D22 0%, #0C1E50 42%, #1A4AAF 72%, #091840 100%)',
    shapes: [
      { color: 'rgba(18,56,168,0.52)', clip: 'polygon(0 0, 78% 0, 58% 100%, 0 68%)' },
      { color: 'rgba(8,30,110,0.38)', clip: 'polygon(32% 100%, 100% 28%, 100% 100%)' },
      { color: 'rgba(26,74,200,0.20)', clip: 'polygon(58% 0, 100% 0, 100% 58%, 68% 100%, 38% 100%)' },
    ],
  },
  {
    id: 'space',
    name: 'Space',
    swatch: ['#080818', '#201C70'],
    bg: 'linear-gradient(160deg, #06060F 0%, #101038 42%, #201C70 72%, #080818 100%)',
    shapes: [
      { color: 'rgba(44,36,155,0.42)', clip: 'polygon(0 0, 78% 0, 58% 100%, 0 68%)' },
      { color: 'rgba(22,18,105,0.30)', clip: 'polygon(32% 100%, 100% 28%, 100% 100%)' },
      { color: 'rgba(58,48,195,0.18)', clip: 'polygon(58% 0, 100% 0, 100% 58%, 68% 100%, 38% 100%)' },
    ],
  },
  {
    id: 'aurora',
    name: 'Aurora',
    swatch: ['#061208', '#12602C'],
    bg: 'linear-gradient(160deg, #040A05 0%, #0A2410 42%, #125828 72%, #071508 100%)',
    shapes: [
      { color: 'rgba(14,105,42,0.46)', clip: 'polygon(0 0, 78% 0, 58% 100%, 0 68%)' },
      { color: 'rgba(7,62,22,0.33)', clip: 'polygon(32% 100%, 100% 28%, 100% 100%)' },
    ],
  },
  {
    id: 'nebula',
    name: 'Nebula',
    swatch: ['#100620', '#601065'],
    bg: 'linear-gradient(160deg, #090410 0%, #200830 42%, #601065 72%, #180522 100%)',
    shapes: [
      { color: 'rgba(105,18,135,0.44)', clip: 'polygon(0 0, 78% 0, 58% 100%, 0 68%)' },
      { color: 'rgba(62,10,95,0.33)', clip: 'polygon(32% 100%, 100% 28%, 100% 100%)' },
    ],
  },
  {
    id: 'midnight',
    name: 'Midnight',
    swatch: ['#0B0C10', '#1A1C2E'],
    bg: 'linear-gradient(160deg, #090A0D 0%, #111220 42%, #1A1C2E 72%, #0C0D12 100%)',
    shapes: [
      { color: 'rgba(50,55,105,0.20)', clip: 'polygon(0 0, 78% 0, 58% 100%, 0 68%)' },
      { color: 'rgba(30,33,72,0.16)', clip: 'polygon(32% 100%, 100% 28%, 100% 100%)' },
    ],
  },
]

function DashboardBackground({ preset }) {
  const bg = BG_PRESETS.find(p => p.id === preset) || BG_PRESETS[0]
  const [c1, c2] = bg.swatch
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden" style={{ background: bg.bg }}>
      {/* Soft aurora blobs — the premium atmosphere (replaces flat clip shapes) */}
      <div
        className="absolute -top-[20%] -left-[12%] w-[62vw] h-[62vw] rounded-full blur-[130px] opacity-[0.55]"
        style={{ background: `radial-gradient(circle, ${c2}, transparent 70%)` }}
      />
      <div
        className="absolute top-[28%] -right-[8%] w-[48vw] h-[48vw] rounded-full blur-[130px] opacity-40"
        style={{ background: `radial-gradient(circle, ${c1}, transparent 70%)` }}
      />
      {/* Faint geometric facets from the preset, dialed way back */}
      {bg.shapes.map((s, i) => (
        <div key={i} className="absolute inset-0 opacity-[0.35]" style={{ background: s.color, clipPath: s.clip }} />
      ))}
      {/* Top sheen + bottom vignette → depth */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 80% at 50% -10%, rgba(255,255,255,0.07), transparent 58%)' }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(100% 100% at 50% 118%, rgba(0,0,0,0.55), transparent 52%)' }} />
      {/* Fine film grain */}
      <div className="absolute inset-0 grain-overlay opacity-[0.05] mix-blend-overlay" />
    </div>
  )
}

// ── file type badge (iCloud Drive style) ─────────────────────────────────────
function FileBadge({ type }) {
  const MAP = {
    PDF:  '#5A1A1A', ZIP: '#1A2D45', MP4: '#2D1A45',
    MOV:  '#2D1A45', XLS: '#1A3020', XLSX:'#1A3020',
    FIG:  '#3A1A30', PNG: '#3A2E10', JPG: '#3A2E10',
    JPEG: '#3A2E10', TXT: '#22262E', DOC: '#1A2545',
  }
  const bg = MAP[type?.toUpperCase()] || '#22262E'
  return (
    <div className="w-9 h-[42px] rounded-[6px] flex items-center justify-center shrink-0 text-white/70 font-bold text-[8px] tracking-wide border border-white/[0.06]" style={{ background: bg }}>
      {(type || '???').slice(0, 4).toUpperCase()}
    </div>
  )
}

// Subtle fallback tints for empty photo slots (real previews use thumbhash).
const PHOTO_GRADIENTS = [
  'linear-gradient(140deg,#1A2B4A,#263866)',
  'linear-gradient(140deg,#1B3020,#263D28)',
  'linear-gradient(140deg,#2B1A28,#3D2535)',
  'linear-gradient(140deg,#1A1B2B,#262740)',
]

function DashboardPage() {
  const [services, setServices] = useState({ photos: null, drive: null })
  const [backend, setBackend] = useState(null)
  const [summary, setSummary] = useState(null) // real { photos:{count,recent}, drive:{count,recent} }
  const [loading, setLoading] = useState(true)
  const [bgPreset, setBgPreset] = useState(
    () => localStorage.getItem('dc-bg-preset') || 'ocean'
  )

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    const uid = user.uid
    const unsubs = []
    unsubs.push(db.doc(`${userPath(uid)}/services/photos`).onSnapshot(doc => {
      if (doc.exists) setServices(p => ({ ...p, photos: doc.data() }))
      setLoading(false)
    }))
    unsubs.push(db.doc(`${userPath(uid)}/services/drive`).onSnapshot(doc => {
      if (doc.exists) setServices(p => ({ ...p, drive: doc.data() }))
      setLoading(false)
    }))
    unsubs.push(db.doc(`${configPath(uid)}/cloudflare`).onSnapshot(doc => {
      if (doc.exists) setBackend(doc.data())
    }))
    const t = setTimeout(() => setLoading(false), 3000)
    return () => { unsubs.forEach(u => u()); clearTimeout(t) }
  }, [])

  // Pull REAL counts + recent items from the user's own worker once we know its
  // URL. Fires a fire-and-forget auto-update first so workers provisioned before
  // /api/dashboard/summary (and the accounts CORS origin) self-heal; then polls
  // a few times to catch the redeploy. Stays silent on failure — the cards just
  // show an honest empty state, never mock data.
  useEffect(() => {
    const workerUrl = backend?.workerUrl
    if (!workerUrl) return
    let cancelled = false
    const base = workerUrl.replace(/\/$/, '')
    ;(async () => {
      const user = auth.currentUser
      if (!user) return
      const idToken = await user.getIdToken().catch(() => null)
      if (!idToken) return

      // One GET to the user's own worker. Returns the real shape ({photos,drive})
      // when the worker has the endpoint; an older worker routes unknown paths to
      // a catch-all that returns {} (200) — treated as "not ready".
      const fetchSummary = async () => {
        try {
          const res = await fetch(`${base}/api/dashboard/summary`, {
            headers: { Authorization: `Bearer ${idToken}` },
          })
          if (res.ok) {
            const d = await res.json().catch(() => null)
            if (d && d.photos && d.drive) return d
          }
        } catch { /* offline / cold start */ }
        return null
      }

      // STEADY STATE: worker already current → exactly one fetch, no update call.
      let data = await fetchSummary()

      // Only a stale worker (missing the endpoint) reaches here → self-heal it
      // ONCE by nudging auto-update, then briefly poll. Happens at most once per
      // worker, never on subsequent dashboard opens.
      if (!data && !cancelled) {
        fetch(`${DEPLOYMENT_WORKER}/auto-update`, {
          method: 'POST', headers: { Authorization: `Bearer ${idToken}` },
        }).catch(() => {})
        for (let i = 0; i < 5 && !data && !cancelled; i++) {
          await new Promise((r) => setTimeout(r, 2500))
          data = await fetchSummary()
        }
      }
      if (data && !cancelled) setSummary(data)
    })()
    return () => { cancelled = true }
  }, [backend?.workerUrl])

  // Real data with safe fallbacks. driveFiles/photoTiles drive the cards below.
  const driveCount = summary?.drive?.count ?? services.drive?.totalFiles ?? 0
  const photoCount = summary?.photos?.count ?? services.photos?.totalAssets ?? 0
  const driveFiles = (summary?.drive?.recent || []).slice(0, 6).map(f => ({ name: f.fileName, type: f.ext || 'FILE' }))
  const photoTiles = (summary?.photos?.recent || []).slice(0, 4)

  const handleBgPreset = id => { setBgPreset(id); localStorage.setItem('dc-bg-preset', id) }
  const copyToClipboard = (text, label) =>
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`), () => toast.error('Copy failed'))

  const user = auth.currentUser
  const displayName = user?.displayName || user?.email?.split('@')[0] || 'User'
  const initials = displayName.charAt(0).toUpperCase()
  const avatarColorIndex = user?.uid ? parseInt(user.uid.slice(0, 6), 16) % AVATAR_COLORS.length : 0
  const avatarBg = AVATAR_COLORS[avatarColorIndex]

  const apps = [
    { label: 'Drive',   href: 'https://app.daemonclient.uz',    bg: 'linear-gradient(145deg,#1A3B90,#2D5DC8)', icon: <FolderOpen size={27} className="text-white" strokeWidth={1.5}/> },
    { label: 'Photos',  href: 'https://photos.daemonclient.uz', bg: 'linear-gradient(145deg,#0A4520,#15803D)', icon: <Image      size={27} className="text-green-300" strokeWidth={1.5}/> },
    { label: 'Hosting', disabled: true, bg: 'linear-gradient(145deg,#1A0A30,#2D1550)', icon: <Server  size={27} className="text-purple-400" strokeWidth={1.5}/> },
    { label: 'Movies',  disabled: true, bg: 'linear-gradient(145deg,#300808,#501212)', icon: <Monitor size={27} className="text-red-400"    strokeWidth={1.5}/> },
    { label: 'API',     disabled: true, bg: 'linear-gradient(145deg,#082028,#103040)', icon: <Hash    size={27} className="text-cyan-400"   strokeWidth={1.5}/> },
    { label: 'Notes',   disabled: true, bg: 'linear-gradient(145deg,#1A1400,#2A2000)', icon: <Clock   size={27} className="text-yellow-500" strokeWidth={1.5}/> },
  ]

  return (
    <>
      <DashboardBackground preset={bgPreset} />

      <div className="min-h-screen">
        {loading ? (
          <div className="flex items-center justify-center min-h-screen">
            <Spinner size={28} className="text-white" />
          </div>
        ) : (
          <>
            {/* ── blue section ── */}
            <div className="px-4 sm:px-8 lg:px-12 pt-5 pb-5">
              <div className="max-w-[1020px] mx-auto space-y-4">

                {/* Row 1: Profile card + App grid */}
                <div className="flex flex-col md:flex-row gap-4">

                  {/* Profile card — clickable → /profile */}
                  <Link
                    to="/profile"
                    className="md:w-[248px] shrink-0 bg-white/[0.07] hover:bg-white/[0.11] backdrop-blur-2xl border border-white/[0.1] hover:border-white/[0.2] rounded-3xl p-6 transition-all duration-300 group shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]"
                  >
                    <div
                      className="w-[70px] h-[70px] rounded-full flex items-center justify-center text-white text-2xl font-bold mb-5 shadow-lg ring-2 ring-white/10 group-hover:ring-white/25 transition-all duration-200"
                      style={{ background: avatarBg }}
                    >
                      {initials}
                    </div>
                    <h2 className="font-display text-[22px] font-bold text-white leading-tight mb-0.5 truncate">{displayName}</h2>
                    <p className="text-[12px] text-white/45 mb-4 truncate">{user?.email}</p>
                    <div className="flex items-center gap-2">
                      <img src="/logo.png" className="w-4 h-4 object-contain opacity-75" alt="" />
                      <span className="text-[12px] font-semibold text-white/60">DaemonClient</span>
                    </div>
                    <div className="mt-4 text-[11px] text-white/30 group-hover:text-white/50 transition-colors flex items-center gap-1">
                      Manage profile <ChevronRight size={11}/>
                    </div>
                  </Link>

                  {/* App grid — clickable card header routes to /dashboard */}
                  <div className="flex-1 bg-white/[0.07] backdrop-blur-2xl border border-white/[0.1] rounded-3xl p-5 sm:p-6 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
                    <p className="text-[11px] text-white/30 font-medium uppercase tracking-widest mb-4">Services</p>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-4 sm:gap-5">
                      {apps.map(app =>
                        app.disabled ? (
                          <div key={app.label} className="flex flex-col items-center gap-2">
                            <div className="w-[58px] h-[58px] sm:w-[62px] sm:h-[62px] rounded-[14px] flex items-center justify-center opacity-20" style={{ background: app.bg }}>
                              {app.icon}
                            </div>
                            <span className="text-[11px] text-white/20 font-medium text-center">{app.label}</span>
                          </div>
                        ) : (
                          <a key={app.label} href={app.href} className="flex flex-col items-center gap-2 group">
                            <div className="w-[58px] h-[58px] sm:w-[62px] sm:h-[62px] rounded-[14px] flex items-center justify-center group-hover:scale-[1.07] transition-transform duration-150 shadow-lg" style={{ background: app.bg }}>
                              {app.icon}
                            </div>
                            <span className="text-[11px] text-white/80 font-medium text-center">{app.label}</span>
                          </a>
                        )
                      )}
                    </div>
                  </div>
                </div>

                {/* Row 2: Drive + Photos — iCloud widget style */}
                <div className="grid grid-cols-1 md:grid-cols-[3fr_2fr] gap-4">

                  {/* ── Drive card ── */}
                  <div className="bg-white/[0.07] backdrop-blur-2xl border border-white/[0.1] rounded-3xl overflow-hidden flex flex-col shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
                    {/* header */}
                    <div className="flex items-center gap-3 px-5 py-4 bg-white/[0.04]">
                      <div className="w-11 h-11 rounded-[12px] flex items-center justify-center shadow-lg" style={{ background: 'linear-gradient(145deg,#1A3B90,#2D5DC8)' }}>
                        <FolderOpen size={20} className="text-white" strokeWidth={1.5}/>
                      </div>
                      <div>
                        <p className="font-display text-[18px] font-bold text-white">Drive</p>
                        <p className="text-[11px] text-blue-300/70 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block"/>
                          Recents · {driveCount} {driveCount === 1 ? 'file' : 'files'}
                        </p>
                      </div>
                    </div>

                    {/* file list — real recents, 2 cols; honest empty state */}
                    {driveFiles.length === 0 ? (
                      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-10 bg-black/20 min-h-[150px]">
                        <FolderOpen size={26} className="text-white/15" strokeWidth={1.5}/>
                        <p className="text-[12px] text-white/30">No files yet</p>
                        <a href="https://drive.daemonclient.uz" className="text-[11px] text-blue-300/70 hover:text-blue-300">Upload to Drive →</a>
                      </div>
                    ) : (
                      <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.06] bg-black/20">
                        {[driveFiles.slice(0, 3), driveFiles.slice(3, 6)].map((col, ci) => (
                          <div key={ci} className="divide-y divide-white/[0.05]">
                            {col.map((f, fi) => (
                              <a
                                key={`${f.name}-${fi}`}
                                href="https://drive.daemonclient.uz"
                                className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.05] transition-colors group"
                              >
                                <FileBadge type={f.type}/>
                                <div className="min-w-0">
                                  <p className="text-[13px] text-white font-medium truncate group-hover:text-white">{f.name}</p>
                                  <p className="text-[11px] text-white/35">{f.type}</p>
                                </div>
                              </a>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* footer */}
                    <div className="px-4 py-2.5 border-t border-white/[0.06] flex items-center justify-between">
                      <span className="text-white/25 text-[18px] leading-none tracking-[3px]">···</span>
                      <a href="https://app.daemonclient.uz" className="text-[11px] text-white/30 hover:text-white/60 transition-colors">
                        Open Drive →
                      </a>
                    </div>
                  </div>

                  {/* ── Photos card ── */}
                  <div className="bg-white/[0.07] backdrop-blur-2xl border border-white/[0.1] rounded-3xl overflow-hidden flex flex-col shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
                    {/* header */}
                    <div className="flex items-center gap-3 px-5 py-4 bg-white/[0.04]">
                      <div className="w-11 h-11 rounded-[12px] flex items-center justify-center shadow-lg" style={{ background: 'linear-gradient(145deg,#0A4520,#15803D)' }}>
                        <Image size={20} className="text-green-300" strokeWidth={1.5}/>
                      </div>
                      <div>
                        <p className="font-display text-[18px] font-bold text-white">Photos</p>
                        <p className="text-[11px] text-green-400/70 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block"/>
                          Library · {photoCount} {photoCount === 1 ? 'Photo' : 'Photos'}
                        </p>
                      </div>
                    </div>

                    {/* 2×2 grid — real recent photos via thumbhash previews */}
                    <a href="https://photos.daemonclient.uz" className="flex-1 grid grid-cols-2 grid-rows-2 gap-px bg-white/[0.04] min-h-[160px]">
                      {[0, 1, 2, 3].map((i) => {
                        const tile = photoTiles[i]
                        const url = tile ? thumbhashToUrl(tile.thumbhash) : null
                        return (
                          <div
                            key={i}
                            className="relative flex items-center justify-center overflow-hidden hover:brightness-110 transition-all duration-200"
                            style={{ background: url ? undefined : PHOTO_GRADIENTS[i] }}
                          >
                            {url ? (
                              <img src={url} alt="" className="absolute inset-0 w-full h-full object-cover" />
                            ) : (
                              <Image size={22} className="text-white/10"/>
                            )}
                            {tile?.isVideo && (
                              <div className="absolute bottom-1.5 right-1.5 w-5 h-5 rounded-full bg-black/50 flex items-center justify-center">
                                <Monitor size={11} className="text-white/80"/>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </a>

                    {/* footer */}
                    <div className="px-4 py-2.5 border-t border-white/[0.06] flex items-center justify-between">
                      <span className="text-white/25 text-[18px] leading-none tracking-[3px]">···</span>
                      <a href="https://photos.daemonclient.uz" className="text-[11px] text-white/30 hover:text-white/60 transition-colors">
                        Open Photos →
                      </a>
                    </div>
                  </div>
                </div>

                {/* Theme picker */}
                <div className="flex justify-center pb-1">
                  <div className="inline-flex items-center gap-3 bg-black/30 backdrop-blur-xl border border-white/[0.08] rounded-full px-5 py-2.5">
                    <Palette size={13} className="text-white/35"/>
                    <span className="text-[11px] text-white/35 font-medium">Theme</span>
                    <div className="flex gap-2">
                      {BG_PRESETS.map(p => (
                        <button
                          key={p.id}
                          onClick={() => handleBgPreset(p.id)}
                          title={p.name}
                          className={`w-5 h-5 rounded-full border-2 transition-all duration-150 ${bgPreset === p.id ? 'border-white scale-125' : 'border-white/20 hover:border-white/50'}`}
                          style={{ background: `linear-gradient(135deg,${p.swatch[0]},${p.swatch[1]})` }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── dark bottom section ── */}
            <div className="bg-black/50 backdrop-blur-sm border-t border-white/[0.06]">
              <div className="max-w-[1020px] mx-auto px-4 sm:px-8 lg:px-12 py-10 grid grid-cols-1 sm:grid-cols-3 gap-8">
                {/* Plan */}
                <div>
                  <p className="font-display text-[19px] font-bold text-white mb-3 flex items-center gap-1">
                    Your Plan <ChevronRight size={16} className="text-white/30 mt-0.5" />
                  </p>
                  <div className="flex items-center gap-2 mb-2">
                    <img src="/logo.png" className="w-5 h-5 object-contain" alt="" />
                    <span className="text-[14px] font-semibold text-white">Unlimited</span>
                  </div>
                  <p className="font-display text-[28px] font-bold text-white mb-1 tracking-tight">∞ Storage</p>
                  <p className="text-[12px] text-white/35">Free, powered by Telegram</p>
                </div>

                {/* Backend */}
                <div>
                  <p className="font-display text-[19px] font-bold text-white mb-3 flex items-center gap-1">
                    Your Backend <ChevronRight size={16} className="text-white/30 mt-0.5" />
                  </p>
                  {backend?.workerUrl ? (
                    <>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-daemon-green" />
                        <span className="text-[14px] font-semibold text-white">Active</span>
                      </div>
                      <p className="font-mono text-[11px] text-white/40 mb-2 truncate">{backend.workerUrl}</p>
                      <button onClick={() => copyToClipboard(backend.workerUrl, 'Worker URL')} className="text-[11px] text-white/35 hover:text-white/60 transition-colors flex items-center gap-1">
                        <Copy size={11} /> Copy URL
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-yellow-400" />
                        <span className="text-[14px] font-semibold text-white/60">Not configured</span>
                      </div>
                      <Link to="/setup-worker" className="text-[12px] text-daemon-green hover:underline">
                        Set up your backend →
                      </Link>
                    </>
                  )}
                </div>

                {/* Account links */}
                <div>
                  <p className="font-display text-[19px] font-bold text-white mb-3 flex items-center gap-1">
                    Account <ChevronRight size={16} className="text-white/30 mt-0.5" />
                  </p>
                  <div className="space-y-3">
                    <Link to="/profile" className="flex items-center gap-2 text-[13px] text-white/50 hover:text-white transition-colors">
                      <User size={13} /> Profile Settings
                    </Link>
                    <Link to="/security" className="flex items-center gap-2 text-[13px] text-white/50 hover:text-white transition-colors">
                      <Shield size={13} /> Security
                    </Link>
                  </div>
                </div>
              </div>

              {/* Footer bar */}
              <div className="border-t border-white/[0.04] px-4 sm:px-8 lg:px-12 py-4">
                <div className="max-w-[1020px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-white/20">
                  <div className="flex gap-5">
                    <a href="https://daemonclient.uz/help" className="hover:text-white/40 transition-colors">Help</a>
                    <a href="https://daemonclient.uz/terms" className="hover:text-white/40 transition-colors">Terms & Conditions</a>
                    <a href="https://daemonclient.uz/privacy" className="hover:text-white/40 transition-colors">Privacy Policy</a>
                  </div>
                  <span>© 2026 DaemonClient · All rights reserved</span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

// ============================================================================
// PROFILE PAGE
// ============================================================================

function ProfilePage() {
  const user = auth.currentUser
  const [displayName, setDisplayName] = useState(user?.displayName || '')
  const [avatarColor, setAvatarColor] = useState(AVATAR_COLORS[4])
  const [saving, setSaving] = useState(false)
  const [profileLoaded, setProfileLoaded] = useState(false)

  // Load profile from Firestore
  useEffect(() => {
    if (!user) return
    const docRef = db.doc(`${userPath(user.uid)}/profile/settings`)
    const unsubscribe = docRef.onSnapshot((doc) => {
      if (doc.exists) {
        const data = doc.data()
        if (data.displayName) setDisplayName(data.displayName)
        if (data.avatarColor) setAvatarColor(data.avatarColor)
      }
      setProfileLoaded(true)
    })
    return () => unsubscribe()
  }, [user])

  const handleSave = async () => {
    if (!user) return
    setSaving(true)
    try {
      // Update Firebase Auth displayName
      await user.updateProfile({ displayName: displayName.trim() || null })

      // Save to Firestore
      await db.doc(`${userPath(user.uid)}/profile/settings`).set(
        {
          displayName: displayName.trim(),
          avatarColor,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      )
      toast.success('Profile updated')
    } catch (err) {
      toast.error('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const initials = displayName
    ? displayName.charAt(0).toUpperCase()
    : user?.email?.charAt(0).toUpperCase() || '?'

  if (!profileLoaded) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner size={24} />
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
          Profile
        </h1>
        <p className="text-[13px] text-linear-text-secondary mt-1">
          Manage your account settings
        </p>
      </div>

      <Card className="p-6 space-y-6">
        {/* Avatar preview */}
        <div className="flex items-center gap-4">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center shrink-0 transition-colors"
            style={{ backgroundColor: avatarColor }}
          >
            <span className="text-white text-2xl font-semibold">{initials}</span>
          </div>
          <div>
            <p className="text-[15px] font-medium text-linear-text">
              {displayName || user?.email?.split('@')[0]}
            </p>
            <p className="text-[13px] text-linear-text-secondary">{user?.email}</p>
          </div>
        </div>

        {/* Display name */}
        <div>
          <label className="block text-[13px] text-linear-text-secondary mb-1.5">
            Display name
          </label>
          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            className="w-full max-w-xs"
          />
        </div>

        {/* Email (read-only) */}
        <div>
          <label className="block text-[13px] text-linear-text-secondary mb-1.5">
            Email
          </label>
          <div className="h-8 px-3 bg-[#27272A]/50 border border-white/[0.06] rounded-md text-[13px] text-linear-text-secondary flex items-center max-w-xs">
            {user?.email}
          </div>
        </div>

        {/* Avatar color picker */}
        <div>
          <label className="flex items-center gap-1.5 text-[13px] text-linear-text-secondary mb-3">
            <Palette size={13} />
            Avatar color
          </label>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                onClick={() => setAvatarColor(color)}
                className={`w-7 h-7 rounded-full transition-all ${
                  avatarColor === color
                    ? 'ring-2 ring-white ring-offset-2 ring-offset-linear-surface scale-110'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        {/* Save button */}
        <div className="pt-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <span className="flex items-center gap-2">
                <Spinner size={14} className="text-white" />
                Saving...
              </span>
            ) : (
              'Save changes'
            )}
          </Button>
        </div>
      </Card>
    </div>
  )
}

// ============================================================================
// SECURITY PAGE
// ============================================================================

function SecurityPage() {
  const user = auth.currentUser
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [activityLog, setActivityLog] = useState([])
  const [loadingActivity, setLoadingActivity] = useState(true)

  // Load activity log
  useEffect(() => {
    if (!user) return
    const unsubscribe = db
      .collection(`${userPath(user.uid)}/activity`)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .onSnapshot(
        (snapshot) => {
          const entries = []
          snapshot.forEach((doc) => {
            entries.push({ id: doc.id, ...doc.data() })
          })
          setActivityLog(entries)
          setLoadingActivity(false)
        },
        () => setLoadingActivity(false)
      )
    return () => unsubscribe()
  }, [user])

  const handleChangePassword = async (e) => {
    e.preventDefault()
    setPasswordError('')

    if (newPassword !== confirmNewPassword) {
      setPasswordError('New passwords do not match')
      return
    }
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters')
      return
    }

    setChangingPassword(true)
    try {
      // Re-authenticate first
      const credential = firebase.auth.EmailAuthProvider.credential(
        user.email,
        currentPassword
      )
      await user.reauthenticateWithCredential(credential)
      await user.updatePassword(newPassword)

      // Log the activity
      try {
        await db.collection(`${userPath(user.uid)}/activity`).add({
          type: 'password_change',
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
          userAgent: navigator.userAgent,
          ip: 'client',
        })
      } catch (e) {}

      toast.success('Password updated successfully')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
    } catch (err) {
      const msg =
        err.code === 'auth/wrong-password'
          ? 'Current password is incorrect'
          : err.code === 'auth/requires-recent-login'
          ? 'Please sign out and sign back in, then try again'
          : err.message || 'Failed to change password'
      setPasswordError(msg)
    } finally {
      setChangingPassword(false)
    }
  }

  const getActivityIcon = (type) => {
    switch (type) {
      case 'login':
        return <Globe size={14} className="text-linear-purple" />
      case 'signup':
        return <User size={14} className="text-linear-success" />
      case 'password_change':
        return <Lock size={14} className="text-yellow-500" />
      case 'setup_complete':
        return <Check size={14} className="text-linear-success" />
      default:
        return <Clock size={14} className="text-linear-text-secondary" />
    }
  }

  const getActivityLabel = (type) => {
    switch (type) {
      case 'login':
        return 'Sign in'
      case 'signup':
        return 'Account created'
      case 'password_change':
        return 'Password changed'
      case 'setup_complete':
        return 'Setup completed'
      default:
        return type
    }
  }

  const formatTimestamp = (ts) => {
    if (!ts) return 'Just now'
    try {
      const date = ts.toDate ? ts.toDate() : new Date(ts)
      return date.toLocaleString()
    } catch {
      return 'Unknown'
    }
  }

  const parseUserAgent = (ua) => {
    if (!ua) return 'Unknown device'
    if (ua.includes('Mobile')) return 'Mobile browser'
    if (ua.includes('Chrome')) return 'Chrome'
    if (ua.includes('Firefox')) return 'Firefox'
    if (ua.includes('Safari')) return 'Safari'
    return 'Browser'
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
          Security
        </h1>
        <p className="text-[13px] text-linear-text-secondary mt-1">
          Manage your password and review activity
        </p>
      </div>

      {/* Change password */}
      <Card className="p-6 mb-6">
        <h2 className="text-[15px] font-medium text-linear-text mb-4 flex items-center gap-2">
          <Lock size={15} strokeWidth={1.8} />
          Change password
        </h2>

        <form onSubmit={handleChangePassword} className="space-y-3 max-w-xs">
          <div>
            <label className="block text-[13px] text-linear-text-secondary mb-1.5">
              Current password
            </label>
            <Input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Enter current password"
              required
              error={!!passwordError}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-[13px] text-linear-text-secondary mb-1.5">
              New password
            </label>
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              error={!!passwordError}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-[13px] text-linear-text-secondary mb-1.5">
              Confirm new password
            </label>
            <Input
              type="password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="Repeat new password"
              required
              error={
                !!passwordError && newPassword !== confirmNewPassword
              }
              className="w-full"
            />
          </div>

          {passwordError && (
            <p className="text-[13px] text-linear-error">{passwordError}</p>
          )}

          <Button type="submit" disabled={changingPassword} className="mt-1">
            {changingPassword ? (
              <span className="flex items-center gap-2">
                <Spinner size={14} className="text-white" />
                Updating...
              </span>
            ) : (
              'Update password'
            )}
          </Button>
        </form>
      </Card>

      {/* Activity log */}
      <Card className="p-6">
        <h2 className="text-[15px] font-medium text-linear-text mb-4 flex items-center gap-2">
          <Clock size={15} strokeWidth={1.8} />
          Recent activity
        </h2>

        {loadingActivity ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size={20} />
          </div>
        ) : activityLog.length === 0 ? (
          <p className="text-[13px] text-linear-text-secondary py-4">
            No activity recorded yet.
          </p>
        ) : (
          <div className="space-y-0.5">
            {activityLog.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 py-2.5 px-3 rounded-md hover:bg-white/[0.03] transition-colors"
              >
                <div className="w-7 h-7 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0">
                  {getActivityIcon(entry.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] text-linear-text">
                    {getActivityLabel(entry.type)}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-linear-text-secondary">
                      {formatTimestamp(entry.timestamp)}
                    </span>
                    {entry.userAgent && (
                      <>
                        <span className="text-[11px] text-linear-text-secondary">
                          &middot;
                        </span>
                        <span className="text-[11px] text-linear-text-secondary flex items-center gap-1">
                          <Monitor size={10} />
                          {parseUserAgent(entry.userAgent)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

// ============================================================================
// PROTECTED ROUTE — Auth guard with setup/ownership redirect
// ============================================================================

// ============================================================================
// SETUP STAGE RESOLVER — Determines where a user is in the onboarding funnel
// Stages: 'telegram' → 'ownership' → 'worker' → 'complete'
// ============================================================================

function useSetupStage(user) {
  const [stage, setStage] = useState(null) // null = loading
  const [loading, setLoading] = useState(true)
  // Track which uid the current `stage` value belongs to. If `user.uid` differs
  // from this, our stage value is stale and we MUST treat the hook as loading
  // — synchronously, before any consumer reads `stageToRoute(null)` and
  // wrongly sends a freshly-signed-up user to /dashboard.
  const stageForUidRef = useRef(null)

  useEffect(() => {
    if (!user) {
      setStage(null)
      setLoading(false)
      stageForUidRef.current = null
      return
    }

    setStage(null)
    setLoading(true)

    // Subscribe to BOTH the telegram + cloudflare config docs. Earlier this
    // was a one-shot `.get()` pair, which meant: once the doc updated mid-
    // session (e.g. `/finalizeTransfer` flipped ownership_transferred to true,
    // or deployment-service wrote workerUrl) the hook never noticed, so the
    // user got stuck on the current page until they reloaded the tab.
    // onSnapshot reacts to writes immediately and re-routes the user.
    const basePath = configPath(user.uid)
    let tg = null
    let cf = null
    let tgReady = false
    let cfReady = false

    const recompute = () => {
      const telegramComplete = !!(tg && tg.botToken && tg.botUsername && tg.channelId)
      if (!telegramComplete) {
        stageForUidRef.current = user.uid
        setStage('telegram')
        setLoading(false)
        return
      }
      if (!tg.ownership_transferred && !tg.ownershipTransferred) {
        stageForUidRef.current = user.uid
        setStage('ownership')
        setLoading(false)
        return
      }
      if (!cf || !cf.workerUrl) {
        stageForUidRef.current = user.uid
        setStage('worker')
        setLoading(false)
        return
      }
      stageForUidRef.current = user.uid
      setStage('complete')
      setLoading(false)
    }

    // Routing decisions must come from SERVER truth. Firestore's first
    // snapshot is frequently served from the local cache; deciding the stage
    // on that stale read is exactly what bounced users BACKWARDS mid-funnel
    // (deploy finished → /dashboard → bounced to /setup/worker; finalize done
    // → bounced to /setup/ownership step 1). Hold 'loading' until each doc has
    // produced at least one server-confirmed snapshot; after that, accept
    // everything (local writes are forward progress).
    const tgUnsub = db.collection(basePath).doc('telegram').onSnapshot(
      { includeMetadataChanges: true },
      (doc) => {
        if (doc.metadata.fromCache && !tgReady) return
        tg = doc.exists ? doc.data() : null
        tgReady = true
        if (cfReady) recompute()
      },
      (err) => {
        // permission-denied for a brand-new uninitialized user → genuinely at
        // the start of the funnel. Any OTHER error (unavailable, transient
        // auth hiccup) must NOT demote a fully-set-up user to /setup — leave
        // the hook loading and let Firestore's auto-retrying stream recover.
        console.error('Error subscribing to telegram doc:', err)
        if (err?.code !== 'permission-denied') return
        tg = null
        tgReady = true
        if (cfReady) recompute()
      }
    )
    const cfUnsub = db.collection(basePath).doc('cloudflare').onSnapshot(
      { includeMetadataChanges: true },
      (doc) => {
        if (doc.metadata.fromCache && !cfReady) return
        cf = doc.exists ? doc.data() : null
        cfReady = true
        if (tgReady) recompute()
      },
      (err) => {
        // Same rule as the telegram doc: only permission-denied is a real
        // "not set up" signal; transient errors must not demote the stage.
        console.error('Error subscribing to cloudflare doc:', err)
        if (err?.code !== 'permission-denied') return
        cf = null
        cfReady = true
        if (tgReady) recompute()
      }
    )

    return () => { tgUnsub(); cfUnsub() }
  }, [user])

  // Synchronous race guard: if the consumer just received a new `user` and
  // our stage value still belongs to the previous uid, we are loading —
  // regardless of what the `loading` state currently says.
  const stageMatchesUser = user ? stageForUidRef.current === user.uid : true
  return { stage, loading: loading || (!!user && !stageMatchesUser) }
}

// Map stage → route. Defaults to /setup (start of funnel) so a stage=null race
// never accidentally promotes a brand-new user straight to /dashboard.
function stageToRoute(stage) {
  switch (stage) {
    case 'telegram': return '/setup'
    case 'ownership': return '/setup/ownership'
    case 'worker': return '/setup/worker'
    case 'complete': return '/dashboard'
    default: return '/setup'
  }
}

// ============================================================================
// CLOUDFLARE OAUTH CALLBACK — finishes the one-click provisioning
// ============================================================================
// Deliberately NOT wrapped in AuthOnly: that guard stage-routes the user back
// to /setup/worker. This component does its own (lightweight) auth check, then
// verifies state, exchanges the code server-side, and lets the stage guard
// route to /dashboard once the cloudflare config lands.

function CloudflareCallback() {
  const navigate = useNavigate()
  const [status, setStatus] = useState('Finishing authorization…')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      const params = new URLSearchParams(window.location.search)
      const code = params.get('code')
      const returnedState = params.get('state')
      const oauthErr = params.get('error')
      if (oauthErr) {
        const desc = params.get('error_description')
        setError(`Cloudflare authorization was cancelled${desc ? `: ${desc}` : ''}.`)
        return
      }
      // Single-use PKCE verifier + state, set before the redirect.
      const { verifier, state } = consumeOAuthState()
      if (!code || !returnedState || !state || returnedState !== state || !verifier) {
        setError('We could not verify the authorization. Please start setup again.')
        return
      }
      // Firebase restores the session after the full-page round-trip.
      const user = await new Promise((resolve) => {
        const unsub = auth.onAuthStateChanged((u) => { unsub(); resolve(u) })
      })
      if (cancelled) return
      if (!user) { navigate('/login', { replace: true }); return }
      try {
        const idToken = await user.getIdToken()
        setStatus('Building your private cloud…')
        const res = await fetch(`${DEPLOYMENT_WORKER}/oauth/cloudflare/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: CF_OAUTH_REDIRECT_URI }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.success) throw new Error(data.error || 'Setup failed. Please try again.')
        if (cancelled) return
        setStatus('Your private cloud is ready! Redirecting…')
        setTimeout(() => navigate('/dashboard', { replace: true }), 900)
      } catch (e) {
        if (!cancelled) setError(e.message || 'Something went wrong finishing setup.')
      }
    }
    run()
    return () => { cancelled = true }
  }, [navigate])

  return (
    <DotGridPage>
      <TerminalBar />
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-[420px] text-center"
        >
          {!error ? (
            <div className="flex flex-col items-center gap-4">
              <Spinner size={24} />
              <h1 className="text-[18px] font-semibold text-linear-text">{status}</h1>
              <p className="text-[13px] text-linear-text-secondary">
                Hang tight — creating your database and worker usually takes under a minute.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <h1 className="text-[18px] font-semibold text-linear-text">Setup couldn’t finish</h1>
              <p className="text-[13px] text-linear-error">{error}</p>
              <Button onClick={() => navigate('/setup/worker', { replace: true })} className="h-9 px-5 text-[13px]">
                Back to setup
              </Button>
            </div>
          )}
        </motion.div>
      </div>
    </DotGridPage>
  )
}

// ============================================================================
// PROTECTED ROUTE — Dashboard/Profile/Security (requires ALL setup done)
// ============================================================================

function ProtectedRoute({ children }) {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((u) => {
      setUser(u)
      setAuthLoading(false)
    })
    return () => unsubscribe()
  }, [])

  const { stage, loading: stageLoading } = useSetupStage(user)

  if (authLoading || stageLoading) {
    return <FullScreenSpinner />
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  // If setup is not complete, redirect to the incomplete step
  if (stage !== 'complete') {
    return <Navigate to={stageToRoute(stage)} replace />
  }

  return <Layout user={user}>{children}</Layout>
}

// ============================================================================
// AUTH GUARD — For setup pages (prevents skipping ahead or going backwards)
// ============================================================================

function AuthOnly({ children, allowedStage }) {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const location = useLocation()

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((u) => {
      setUser(u)
      setAuthLoading(false)
    })
    return () => unsubscribe()
  }, [])

  const { stage, loading: stageLoading } = useSetupStage(user)

  if (authLoading || stageLoading) {
    return <FullScreenSpinner />
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  // If setup is complete and they're on a setup page, send to dashboard
  if (stage === 'complete') {
    return <Navigate to="/dashboard" replace />
  }

  // If their current stage doesn't match this setup page, redirect them
  const correctRoute = stageToRoute(stage)
  if (location.pathname !== correctRoute) {
    return <Navigate to={correctRoute} replace />
  }

  return <>{children}</>
}

// ============================================================================
// PUBLIC GUARD — Redirect to correct page if already logged in
// ============================================================================

function PublicOnly({ children }) {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((u) => {
      setUser(u)
      setAuthLoading(false)
    })
    return () => unsubscribe()
  }, [])

  const { stage, loading: stageLoading } = useSetupStage(user)

  if (authLoading || (user && stageLoading)) {
    return <FullScreenSpinner />
  }

  if (user) {
    // Send them to wherever they need to be
    return <Navigate to={stageToRoute(stage)} replace />
  }

  return <>{children}</>
}

// ============================================================================
// MAIN APP
// ============================================================================

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public routes */}
        <Route
          path="/login"
          element={
            <PublicOnly>
              <LoginPage />
            </PublicOnly>
          }
        />
        <Route
          path="/signup"
          element={
            <PublicOnly>
              <SignupPage />
            </PublicOnly>
          }
        />

        {/* Setup routes (auth required, no sidebar) */}
        <Route
          path="/setup"
          element={
            <AuthOnly>
              <SetupPage />
            </AuthOnly>
          }
        />
        <Route
          path="/setup/ownership"
          element={
            <AuthOnly>
              <OwnershipPage />
            </AuthOnly>
          }
        />
        <Route
          path="/setup/worker"
          element={
            <AuthOnly>
              <SetupWorker />
            </AuthOnly>
          }
        />
        {/* OAuth return URL — not AuthOnly (it would stage-bounce); guards itself */}
        <Route path="/setup/cloudflare/callback" element={<CloudflareCallback />} />

        {/* Protected routes (auth + setup required, with sidebar) */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <DashboardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <ProfilePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/security"
          element={
            <ProtectedRoute>
              <SecurityPage />
            </ProtectedRoute>
          }
        />

        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
