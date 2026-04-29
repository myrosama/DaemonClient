import { useState } from 'react'
import { auth, db } from '../config/firebase'
import firebase from '../config/firebase'

// Central deployment worker handles the setup orchestration,
// but deploys everything (D1, Worker) to the USER's own Cloudflare account
const DEPLOYMENT_WORKER = 'https://daemonclient-deployment.sadrikov49.workers.dev'
const APP_ID = 'default-daemon-client'

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
    if (isValid) {
      setIsValid(false)
      setAccountId('')
    }
  }

  const handleValidation = (data: any) => {
    setIsValid(data.valid)
    setAccountId(data.accountId || '')
  }

  const startDeployment = async () => {
    if (!token || !isValid || !accountId) return

    setIsDeploying(true)
    setError(null)
    setCurrentStep('connect')

    try {
      const user = auth.currentUser
      if (!user) throw new Error('Not authenticated')

      const idToken = await user.getIdToken()

      // Call central deployment worker — it uses the user's API token
      // to deploy D1 + Worker to the user's OWN Cloudflare account
      setCurrentStep('database')
      const response = await fetch(`${DEPLOYMENT_WORKER}/deploy-worker`, {
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

      // Update local UI steps
      setCurrentStep('worker')
      await sleep(1500)

      setCurrentStep('encryption')
      await sleep(1500)

      setCurrentStep('telegram')
      await sleep(1000)

      // Save service status to Firestore
      try {
        await db.doc(`artifacts/${APP_ID}/users/${user.uid}/services/photos`).set({
          workerUrl: data.workerUrl,
          status: 'active',
          setupTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true })
      } catch (e) {
        console.warn('Failed to save service status:', e)
      }

      setCurrentStep('complete')
      setIsDeploying(false)
      return data

    } catch (err: any) {
      console.error('Deployment error:', err)
      setError(err.message || 'Deployment failed')
      setCurrentStep(null)
      setIsDeploying(false)
      throw err
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
    startDeployment,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
