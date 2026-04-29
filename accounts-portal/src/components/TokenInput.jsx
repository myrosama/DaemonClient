import { useState, useEffect, useRef } from 'react'
import { Input } from './ui/Input'
import { Check, X, Loader2 } from 'lucide-react'

const DEPLOYMENT_WORKER = 'https://daemonclient-deployment.sadrikov49.workers.dev'

export function TokenInput({ value, onChange, onValidate }) {
  const [validationState, setValidationState] = useState('idle') // 'idle' | 'validating' | 'valid' | 'invalid'
  const [error, setError] = useState('')
  const onValidateRef = useRef(onValidate)
  onValidateRef.current = onValidate

  useEffect(() => {
    if (!value || value.length < 20) {
      setValidationState('idle')
      return
    }

    const timeoutId = setTimeout(async () => {
      setValidationState('validating')

      try {
        // Validate via central deployment worker (proxies to Cloudflare API, no CORS issues)
        const response = await fetch(`${DEPLOYMENT_WORKER}/validate-cf-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: value })
        })

        const data = await response.json()

        if (data.valid) {
          setValidationState('valid')
          setError('')
          onValidateRef.current?.(data)
        } else {
          setValidationState('invalid')
          setError(data.error || 'Invalid token')
        }
      } catch (err) {
        setValidationState('invalid')
        setError('Failed to validate token. Please try again.')
      }
    }, 600)

    return () => clearTimeout(timeoutId)
  }, [value])

  return (
    <div>
      <label className="block text-[13px] text-linear-text-secondary mb-1.5">
        Cloudflare API Token
      </label>

      <div className="relative">
        <Input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Paste your API token here"
          error={validationState === 'invalid'}
          className="w-full pr-10"
        />

        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          {validationState === 'validating' && (
            <Loader2 size={16} className="animate-spin text-linear-text-secondary" />
          )}
          {validationState === 'valid' && (
            <Check size={16} className="text-linear-success" />
          )}
          {validationState === 'invalid' && (
            <X size={16} className="text-linear-error" />
          )}
        </div>
      </div>

      {validationState === 'invalid' && error && (
        <p className="text-[12px] text-linear-error mt-1.5">{error}</p>
      )}

      {validationState === 'valid' && (
        <p className="text-[12px] text-linear-success mt-1.5">
          ✓ Token validated successfully
        </p>
      )}
    </div>
  )
}
