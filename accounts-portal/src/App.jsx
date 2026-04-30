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
const AUTH_WORKER = 'https://daemonclient-auth.sadrikov49.workers.dev'

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
// LAYOUT — Sidebar + Header
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

  const navItems = [
    { path: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/profile', label: 'Profile', icon: User },
    { path: '/security', label: 'Security', icon: Shield },
  ]

  const initials = user.displayName
    ? user.displayName.charAt(0).toUpperCase()
    : user.email.charAt(0).toUpperCase()

  return (
    <div className="min-h-screen bg-linear-bg flex">
      {/* Sidebar */}
      <div className="w-60 bg-linear-surface border-r border-white/[0.06] fixed h-screen flex flex-col">
        <div className="p-6">
          <Link to="/dashboard" className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-linear-purple flex items-center justify-center">
              <span className="text-white text-xs font-bold">D</span>
            </div>
            <h1 className="text-[15px] font-semibold text-linear-text tracking-tighter">
              DaemonClient
            </h1>
          </Link>
        </div>

        <nav className="px-3 space-y-0.5 flex-1">
          {navItems.map(({ path, label, icon: Icon }) => {
            const active = location.pathname === path
            return (
              <Link
                key={path}
                to={path}
                className={`flex items-center gap-3 px-3 py-[7px] text-[13px] rounded-md transition-colors ${
                  active
                    ? 'bg-white/[0.08] text-linear-text font-medium'
                    : 'text-linear-text-secondary hover:bg-white/[0.04] hover:text-linear-text'
                }`}
              >
                <Icon size={16} strokeWidth={1.8} />
                {label}
              </Link>
            )
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="p-3 border-t border-white/[0.06]">
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="w-7 h-7 rounded-full bg-linear-purple flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-medium">{initials}</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-linear-text truncate">
                {user.displayName || user.email.split('@')[0]}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 ml-60">
        <header className="h-12 border-b border-white/[0.06] flex items-center justify-between px-6 sticky top-0 bg-linear-bg/80 backdrop-blur-xl z-10">
          <div className="text-[13px] text-linear-text-secondary">{user.email}</div>
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors"
          >
            <LogOut size={14} strokeWidth={1.8} />
            Sign out
          </button>
        </header>
        <main className="p-8">{children}</main>
      </div>
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
    <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-[380px]"
      >
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-linear-purple flex items-center justify-center mx-auto mb-5">
            <span className="text-white text-lg font-bold">D</span>
          </div>
          <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
            Sign in
          </h1>
          <p className="text-[13px] text-linear-text-secondary mt-1">
            to continue to DaemonClient
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleLogin} className="space-y-3">
            <div>
              <label className="block text-[13px] text-linear-text-secondary mb-1.5">
                Email
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                error={!!error}
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-[13px] text-linear-text-secondary mb-1.5">
                Password
              </label>
              <div className="relative">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                  error={!!error}
                  className="w-full pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-linear-text-secondary hover:text-linear-text transition-colors"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-[13px] text-linear-error">{error}</p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full mt-1"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Signing in...
                </span>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>

          <div className="mt-5 pt-5 border-t border-white/[0.06] text-center">
            <Link
              to="/signup"
              className="text-[13px] text-linear-purple hover:text-linear-purple-hover transition-colors"
            >
              Create account
            </Link>
          </div>
        </Card>

        <div className="mt-5 text-center">
          <a
            href="https://daemonclient.uz"
            className="text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors inline-flex items-center gap-1"
          >
            <ArrowLeft size={12} />
            Back to home
          </a>
        </div>
      </motion.div>
    </div>
  )
}

// ============================================================================
// SIGNUP PAGE
// ============================================================================

function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const handleSignup = async (e) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    setLoading(true)

    try {
      const userCredential = await auth.createUserWithEmailAndPassword(email, password)
      const user = userCredential.user
      const idToken = await user.getIdToken()

      // Call Render backend to start setup
      try {
        await fetch(`${RENDER_BACKEND}/startSetup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { uid: user.uid, email: user.email } }),
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
    <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-[380px]"
      >
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-linear-purple flex items-center justify-center mx-auto mb-5">
            <span className="text-white text-lg font-bold">D</span>
          </div>
          <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
            Create your account
          </h1>
          <p className="text-[13px] text-linear-text-secondary mt-1">
            to continue to DaemonClient
          </p>
        </div>

        <Card className="p-6">
          <form onSubmit={handleSignup} className="space-y-3">
            <div>
              <label className="block text-[13px] text-linear-text-secondary mb-1.5">
                Email
              </label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                error={!!error}
                className="w-full"
              />
            </div>

            <div>
              <label className="block text-[13px] text-linear-text-secondary mb-1.5">
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
                  className="w-full pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-linear-text-secondary hover:text-linear-text transition-colors"
                >
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[13px] text-linear-text-secondary mb-1.5">
                Confirm password
              </label>
              <Input
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                required
                error={!!error && password !== confirmPassword}
                className="w-full"
              />
            </div>

            {error && (
              <p className="text-[13px] text-linear-error">{error}</p>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full mt-1"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner size={14} className="text-white" />
                  Creating account...
                </span>
              ) : (
                'Create account'
              )}
            </Button>
          </form>

          <div className="mt-5 pt-5 border-t border-white/[0.06] text-center">
            <Link
              to="/login"
              className="text-[13px] text-linear-purple hover:text-linear-purple-hover transition-colors"
            >
              Sign in instead
            </Link>
          </div>
        </Card>

        <div className="mt-5 text-center">
          <a
            href="https://daemonclient.uz"
            className="text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors inline-flex items-center gap-1"
          >
            <ArrowLeft size={12} />
            Back to home
          </a>
        </div>
      </motion.div>
    </div>
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

  const handleStartAutomatedSetup = async () => {
    // Guard: if telegram config already exists, do NOT call /startSetup again —
    // that would create a duplicate bot+channel. Just move forward.
    if (alreadyConfigured) {
      navigate('/setup/ownership')
      return
    }
    setStatusMessage('Initiating secure setup... This may take a minute.')
    setError('')
    setIsLoading(true)
    try {
      const response = await fetch(`${RENDER_BACKEND}/startSetup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: { uid: auth.currentUser.uid, email: auth.currentUser.email },
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        throw new Error(
          result.error?.message || 'The setup service returned an error.'
        )
      }
      setStatusMessage('Finalizing configuration...')

      const configDocRef = db
        .collection(configPath(auth.currentUser.uid))
        .doc('telegram')
      let attempts = 0
      const maxAttempts = 8
      while (attempts < maxAttempts) {
        const docSnap = await configDocRef.get()
        if (docSnap.exists && docSnap.data().botToken) {
          setStatusMessage('Configuration saved! Proceeding...')
          navigate('/setup/ownership')
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
        attempts++
      }
      throw new Error(
        'Could not verify configuration after setup. Please try again.'
      )
    } catch (err) {
      console.error('Setup error:', err)
      setStatusMessage('')
      if (err.message.includes('Failed to fetch')) {
        setError('Could not connect to the setup service. Please try again later.')
      } else {
        setError(err.message || 'An unexpected error occurred.')
      }
    } finally {
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
        if (!doc.exists) return
        const data = doc.data() || {}
        // Only treat as configured when the doc is fully populated, not just
        // a half-written stub from a failed /startSetup.
        const complete = !!(data.botToken && data.botUsername && data.channelId)
        if (!complete) return
        setAlreadyConfigured(true)
        const transferred = data.ownership_transferred || data.ownershipTransferred
        setStatusMessage('Setup complete! Redirecting...')
        setTimeout(() => navigate(transferred ? '/setup/worker' : '/setup/ownership'), 800)
      })
    return () => unsubscribe()
  }, [navigate])

  const handleLogout = async () => {
    await auth.signOut()
    await destroySession()
    navigate('/login')
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-[520px]"
      >
        <div className="text-center mb-8">
          <div className="w-10 h-10 rounded-xl bg-linear-purple flex items-center justify-center mx-auto mb-5">
            <Bot size={20} className="text-white" />
          </div>
          <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
            One-Time Setup
          </h1>
          <p className="text-[13px] text-linear-text-secondary mt-1">
            Create your private, secure Telegram storage
          </p>
        </div>

        <Card className="p-6">
          <AnimatePresence mode="wait">
            {!showManualForm ? (
              <motion.div
                key="options"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-4"
              >
                {/* Automated setup */}
                <div className="relative border border-linear-purple/40 rounded-md p-5">
                  <span className="absolute -top-2.5 right-4 bg-linear-purple text-white text-[11px] font-medium px-2.5 py-0.5 rounded-full">
                    Recommended
                  </span>
                  <h2 className="text-[15px] font-medium text-linear-text">
                    Automated Setup
                  </h2>
                  <p className="text-[13px] text-linear-text-secondary mt-1.5">
                    We create and configure a private bot and channel for you automatically.
                  </p>
                  <Button
                    onClick={handleStartAutomatedSetup}
                    disabled={isLoading || !!statusMessage}
                    className="w-full mt-4"
                  >
                    {isLoading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Spinner size={14} className="text-white" />
                        Setting up...
                      </span>
                    ) : (
                      'Create My Secure Storage'
                    )}
                  </Button>
                </div>

                {/* Manual setup */}
                <div className="border border-white/[0.06] rounded-md p-5">
                  <h2 className="text-[15px] font-medium text-linear-text">
                    Manual Setup
                  </h2>
                  <p className="text-[13px] text-linear-text-secondary mt-1.5">
                    For advanced users with an existing bot and channel.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setShowManualForm(true)}
                    className="w-full mt-4"
                  >
                    Enter Credentials Manually
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="manual"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-3"
              >
                <h2 className="text-[15px] font-medium text-linear-text text-center mb-4">
                  Enter Your Credentials
                </h2>
                <div>
                  <label className="block text-[13px] text-linear-text-secondary mb-1.5">
                    <Bot size={12} className="inline mr-1" />
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
                  <label className="block text-[13px] text-linear-text-secondary mb-1.5">
                    <Hash size={12} className="inline mr-1" />
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

                <Button
                  onClick={handleSaveManualSetup}
                  disabled={isLoading}
                  className="w-full mt-2"
                >
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
                  className="w-full text-center text-[13px] text-linear-text-secondary hover:text-linear-text transition-colors mt-2"
                >
                  Back to setup options
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Status bar */}
          {statusMessage && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 p-3 bg-linear-purple/10 border border-linear-purple/20 rounded-md flex items-center gap-3"
            >
              <Spinner size={16} />
              <p className="text-[13px] text-linear-purple">{statusMessage}</p>
            </motion.div>
          )}

          {/* Error */}
          {error && !statusMessage && (
            <p className="text-[13px] text-linear-error mt-4 text-center">
              {error}
            </p>
          )}
        </Card>

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
  )
}

// ============================================================================
// OWNERSHIP PAGE — Transfer bot/channel ownership
// ============================================================================

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
      const response = await fetch(`${RENDER_BACKEND}/finalizeTransfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      // CRITICAL: don't navigate to /setup/worker until the client can actually
      // READ ownership_transferred=true from Firestore. The backend already
      // wrote it, but client cache/replication can lag a few seconds — and
      // useSetupStage on /setup/worker would otherwise read stale data and
      // bounce the user right back here, looping forever.
      const configDocRef = db
        .collection(configPath(auth.currentUser.uid))
        .doc('telegram')
      let attempts = 0
      const maxAttempts = 12 // ~18s total
      while (attempts < maxAttempts) {
        try {
          const snap = await configDocRef.get({ source: 'server' })
          const data = snap.data() || {}
          if (data.ownership_transferred || data.ownershipTransferred) break
        } catch {}
        await new Promise((r) => setTimeout(r, 1500))
        attempts++
      }
      navigate('/setup/worker')
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
    <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="w-full max-w-[480px]"
      >
        <Card className="p-6">
          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-5 text-center"
              >
                <div>
                  <p className="text-[11px] font-medium text-linear-purple uppercase tracking-wider mb-2">
                    Step 1 of 2
                  </p>
                  <h1 className="text-lg font-semibold text-linear-text tracking-tighter">
                    Start Your Bot
                  </h1>
                  <p className="text-[13px] text-linear-text-secondary mt-2">
                    Click the link below, press START in Telegram, then come back here.
                  </p>
                </div>

                <a
                  href={config ? `https://t.me/${config.botUsername}` : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleLinkClicked}
                  className="inline-flex items-center gap-2 bg-[#2AABEE] hover:bg-[#229ED9] text-white text-[13px] font-medium px-5 py-2 rounded-md transition-colors"
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

                <Button
                  onClick={handleNextStep}
                  disabled={isButtonDisabled}
                  className="w-full"
                >
                  {isButtonDisabled
                    ? `Next Step (${countdown}s)`
                    : 'Next Step'}
                </Button>
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="space-y-5 text-center"
              >
                <div>
                  <p className="text-[11px] font-medium text-linear-purple uppercase tracking-wider mb-2">
                    Step 2 of 2
                  </p>
                  <h1 className="text-lg font-semibold text-linear-text tracking-tighter">
                    Join Your Channel
                  </h1>
                  <p className="text-[13px] text-linear-text-secondary mt-2">
                    Click the link to join your secure channel, then finalize the transfer.
                  </p>
                </div>

                <a
                  href={config ? config.invite_link : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleLinkClicked}
                  className="inline-flex items-center gap-2 bg-[#2AABEE] hover:bg-[#229ED9] text-white text-[13px] font-medium px-5 py-2 rounded-md transition-colors"
                >
                  Join Secure Channel
                  <ExternalLink size={13} />
                </a>

                <Button
                  onClick={handleFinalize}
                  disabled={isButtonDisabled}
                  className="w-full"
                >
                  {isButtonDisabled
                    ? `Finalize (${countdown}s)`
                    : 'Finalize Transfer'}
                </Button>
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <h1 className="text-lg font-semibold text-linear-text tracking-tighter text-center mb-4">
                  Finalizing Setup...
                </h1>
                <ul className="space-y-1 bg-linear-bg rounded-md p-4">
                  {transferStatus && (
                    <>
                      <StatusItem
                        status={transferStatus.bot.status}
                        message={transferStatus.bot.message}
                      />
                      <StatusItem
                        status={transferStatus.channel.status}
                        message={transferStatus.channel.message}
                      />
                    </>
                  )}
                </ul>
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <p className="text-[13px] text-linear-error text-center mt-4">
              {error}
            </p>
          )}
        </Card>

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
  )
}

// ============================================================================
// DASHBOARD PAGE
// ============================================================================

function DashboardPage() {
  const [services, setServices] = useState({ photos: null, drive: null })
  const [backend, setBackend] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return

    const uid = user.uid
    const unsubscribes = []

    const photosRef = db.doc(`${userPath(uid)}/services/photos`)
    unsubscribes.push(
      photosRef.onSnapshot((doc) => {
        if (doc.exists) {
          setServices((prev) => ({ ...prev, photos: doc.data() }))
        }
        setLoading(false)
      })
    )

    const driveRef = db.doc(`${userPath(uid)}/services/drive`)
    unsubscribes.push(
      driveRef.onSnapshot((doc) => {
        if (doc.exists) {
          setServices((prev) => ({ ...prev, drive: doc.data() }))
        }
        setLoading(false)
      })
    )

    const cfRef = db.doc(`${configPath(uid)}/cloudflare`)
    unsubscribes.push(
      cfRef.onSnapshot((doc) => {
        if (doc.exists) setBackend(doc.data())
      })
    )

    // fallback in case no docs exist
    const timeout = setTimeout(() => setLoading(false), 3000)

    return () => {
      unsubscribes.forEach((unsub) => unsub())
      clearTimeout(timeout)
    }
  }, [])

  const copyToClipboard = (text, label) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Copy failed')
    )
  }

  const serviceCards = [
    {
      key: 'photos',
      title: 'DaemonClient Photos',
      description: 'Unlimited photo storage with automatic organization',
      href: 'https://photos.daemonclient.uz',
      icon: Image,
      color: 'text-linear-purple',
      bgColor: 'bg-linear-purple/10',
      borderHover: 'hover:border-linear-purple/30',
      stats: services.photos
        ? `${services.photos.totalAssets || 0} photos`
        : null,
      lastAccessed: services.photos?.lastAccessed,
    },
    {
      key: 'drive',
      title: 'DaemonClient Drive',
      description: 'Store any file, encrypted and accessible anywhere',
      href: 'https://app.daemonclient.uz',
      icon: FolderOpen,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10',
      borderHover: 'hover:border-purple-500/30',
      stats: services.drive
        ? `${services.drive.totalFiles || 0} files`
        : null,
      lastAccessed: services.drive?.lastAccessed,
    },
  ]

  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
          Dashboard
        </h1>
        <p className="text-[13px] text-linear-text-secondary mt-1">
          Manage your services and storage
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner size={24} />
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {serviceCards.map((svc) => {
            const Icon = svc.icon
            return (
              <motion.a
                key={svc.key}
                href={svc.href}
                whileHover={{ y: -2 }}
                transition={{ duration: 0.15 }}
                className={`block p-5 bg-linear-surface border border-white/[0.06] rounded-md ${svc.borderHover} transition-colors group`}
              >
                <div className="flex items-start justify-between mb-4">
                  <div className={`p-2.5 rounded-lg ${svc.bgColor}`}>
                    <Icon size={20} className={svc.color} strokeWidth={1.8} />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-linear-success" />
                    <span className="text-[11px] text-linear-success font-medium">
                      Active
                    </span>
                  </div>
                </div>

                <h3 className="text-[15px] font-medium text-linear-text mb-1">
                  {svc.title}
                </h3>
                <p className="text-[13px] text-linear-text-secondary mb-3">
                  {svc.description}
                </p>

                {svc.stats && (
                  <div className="text-[12px] text-linear-text-secondary">
                    {svc.stats}
                    {svc.lastAccessed &&
                      ` · Last used ${new Date(svc.lastAccessed.toDate()).toLocaleDateString()}`}
                  </div>
                )}

                <div className="flex items-center gap-1 mt-3 text-[12px] text-linear-text-secondary group-hover:text-linear-purple transition-colors">
                  Open
                  <ChevronRight size={12} />
                </div>
              </motion.a>
            )
          })}
        </div>
      )}

      {backend?.workerUrl && (
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-3">
            <Server size={14} className="text-linear-text-secondary" />
            <h2 className="text-[13px] font-medium text-linear-text">Your Backend</h2>
          </div>
          <div className="bg-linear-surface border border-white/[0.06] rounded-md p-5 space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-medium text-linear-text-secondary uppercase tracking-wider">
                  Worker URL
                </label>
                <button
                  onClick={() => copyToClipboard(backend.workerUrl, 'Worker URL')}
                  className="flex items-center gap-1 text-[11px] text-linear-text-secondary hover:text-linear-text transition-colors"
                >
                  <Copy size={11} />
                  Copy
                </button>
              </div>
              <div className="font-mono text-[12px] text-linear-text bg-linear-bg border border-white/[0.04] rounded px-3 py-2 break-all">
                {backend.workerUrl}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-medium text-linear-text-secondary uppercase tracking-wider flex items-center gap-1.5">
                  <Smartphone size={11} />
                  Immich Mobile App — Server Endpoint URL
                </label>
                <button
                  onClick={() => copyToClipboard(`${backend.workerUrl}/api`, 'Server URL')}
                  className="flex items-center gap-1 text-[11px] text-linear-text-secondary hover:text-linear-text transition-colors"
                >
                  <Copy size={11} />
                  Copy
                </button>
              </div>
              <div className="font-mono text-[12px] text-linear-text bg-linear-bg border border-white/[0.04] rounded px-3 py-2 break-all">
                {backend.workerUrl}/api
              </div>
              <p className="text-[11px] text-linear-text-secondary mt-1.5">
                Paste this in the Immich mobile app's "Server Endpoint URL" field on the login screen.
              </p>
            </div>

            {backend.databaseName && (
              <div className="grid grid-cols-2 gap-4 pt-2 border-t border-white/[0.04]">
                <div>
                  <p className="text-[11px] text-linear-text-secondary mb-0.5">Database</p>
                  <p className="font-mono text-[12px] text-linear-text">{backend.databaseName}</p>
                </div>
                <div>
                  <p className="text-[11px] text-linear-text-secondary mb-0.5">Account ID</p>
                  <p className="font-mono text-[12px] text-linear-text truncate" title={backend.accountId}>
                    {backend.accountId}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
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

    // Reset stage when user changes so the synchronous race-guard below
    // continues to read as loading until checkStage resolves.
    setStage(null)
    setLoading(true)

    let cancelled = false

    async function checkStage() {
      try {
        const basePath = configPath(user.uid)

        // 1. Check Telegram config — require ALL fields, not just botToken.
        // Half-written docs (botToken without botUsername/channelId) used to
        // advance the user to /setup/ownership where the UI then spins forever
        // because there is no @bot to open. Treat partial config as 'telegram'
        // so the user can re-trigger /startSetup cleanly.
        const telegramDoc = await db.collection(basePath).doc('telegram').get()
        const tg = telegramDoc.exists ? telegramDoc.data() : null
        const telegramComplete = !!(tg && tg.botToken && tg.botUsername && tg.channelId)
        if (!telegramComplete) {
          if (!cancelled) { stageForUidRef.current = user.uid; setStage('telegram'); setLoading(false) }
          return
        }

        // 2. Check ownership transfer
        // Backend writes snake_case (ownership_transferred) — match that.
        const telegramData = tg
        if (!telegramData.ownership_transferred && !telegramData.ownershipTransferred) {
          if (!cancelled) { stageForUidRef.current = user.uid; setStage('ownership'); setLoading(false) }
          return
        }

        // 3. Check Cloudflare / worker setup
        const cfDoc = await db.collection(basePath).doc('cloudflare').get()
        if (!cfDoc.exists || !cfDoc.data()?.workerUrl) {
          if (!cancelled) { stageForUidRef.current = user.uid; setStage('worker'); setLoading(false) }
          return
        }

        // All done
        if (!cancelled) { stageForUidRef.current = user.uid; setStage('complete'); setLoading(false) }
      } catch (err) {
        console.error('Error checking setup stage:', err)
        // On error (e.g. Firestore permission denied for a brand new uninitialized user),
        // we MUST fallback to 'telegram' setup, NOT 'complete', otherwise they skip the funnel
        if (!cancelled) { stageForUidRef.current = user.uid; setStage('telegram'); setLoading(false) }
      }
    }

    checkStage()
    return () => { cancelled = true }
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
