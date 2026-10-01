import { useEffect, type ReactNode } from 'react'
import { useConvexAuth, useAuthToken } from '@convex-dev/auth/react'
import { setAuthToken } from './lib/authClient'

/** Copies the auth provider's token into module land (persist client +
 *  /api/* Bearer header) and nudges a refresh every 10 min so a long-idle
 *  session never holds an expired access token. */
export default function AuthBridge({ children }: { children: ReactNode }) {
  const token = useAuthToken()
  const { fetchAccessToken } = useConvexAuth()
  useEffect(() => {
    setAuthToken(token)
  }, [token])
  useEffect(() => {
    const id = setInterval(() => {
      void fetchAccessToken({ forceRefreshToken: true }).then((t) => setAuthToken(t))
    }, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [fetchAccessToken])
  return children
}