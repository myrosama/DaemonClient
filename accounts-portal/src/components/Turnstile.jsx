import { useEffect, useRef } from 'react'

// Cloudflare Turnstile. Site keys are public by design — the secret lives only
// in TURNSTILE_SECRET on the server, and a token is worthless until siteverify
// accepts it there.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAEFVpV4fsxGjIqfO'

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let scriptPromise = null

// Explicit rendering rather than the auto-scan `.cf-turnstile` behaviour: this
// is a SPA, so the div does not exist when api.js first parses the document,
// and React can unmount and remount the form at any time.
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.async = true
    script.defer = true
    script.onload = () => resolve(window.turnstile)
    script.onerror = () => { scriptPromise = null; reject(new Error('turnstile script failed to load')) }
    document.head.appendChild(script)
  })
  return scriptPromise
}

/**
 * Renders the widget and reports its token upward.
 *
 * Tokens are single-use: once siteverify redeems one, submitting it again is
 * rejected as timeout-or-duplicate. The parent calls reset() through `resetRef`
 * after any failed submit so a retry gets a fresh token instead of a confusing
 * second rejection.
 */
export default function Turnstile({ onToken, resetRef, className = '' }) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)
  const onTokenRef = useRef(onToken)
  onTokenRef.current = onToken

  useEffect(() => {
    let cancelled = false
    loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !containerRef.current || widgetIdRef.current !== null) return
        widgetIdRef.current = turnstile.render(containerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          action: 'turnstile-spin-v2',
          callback: (token) => onTokenRef.current?.(token),
          // A token expires after ~5 minutes. Clear it so a stale one is never
          // submitted, and let the widget fetch another.
          'expired-callback': () => onTokenRef.current?.(''),
          'error-callback': () => onTokenRef.current?.(''),
        })
        if (resetRef) {
          resetRef.current = () => {
            try {
              window.turnstile?.reset(widgetIdRef.current)
              onTokenRef.current?.('')
            } catch { /* widget already gone */ }
          }
        }
      })
      .catch(() => {
        // Script blocked (extension, offline). Leave the token empty — the
        // server refuses the request, which is the correct failure direction.
      })
    return () => {
      cancelled = true
      if (widgetIdRef.current !== null) {
        try { window.turnstile?.remove(widgetIdRef.current) } catch { /* already gone */ }
        widgetIdRef.current = null
      }
      if (resetRef) resetRef.current = null
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className={`cf-turnstile ${className}`}
      data-sitekey={TURNSTILE_SITE_KEY}
      data-action="turnstile-spin-v2"
    />
  )
}
