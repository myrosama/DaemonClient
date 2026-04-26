import { Toaster } from 'sonner'

export function ToastProvider() {
  return (
    <Toaster
      theme="dark"
      position="top-right"
      toastOptions={{
        style: {
          background: '#1C1D22',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          color: '#FAFAFA',
        },
        className: 'sonner-toast',
      }}
    />
  )
}

export { toast } from 'sonner'
