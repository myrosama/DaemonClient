import { useState } from 'react'
import { auth } from '../config/firebase'

export interface DeploymentStep {
  key: string
  status: 'pending' | 'active' | 'complete' | 'error'
}

export function useWorkerSetup() {
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [isValid, setIsValid] = useState(false)
  const [isDeploying, setIsDeploying] = useState(false)
  const [currentStep, setCurrentStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleTokenChange = (newToken: string) => {
    setToken(newToken)
  }

  const handleValidation = (data: any) => {
    setIsValid(data.valid)
    setAccountId(data.accountId || '')
  }

  const startDeployment = async () => {
    if (!token || !isValid) return

    setIsDeploying(true)
    setError(null)
    setCurrentStep('connect')

    try {
      const user = auth.currentUser
      if (!user) throw new Error('Not authenticated')

      const idToken = await user.getIdToken()

      // Call deployment endpoint
      const response = await fetch('/api/deploy-worker', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`
        },
        body: JSON.stringify({
          apiToken: token,
          accountId
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Deployment failed')
      }

      // Track deployment progress via polling or SSE
      await trackDeploymentProgress(data.deploymentId)

      setCurrentStep('complete')
      return data

    } catch (err: any) {
      setError(err.message || 'Deployment failed')
      setIsDeploying(false)
      throw err
    }
  }

  async function trackDeploymentProgress(deploymentId: string) {
    const steps = ['connect', 'database', 'worker', 'encryption', 'telegram']

    for (const step of steps) {
      setCurrentStep(step)
      // Simulate progress (in real implementation, poll /api/deployment-status)
      await new Promise(resolve => setTimeout(resolve, 6000))
    }
  }

  return {
    token,
    accountId,
    isValid,
    isDeploying,
    currentStep,
    error,
    handleTokenChange,
    handleValidation,
    startDeployment
  }
}
