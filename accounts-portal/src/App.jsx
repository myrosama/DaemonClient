import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom'
import { auth, db } from './config/firebase'
import { Button } from './components/ui/Button'
import { Input } from './components/ui/Input'
import { Card } from './components/ui/Card'
import { toast } from './components/ui/Toast'

// Layout Component
function Layout({ children, user }) {
  const navigate = useNavigate()

  const handleLogout = async () => {
    try {
      await auth.signOut()
      await fetch('https://auth.daemonclient.uz/logout', { credentials: 'include' })
      navigate('/login')
    } catch (error) {
      console.error('Logout error:', error)
    }
  }

  if (!user) return <>{children}</>

  return (
    <div className="min-h-screen bg-linear-bg flex">
      {/* Sidebar */}
      <div className="w-60 bg-linear-surface border-r border-white/[0.06] fixed h-screen">
        <div className="p-6">
          <h1 className="text-lg font-semibold text-linear-text tracking-tighter">DaemonClient</h1>
        </div>
        <nav className="px-3 space-y-1">
          <Link
            to="/dashboard"
            className="flex items-center gap-3 px-3 py-2 text-sm text-linear-text hover:bg-white/5 rounded-md transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
            Dashboard
          </Link>
          <Link
            to="/profile"
            className="flex items-center gap-3 px-3 py-2 text-sm text-linear-text hover:bg-white/5 rounded-md transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            Profile
          </Link>
          <Link
            to="/security"
            className="flex items-center gap-3 px-3 py-2 text-sm text-linear-text hover:bg-white/5 rounded-md transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Security
          </Link>
        </nav>
      </div>

      {/* Main content */}
      <div className="flex-1 ml-60">
        <header className="h-16 border-b border-white/[0.06] flex items-center justify-between px-8">
          <div className="text-sm text-linear-text-secondary">{user.email}</div>
          <Button variant="ghost" onClick={handleLogout}>
            Sign out
          </Button>
        </header>
        <main className="p-8">{children}</main>
      </div>
    </div>
  )
}

// Simple Google-style Signup
function SignupPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
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
      const idToken = await userCredential.user.getIdToken()

      // Call existing setup backend
      const res = await fetch('https://daemonclient-elnj.onrender.com/startSetup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: userCredential.user.uid, email, idToken })
      })

      if (res.ok) {
        // After setup completes, log them in via auth worker
        const refreshToken = userCredential.user.refreshToken
        const sessionRes = await fetch('https://auth.daemonclient.uz/create-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ idToken, refreshToken, returnUrl: '/dashboard' })
        })

        if (sessionRes.ok) {
          navigate('/dashboard')
        } else {
          navigate('/dashboard')
        }
      } else {
        navigate('/dashboard')
      }
    } catch (err) {
      toast.error(err.message || 'Sign up failed')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-linear-text mb-2 tracking-tighter">Create your account</h1>
          <p className="text-sm text-linear-text-secondary">to continue to DaemonClient</p>
        </div>

        <Card className="p-10">
          <form onSubmit={handleSignup} className="space-y-4">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              error={!!error}
              className="w-full"
            />

            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              error={!!error}
              className="w-full"
            />

            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              required
              error={!!error}
              className="w-full"
            />

            <Button
              type="submit"
              disabled={loading}
              className="w-full"
            >
              {loading ? 'Creating account...' : 'Create account'}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <Link to="/login" className="text-sm text-linear-purple hover:text-linear-purple-hover transition-colors">
              Sign in instead
            </Link>
          </div>
        </Card>

        <div className="mt-6 text-center">
          <a href="https://daemonclient.uz" className="text-sm text-linear-text-secondary hover:text-linear-text transition-colors">
            ← Back to home
          </a>
        </div>
      </div>
    </div>
  )
}

// Simple Google-style Login
function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
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

      const res = await fetch('https://auth.daemonclient.uz/create-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ idToken, refreshToken, returnUrl })
      })

      if (res.ok) {
        const { redirectUrl } = await res.json()
        window.location.href = redirectUrl
      } else {
        navigate('/dashboard')
      }
    } catch (err) {
      toast.error(err.message || 'Sign in failed')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-linear-text mb-2 tracking-tighter">Sign in</h1>
          <p className="text-sm text-linear-text-secondary">to continue to DaemonClient</p>
        </div>

        <Card className="p-10">
          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              required
              className="w-full"
            />

            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              className="w-full"
            />

            <Button
              type="submit"
              disabled={loading}
              className="w-full"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <Link to="/signup" className="text-sm text-linear-purple hover:text-linear-purple-hover transition-colors">
              Create account
            </Link>
          </div>
        </Card>

        <div className="mt-6 text-center">
          <a href="https://daemonclient.uz" className="text-sm text-linear-text-secondary hover:text-linear-text transition-colors">
            ← Back to home
          </a>
        </div>
      </div>
    </div>
  )
}

// Dashboard Page
function DashboardPage() {
  const [services, setServices] = useState({ photos: null, drive: null })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const user = auth.currentUser
    if (!user) return

    const uid = user.uid
    const unsubscribes = []

    // Listen to photos service
    const photosRef = db.doc(`artifacts/default-daemon-client/users/${uid}/services/photos`)
    unsubscribes.push(
      photosRef.onSnapshot((doc) => {
        if (doc.exists) {
          setServices((prev) => ({ ...prev, photos: doc.data() }))
        }
        setLoading(false)
      })
    )

    // Listen to drive service
    const driveRef = db.doc(`artifacts/default-daemon-client/users/${uid}/services/drive`)
    unsubscribes.push(
      driveRef.onSnapshot((doc) => {
        if (doc.exists) {
          setServices((prev) => ({ ...prev, drive: doc.data() }))
        }
      })
    )

    return () => unsubscribes.forEach((unsub) => unsub())
  }, [])

  return (
    <div className="max-w-7xl mx-auto px-4 py-12">
      <h1 className="text-4xl font-bold text-white mb-2">Your DaemonClient Account</h1>
      <p className="text-gray-400 mb-12">Manage your services and storage</p>

      {loading ? (
        <div className="text-center py-12">
          <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {/* Photos Service Card */}
          <motion.a
            href="https://photos.daemonclient.uz"
            whileHover={{ scale: 1.02, y: -4 }}
            className="block p-6 bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur border border-gray-700 rounded-2xl hover:border-indigo-500/50 transition shadow-xl"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="p-3 bg-indigo-500/10 rounded-xl">
                <svg className="w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <span className="px-3 py-1 bg-green-500/10 border border-green-500/50 rounded-full text-green-400 text-xs font-medium">
                Active
              </span>
            </div>
            <h3 className="text-xl font-bold text-white mb-2">DaemonClient Photos</h3>
            <p className="text-gray-400 text-sm mb-4">
              Unlimited photo storage with automatic organization
            </p>
            {services.photos && (
              <div className="text-sm text-gray-500">
                {services.photos.totalAssets || 0} photos
                {services.photos.lastAccessed && ` • Last used ${new Date(services.photos.lastAccessed.toDate()).toLocaleDateString()}`}
              </div>
            )}
          </motion.a>

          {/* Drive Service Card */}
          <motion.a
            href="https://app.daemonclient.uz"
            whileHover={{ scale: 1.02, y: -4 }}
            className="block p-6 bg-gradient-to-br from-gray-800/80 to-gray-900/80 backdrop-blur border border-gray-700 rounded-2xl hover:border-purple-500/50 transition shadow-xl"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="p-3 bg-purple-500/10 rounded-xl">
                <svg className="w-8 h-8 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <span className="px-3 py-1 bg-green-500/10 border border-green-500/50 rounded-full text-green-400 text-xs font-medium">
                Active
              </span>
            </div>
            <h3 className="text-xl font-bold text-white mb-2">DaemonClient Drive</h3>
            <p className="text-gray-400 text-sm mb-4">
              Store any file, encrypted and accessible anywhere
            </p>
            {services.drive && (
              <div className="text-sm text-gray-500">
                {services.drive.totalFiles || 0} files
                {services.drive.lastAccessed && ` • Last used ${new Date(services.drive.lastAccessed.toDate()).toLocaleDateString()}`}
              </div>
            )}
          </motion.a>
        </div>
      )}
    </div>
  )
}

// Profile Page
function ProfilePage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-white mb-8">Profile Settings</h1>
      <div className="bg-gray-800/50 backdrop-blur border border-gray-700 rounded-2xl p-8">
        <p className="text-gray-400">Profile settings coming soon...</p>
      </div>
    </div>
  )
}

// Security Page
function SecurityPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold text-white mb-8">Security & Activity</h1>
      <div className="bg-gray-800/50 backdrop-blur border border-gray-700 rounded-2xl p-8">
        <p className="text-gray-400">Activity log coming soon...</p>
      </div>
    </div>
  )
}

// Protected Route Component
function ProtectedRoute({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      setUser(user)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
        <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <Layout user={user}>{children}</Layout>
}

// Main App
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
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
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
