import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConvexAuthProvider } from '@convex-dev/auth/react'
import { ConvexReactClient } from 'convex/react'
import './index.css'
import 'katex/dist/katex.min.css'
import App from './App.tsx'
import AuthBridge from './AuthBridge.tsx'

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {CONVEX_URL ? (
      <ConvexAuthProvider client={new ConvexReactClient(CONVEX_URL)}>
        <AuthBridge>
          <App />
        </AuthBridge>
      </ConvexAuthProvider>
    ) : (
      <App />
    )}
  </StrictMode>,
)