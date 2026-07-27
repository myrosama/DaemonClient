import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { auth, FIREBASE_PROJECT_ID } from '../config/firebase'
import { toast } from '../components/ui/Toast'
import { PROCESSOR_ATTACH_ENDPOINT, PROCESSOR_DEPLOY_URL } from '../config/processor'
import {
  ExternalLink, Check, Loader2, ArrowRight, Copy, Image, Sparkles, ShieldCheck,
} from 'lucide-react'

// Onboarding step 4 (OPTIONAL): connect a HEIC → JPEG converter.
//
// Why optional, not required: HEIC photos back up and are fully safe WITHOUT
// this — Telegram just cannot make their grid thumbnails, so they show a blur
// until healed. Blocking signup on a Vercel deploy would strand every user who
// does not have an iPhone, or does not care, on a step they cannot finish. So
// it is skippable but encouraged; a user who skips can add it any time.
//
// It must end by calling the worker's POST /api/server/processor (the single
// validator that the URL is https, public, a real processor, owner-pinned, and
// answers to THIS user's token). The browser only holds a Firebase ID token, so
// the deployment-service brokers that call (mirrors the Cloudflare OAuth step).
export function SetupProcessor() {
  const navigate = useNavigate()
  const [ready, setReady] = useState(false)
  const [uid, setUid] = useState('')
  const [url, setUrl] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const [deployOpened, setDeployOpened] = useState(false)

  useEffect(() => {
    const unsub = auth.onAuthStateChanged((u) => {
      if (!u) { navigate('/login', { replace: true }); return }
      setUid(u.uid)
      setReady(true)
    })
    return () => unsub()
  }, [navigate])

  const copy = (text, label) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Copy failed'),
    )

  const openDeploy = () => {
    window.open(PROCESSOR_DEPLOY_URL, 'dc-vercel', 'noopener,noreferrer')
    setDeployOpened(true)
  }

  const handleConnect = async () => {
    const value = url.trim()
    if (!value) { setError('Paste the URL Vercel gave you after the deploy finished.'); return }
    setConnecting(true)
    setError('')
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Your session expired. Please sign in again.')
      const idToken = await user.getIdToken()
      const res = await fetch(PROCESSOR_ATTACH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ url: value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'That URL could not be verified. Check the deploy finished.')
      toast.success('Processor connected — HEIC photos will get thumbnails automatically')
      navigate('/dashboard', { replace: true })
    } catch (e) {
      setError(e.message || 'Could not connect the processor.')
    } finally {
      setConnecting(false)
    }
  }

  if (!ready) {
    return (
      <div className="min-h-screen dot-grid flex items-center justify-center">
        <Loader2 className="animate-spin text-linear-text-secondary" size={22} />
      </div>
    )
  }

  return (
    <div className="min-h-screen dot-grid flex flex-col">
      {/* terminal bar */}
      <div className="w-full flex justify-center pt-6 px-4">
        <div className="inline-flex items-center gap-3 bg-[#111318] border border-white/[0.08] rounded-lg px-5 py-2.5">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
          </div>
          <span className="font-mono text-[12px] text-linear-text-secondary tracking-wide select-none">
            daemonclient connect --heic-processor
          </span>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-lg"
        >
          {/* header */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-1.5 text-[11px] text-linear-text-secondary mb-4 px-3 py-1 rounded-full border border-white/[0.08] bg-white/[0.03]">
              <Sparkles size={11} className="text-daemon-green" />
              Optional · you can skip this
            </div>
            <h1 className="text-2xl font-semibold text-linear-text tracking-tighter mb-2">
              Instant iPhone (HEIC) thumbnails
            </h1>
            <p className="text-[13px] text-linear-text-secondary leading-relaxed">
              iPhone photos use HEIC — the one format Telegram can't make a thumbnail for.
              Deploy a tiny free converter to <span className="text-linear-text">your own</span> Vercel
              and HEIC photos get thumbnails automatically. Skip it and they still back up
              safely — they just show a blur until fixed.
            </p>
          </div>

          {/* privacy note */}
          <div className="flex items-start gap-2.5 bg-daemon-green/[0.06] border border-daemon-green/20 rounded-xl p-3.5 mb-4">
            <ShieldCheck size={15} className="text-daemon-green shrink-0 mt-0.5" />
            <p className="text-[12px] text-linear-text-secondary leading-relaxed">
              The converter runs on <span className="text-linear-text">your</span> account and is pinned to
              <span className="text-linear-text"> your</span> login only. Your photos are never sent to us.
            </p>
          </div>

          {/* step 1 — deploy */}
          <div className="bg-[#111318] border border-white/[0.08] rounded-xl p-5 mb-4">
            <div className="flex items-start gap-3">
              <StepBadge n={1} />
              <div className="flex-1">
                <p className="text-[14px] font-medium text-linear-text mb-1">Deploy the converter</p>
                <p className="text-[12px] text-linear-text-secondary mb-3">
                  Opens Vercel. When it asks for two values, paste these:
                </p>

                <div className="space-y-2 mb-3">
                  <CopyRow label="FIREBASE_PROJECT_ID" value={FIREBASE_PROJECT_ID} onCopy={copy} />
                  <CopyRow label="OWNER_UID" value={uid} onCopy={copy} />
                </div>

                <button
                  onClick={openDeploy}
                  className="w-full flex items-center justify-between gap-3 bg-daemon-green/10 hover:bg-daemon-green/[0.16] border border-daemon-green/25 hover:border-daemon-green/50 text-daemon-green rounded-lg px-4 py-3 text-[13px] font-medium transition-all duration-150"
                >
                  <span className="inline-flex items-center gap-2"><Image size={14} /> Deploy to Vercel</span>
                  <ArrowRight size={15} />
                </button>
              </div>
            </div>
          </div>

          {/* step 2 — paste url */}
          <div className="bg-[#111318] border border-white/[0.08] rounded-xl p-5 mb-4">
            <div className="flex items-start gap-3">
              <StepBadge n={2} />
              <div className="flex-1">
                <p className="text-[14px] font-medium text-linear-text mb-1">Paste your converter's URL</p>
                <p className="text-[12px] text-linear-text-secondary mb-3">
                  After the deploy finishes, copy the URL Vercel shows (e.g.
                  <span className="font-mono text-linear-text"> your-app.vercel.app</span>) and paste it here.
                </p>
                <input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  placeholder="https://your-app.vercel.app"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); if (error) setError('') }}
                  className="w-full bg-[#0b0d11] border border-white/[0.1] focus:border-daemon-green/50 rounded-lg px-3.5 py-2.5 text-[13px] text-linear-text placeholder:text-linear-text-secondary/60 outline-none transition-colors"
                />
                <AnimatePresence>
                  {error && (
                    <motion.p
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      role="alert"
                      className="text-[12px] text-linear-error mt-2"
                    >
                      {error}
                    </motion.p>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* connect */}
          <button
            onClick={handleConnect}
            disabled={connecting || !url.trim()}
            className="w-full h-10 rounded-lg text-sm font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-daemon-green hover:bg-daemon-green-hover text-white shadow-sm flex items-center justify-center gap-2"
          >
            {connecting ? (<><Loader2 size={14} className="animate-spin" /> Verifying your converter…</>) : (<><Check size={14} /> Connect Processor</>)}
          </button>

          {/* skip */}
          <button
            onClick={() => navigate('/dashboard', { replace: true })}
            disabled={connecting}
            className="w-full mt-3 text-[12px] text-linear-text-secondary hover:text-linear-text transition-colors disabled:opacity-40"
          >
            Skip for now — I'll do this later
          </button>

          <p className="text-center text-[11px] text-linear-text-secondary mt-5 leading-relaxed inline-flex items-center gap-1.5 w-full justify-center">
            <ExternalLink size={11} /> You can connect a processor any time from your dashboard.
          </p>
        </motion.div>
      </div>
    </div>
  )
}

function CopyRow({ label, value, onCopy }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-[#0b0d11] border border-white/[0.08] rounded-lg px-3 py-2">
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-widest text-linear-text-secondary">{label}</p>
        <p className="font-mono text-[12px] text-linear-text truncate">{value}</p>
      </div>
      <button
        onClick={() => onCopy(value, label)}
        className="shrink-0 inline-flex items-center gap-1 text-[11px] text-linear-text-secondary hover:text-linear-text border border-white/[0.1] hover:border-white/[0.2] rounded-md px-2 py-1 transition-all"
      >
        <Copy size={11} /> Copy
      </button>
    </div>
  )
}

function StepBadge({ n }) {
  return (
    <div className="w-6 h-6 rounded-full bg-white/[0.05] border border-white/[0.1] flex items-center justify-center shrink-0 text-[11px] font-medium text-linear-text-secondary mt-0.5">
      {n}
    </div>
  )
}
