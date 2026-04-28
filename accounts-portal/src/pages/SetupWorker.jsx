import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Button } from '../components/ui/Button'
import { Card } from '../components/ui/Card'
import { TokenInput } from '../components/TokenInput'
import { DeploymentProgress } from '../components/DeploymentProgress'
import { useWorkerSetup } from '../hooks/useWorkerSetup'
import { ExternalLink, Check, Loader2 } from 'lucide-react'

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
    startDeployment
  } = useWorkerSetup()

  const [storeToken, setStoreToken] = useState(true)

  const handleDeploy = async () => {
    try {
      await startDeployment()
      // On success, redirect to dashboard
      setTimeout(() => navigate('/dashboard'), 2000)
    } catch (err) {
      console.error('Deployment error:', err)
    }
  }

  // Define the steps for the deployment progress
  const deploymentSteps = [
    { name: 'connect', label: 'Connect Database', status: 'pending' },
    { name: 'database', label: 'Setup Database', status: 'pending' },
    { name: 'worker', label: 'Configure Worker', status: 'pending' },
    { name: 'encryption', label: 'Setup Encryption', status: 'pending' },
    { name: 'telegram', label: 'Connect Telegram', status: 'pending' }
  ]

  // Update step statuses based on current step
  const updatedSteps = deploymentSteps.map(step => {
    if (step.name === currentStep) {
      return { ...step, status: 'current' }
    }
    const stepIndex = deploymentSteps.findIndex(s => s.name === step.name)
    const currentIndex = deploymentSteps.findIndex(s => s.name === currentStep)
    if (currentIndex > -1 && stepIndex < currentIndex) {
      return { ...step, status: 'complete' }
    }
    return step
  })

  return (
    <>
      <div className="min-h-screen flex items-center justify-center bg-linear-bg px-4">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="w-full max-w-2xl"
        >
          <div className="text-center mb-8">
            <div className="w-10 h-10 rounded-xl bg-linear-purple flex items-center justify-center mx-auto mb-5">
              <span className="text-white text-lg font-bold">3</span>
            </div>
            <h1 className="text-xl font-semibold text-linear-text tracking-tighter">
              Set Up Your Personal Backend
            </h1>
            <p className="text-[13px] text-linear-text-secondary mt-1">
              Step 3 of 3 · Final step!
            </p>
          </div>

          <Card className="p-6 mb-6">
            <h2 className="text-[15px] font-medium text-linear-text mb-3">
              Your Private Backend
            </h2>
            <p className="text-[13px] text-linear-text-secondary mb-4">
              To give you unlimited storage, we'll set up your personal backend server.
              It's completely free and takes 2 minutes!
            </p>

            <div className="grid grid-cols-2 gap-3 mb-6">
              {[
                '100,000 requests/day',
                '5 million photo loads/day',
                '5GB database storage',
                'Automatic updates'
              ].map(feature => (
                <div key={feature} className="flex items-center gap-2 text-[12px] text-linear-text-secondary">
                  <Check size={14} className="text-linear-success shrink-0" />
                  {feature}
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-6 mb-6">
            <h3 className="text-[15px] font-medium text-linear-text mb-4">
              Step 1: Create Your Cloudflare Account
            </h3>
            <p className="text-[13px] text-linear-text-secondary mb-3">
              Cloudflare provides your free backend server.
            </p>
            <a
              href="https://dash.cloudflare.com/sign-up"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-[13px] text-linear-purple hover:text-linear-purple-hover transition-colors"
            >
              Create Free Account
              <ExternalLink size={12} />
            </a>
          </Card>

          <Card className="p-6 mb-6">
            <h3 className="text-[15px] font-medium text-linear-text mb-4">
              Step 2: Get Your API Token
            </h3>

            <div className="space-y-3 text-[13px] text-linear-text-secondary mb-4">
              <p>1. Go to <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="text-linear-purple hover:underline">Cloudflare Dashboard → API Tokens</a></p>
              <p>2. Click "Create Token"</p>
              <p>3. Use these permissions:</p>
              <ul className="ml-6 space-y-1 text-[12px]">
                <li>• Workers Scripts (Edit)</li>
                <li>• D1 Database (Edit)</li>
                <li>• Account Settings (Read)</li>
              </ul>
              <p>4. Copy the token and paste it below</p>
            </div>

            <TokenInput
              value={token}
              onChange={handleTokenChange}
              onValidate={handleValidation}
            />

            {isValid && accountId && (
              <p className="text-[12px] text-linear-success mt-2">
                ✓ Account ID: {accountId}
              </p>
            )}

            <div className="mt-4 flex items-start gap-2">
              <input
                type="checkbox"
                id="storeToken"
                checked={storeToken}
                onChange={(e) => setStoreToken(e.target.checked)}
                className="mt-1"
              />
              <label htmlFor="storeToken" className="text-[12px] text-linear-text-secondary">
                Store encrypted token for automatic updates (recommended)
              </label>
            </div>
          </Card>

          <Button
            onClick={handleDeploy}
            disabled={!isValid || isDeploying}
            className="w-full"
          >
            {isDeploying ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Deploying...
              </span>
            ) : (
              'Deploy My Backend'
            )}
          </Button>

          <div className="mt-6 p-4 bg-white/[0.02] border border-white/[0.06] rounded-md">
            <p className="text-[11px] text-linear-text-secondary">
              <strong className="text-linear-text">Security & Privacy:</strong>
              <br />
              Your photos stay in YOUR Telegram channel · Your data stays in YOUR Cloudflare account
              · We NEVER see your photos or data · API token is encrypted and stored securely
              · You can revoke access anytime
            </p>
          </div>
        </motion.div>
      </div>

      {isDeploying && (
        <DeploymentProgress
          isOpen={isDeploying}
          steps={updatedSteps}
          currentStep={deploymentSteps.indexOf(deploymentSteps.find(s => s.name === currentStep))}
          error={error ? { title: 'Deployment failed', message: error } : null}
          onRetry={() => window.location.reload()}
        />
      )}
    </>
  )
}
