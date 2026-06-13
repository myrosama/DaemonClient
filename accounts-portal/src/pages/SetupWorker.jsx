import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '../components/ui/Button'
import { TokenInput } from '../components/TokenInput'
import { DeploymentProgress } from '../components/DeploymentProgress'
import { useWorkerSetup } from '../hooks/useWorkerSetup'
import { startCloudflareOAuth } from '../config/cloudflareOauth'
import { ExternalLink, Check, Loader2, ArrowRight, Zap, Database, Shield, RefreshCw } from 'lucide-react'

// Pre-filled Cloudflare token creator — permissions already set, user just clicks Create
const CF_TOKEN_TEMPLATE_URL =
  'https://dash.cloudflare.com/profile/api-tokens' +
  '?permissionGroupKeys=%5B%7B%22key%22%3A%22workers_scripts%22%2C%22type%22%3A%22edit%22%7D' +
  '%2C%7B%22key%22%3A%22d1%22%2C%22type%22%3A%22edit%22%7D' +
  '%2C%7B%22key%22%3A%22account%22%2C%22type%22%3A%22read%22%7D%5D' +
  '&name=DaemonClient'

const FEATURES = [
  { icon: Zap,        label: '100,000 requests/day' },
  { icon: Database,   label: '5 GB database storage' },
  { icon: Shield,     label: 'Fully private & yours' },
  { icon: RefreshCw,  label: 'Automatic updates' },
]

export function SetupWorker() {
  const navigate = useNavigate()
  const {
    token,
    accountId,
    isValid,
    isDeploying,
    currentStep,
    error,
    handleTokenChange,
    handleValidation,
    startDeployment,
  } = useWorkerSetup()

  const [tokenCreatorOpened, setTokenCreatorOpened] = useState(false)
  const [storeToken, setStoreToken] = useState(true)
  const [authorizing, setAuthorizing] = useState(false)

  // One-click path: redirect to Cloudflare's consent screen. On return, the
  // /setup/cloudflare/callback route exchanges the code and provisions.
  const handleAuthorize = async () => {
    setAuthorizing(true)
    try {
      await startCloudflareOAuth() // navigates away
    } catch (e) {
      console.error('Could not start Cloudflare authorization:', e)
      setAuthorizing(false)
    }
  }

  const handleDeploy = async () => {
    try {
      await startDeployment()
      setTimeout(() => navigate('/dashboard'), 2000)
    } catch (err) {
      console.error('Deployment error:', err)
    }
  }

  const openTokenCreator = () => {
    // Named window: every (re-)open reuses ONE Cloudflare tab instead of
    // stacking a new tab per click.
    window.open(CF_TOKEN_TEMPLATE_URL, 'dc-cloudflare', 'noopener,noreferrer')
    setTokenCreatorOpened(true)
  }

  // ── deployment progress steps ──────────────────────────────────────────────
  const deploymentSteps = [
    { name: 'connect',    label: 'Connect Database' },
    { name: 'database',   label: 'Setup Database' },
    { name: 'worker',     label: 'Configure Worker' },
    { name: 'encryption', label: 'Setup Encryption' },
    { name: 'telegram',   label: 'Connect Telegram' },
  ].map((step, i, arr) => {
    const currentIndex = arr.findIndex(s => s.name === currentStep)
    if (step.name === currentStep) return { ...step, status: 'current' }
    if (currentIndex > -1 && i < currentIndex) return { ...step, status: 'complete' }
    return { ...step, status: 'pending' }
  })

  return (
    <>
      <div className="min-h-screen dot-grid flex flex-col">

        {/* ── terminal bar ── */}
        <div className="w-full flex justify-center pt-6 px-4">
          <div className="inline-flex items-center gap-3 bg-[#111318] border border-white/[0.08] rounded-lg px-5 py-2.5">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[#FF5F57]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#FEBC2E]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[#28C840]" />
            </div>
            <span className="font-mono text-[12px] text-linear-text-secondary tracking-wide select-none">
              daemonclient deploy --personal-backend
            </span>
          </div>
        </div>

        {/* ── main card ── */}
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
                <span className="w-1.5 h-1.5 rounded-full bg-daemon-green inline-block animate-pulse" />
                Step 3 of 3 · Final step
              </div>
              <h1 className="text-2xl font-semibold text-linear-text tracking-tighter mb-2">
                Set Up Your Backend
              </h1>
              <p className="text-[13px] text-linear-text-secondary">
                Connect your free Cloudflare account — takes about 2 minutes.
              </p>
            </div>

            {/* features */}
            <div className="bg-[#111318] border border-white/[0.08] rounded-xl p-5 mb-4">
              <p className="text-[11px] font-medium text-linear-text-secondary uppercase tracking-widest mb-3">
                What you get for free
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {FEATURES.map(({ label }) => (
                  <div key={label} className="flex items-center gap-2 text-[13px] text-linear-text">
                    <Check size={14} className="text-daemon-green shrink-0" />
                    {label}
                  </div>
                ))}
              </div>
            </div>

            {/* ── Primary: one-click authorize ── */}
            <button
              onClick={handleAuthorize}
              disabled={authorizing || isDeploying}
              className="w-full flex items-center justify-center gap-2.5 bg-daemon-green hover:bg-daemon-green-hover text-white rounded-xl px-4 py-3.5 text-[14px] font-semibold transition-all duration-150 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {authorizing ? (
                <><Loader2 size={16} className="animate-spin" /> Redirecting to Cloudflare…</>
              ) : (
                <><Shield size={16} /> Authorize with Cloudflare — 1 click</>
              )}
            </button>
            <p className="text-center text-[11px] text-linear-text-secondary mt-2.5 mb-5">
              Sign in to Cloudflare and approve — we build everything automatically.
              No tokens to copy or paste.
            </p>

            {/* divider → manual fallback */}
            <div className="flex items-center gap-3 mb-5">
              <div className="flex-1 h-px bg-white/[0.08]" />
              <span className="text-[11px] text-linear-text-secondary whitespace-nowrap">or set up manually</span>
              <div className="flex-1 h-px bg-white/[0.08]" />
            </div>

            {/* step 1 — cloudflare account */}
            <div className="bg-[#111318] border border-white/[0.08] rounded-xl p-5 mb-4">
              <div className="flex items-start gap-3">
                <StepBadge n={1} />
                <div className="flex-1">
                  <p className="text-[14px] font-medium text-linear-text mb-1">
                    Create a Cloudflare account
                  </p>
                  <p className="text-[12px] text-linear-text-secondary mb-3">
                    Already have one? Skip this step.
                  </p>
                  <a
                    href="https://dash.cloudflare.com/sign-up"
                    target="dc-cloudflare"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[12px] text-linear-text-secondary hover:text-linear-text border border-white/[0.08] hover:border-white/[0.18] rounded-md px-3 py-1.5 transition-all duration-150"
                  >
                    Create Free Account <ExternalLink size={11} />
                  </a>
                </div>
              </div>
            </div>

            {/* step 2 — token creator */}
            <div className="bg-[#111318] border border-white/[0.08] rounded-xl p-5 mb-4">
              <div className="flex items-start gap-3">
                <StepBadge n={2} />
                <div className="flex-1">
                  <p className="text-[14px] font-medium text-linear-text mb-1">
                    Generate your API token
                  </p>
                  <p className="text-[12px] text-linear-text-secondary mb-3">
                    We'll open Cloudflare with all permissions{' '}
                    <span className="text-linear-text font-medium">pre-configured</span>.
                    Just click <em>Create Token</em> and paste it back here.
                  </p>

                  {!tokenCreatorOpened ? (
                    <button
                      onClick={openTokenCreator}
                      className="w-full flex items-center justify-between gap-3 bg-daemon-green/10 hover:bg-daemon-green/[0.16] border border-daemon-green/25 hover:border-daemon-green/50 text-daemon-green rounded-lg px-4 py-3 text-[13px] font-medium transition-all duration-150"
                    >
                      <span>Open Cloudflare Token Creator</span>
                      <ArrowRight size={15} />
                    </button>
                  ) : (
                    <AnimatePresence>
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25 }}
                        className="space-y-3"
                      >
                        <div className="flex items-start gap-2 text-[12px] text-linear-text-secondary bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2.5">
                          <Check size={13} className="text-daemon-green shrink-0 mt-0.5" />
                          <span>
                            Token creator opened — click <strong className="text-linear-text">Create Token</strong>, then copy and paste the token below.
                          </span>
                        </div>

                        <TokenInput
                          value={token}
                          onChange={handleTokenChange}
                          onValidate={handleValidation}
                        />

                        {isValid && accountId && (
                          <p className="text-[12px] text-daemon-green">
                            ✓ Connected · account {accountId.slice(0, 8)}…
                          </p>
                        )}

                        <button
                          onClick={openTokenCreator}
                          className="inline-flex items-center gap-1.5 text-[11px] text-linear-text-secondary hover:text-linear-text transition-colors"
                        >
                          <ExternalLink size={11} />
                          Re-open token creator
                        </button>
                      </motion.div>
                    </AnimatePresence>
                  )}
                </div>
              </div>
            </div>

            {/* store-token checkbox — only visible once valid */}
            <AnimatePresence>
              {isValid && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="flex items-start gap-2.5 mb-4 px-1">
                    <input
                      type="checkbox"
                      id="storeToken"
                      checked={storeToken}
                      onChange={e => setStoreToken(e.target.checked)}
                      className="mt-0.5 accent-daemon-green cursor-pointer"
                    />
                    <label htmlFor="storeToken" className="text-[12px] text-linear-text-secondary cursor-pointer">
                      Store encrypted token for automatic updates (recommended)
                    </label>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* deploy button */}
            <button
              onClick={handleDeploy}
              disabled={!isValid || isDeploying}
              className="w-full h-10 rounded-lg text-sm font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed bg-daemon-green hover:bg-daemon-green-hover text-white shadow-sm flex items-center justify-center gap-2"
            >
              {isDeploying ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Deploying your backend…
                </>
              ) : (
                'Deploy My Backend'
              )}
            </button>

            <p className="text-center text-[11px] text-linear-text-secondary mt-4 leading-relaxed">
              Your data lives in <span className="text-linear-text">your</span> Cloudflare account · We never see your files
            </p>
          </motion.div>
        </div>
      </div>

      {/* Keep the modal mounted on FAILURE too: the hook sets isDeploying
          false in its catch, so gating on isDeploying alone unmounted the
          modal the instant an error happened -- deploy failures were totally
          invisible and the page just "reset". Retry re-runs the deployment
          in place with the validated token intact (no reload). */}
      {(isDeploying || error) && (
        <DeploymentProgress
          isOpen={isDeploying || !!error}
          steps={deploymentSteps}
          currentStep={deploymentSteps.findIndex(s => s.name === currentStep)}
          error={error ? { title: 'Deployment failed', message: error } : null}
          onRetry={handleDeploy}
        />
      )}
    </>
  )
}

function StepBadge({ n }) {
  return (
    <div className="w-6 h-6 rounded-full bg-white/[0.05] border border-white/[0.1] flex items-center justify-center shrink-0 text-[11px] font-medium text-linear-text-secondary mt-0.5">
      {n}
    </div>
  )
}
