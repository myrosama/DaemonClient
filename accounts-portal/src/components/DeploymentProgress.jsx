import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, Loader2, Circle, X } from 'lucide-react'
import { Card } from './ui/Card'
import { Button } from './ui/Button'

export function DeploymentProgress({
  isOpen,
  steps = [],
  currentStep = 0,
  error = null,
  onRetry = null
}) {
  const STEP_LABELS = {
    connect: 'Connect Database',
    database: 'Setup Database',
    worker: 'Configure Worker',
    encryption: 'Setup Encryption',
    telegram: 'Connect Telegram',
    complete: 'Complete',
  }

  const getStepIcon = (index) => {
    const step = steps[index]

    if (!step) {
      return <Circle size={16} className="text-linear-text-secondary" strokeWidth={1.5} />
    }

    if (step.status === 'complete') {
      return <Check size={16} className="text-linear-success" strokeWidth={2} />
    }

    if (step.status === 'current') {
      return <Loader2 size={16} className="animate-spin text-linear-purple" strokeWidth={1.8} />
    }

    return <Circle size={16} className="text-linear-text-secondary" strokeWidth={1.5} />
  }

  const getStepColor = (index) => {
    const step = steps[index]

    if (!step) {
      return 'text-linear-text-secondary'
    }

    if (step.status === 'complete') {
      return 'text-linear-success'
    }

    if (step.status === 'current') {
      return 'text-linear-text'
    }

    return 'text-linear-text-secondary'
  }

  const progressPercentage = (currentStep / (steps.length || 1)) * 100

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="w-full max-w-[420px] mx-4"
          >
            <Card className="p-6">
              {/* Header */}
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-linear-text tracking-tighter">
                  {error ? 'Deployment Failed' : 'Setting Up Your System'}
                </h2>
                <p className="text-[13px] text-linear-text-secondary mt-1">
                  {error
                    ? 'An error occurred during deployment'
                    : 'We are configuring your cloud infrastructure'}
                </p>
              </div>

              {/* Progress Bar */}
              {!error && (
                <div className="mb-6">
                  <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${progressPercentage}%` }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                      className="h-full bg-linear-purple rounded-full"
                    />
                  </div>
                  <p className="text-[11px] text-linear-text-secondary mt-2 text-center">
                    {currentStep} of {steps.length} steps
                  </p>
                </div>
              )}

              {/* Steps List */}
              {!error ? (
                <div className="space-y-3 mb-6">
                  {steps.map((step, index) => (
                    <motion.div
                      key={index}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="flex items-start gap-3"
                    >
                      <div className="shrink-0 mt-0.5">
                        {getStepIcon(index)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[13px] font-medium ${getStepColor(index)}`}>
                          {step.label || STEP_LABELS[step.name] || step.name}
                        </p>
                        {step.message && (
                          <p className="text-[12px] text-linear-text-secondary mt-0.5">
                            {step.message}
                          </p>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="mb-6 p-4 bg-linear-error/10 border border-linear-error/20 rounded-md">
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 mt-0.5">
                      <X size={16} className="text-linear-error" strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] text-linear-error font-medium">
                        {error.title || 'Deployment Error'}
                      </p>
                      {error.message && (
                        <p className="text-[12px] text-linear-error/80 mt-1">
                          {error.message}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Retry Button (only on error) */}
              {error && onRetry && (
                <Button
                  onClick={onRetry}
                  className="w-full"
                >
                  Retry Deployment
                </Button>
              )}

              {/* Closing hint (for non-error states) */}
              {!error && (
                <p className="text-[11px] text-linear-text-secondary text-center">
                  Please wait while we complete the setup...
                </p>
              )}
            </Card>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
