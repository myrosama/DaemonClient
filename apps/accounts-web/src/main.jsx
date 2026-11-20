import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter'
import './index.css'
import App from './App.jsx'
import { ToastProvider } from './components/ui/Toast'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <ToastProvider />
  </StrictMode>,
)
