import { useEffect, type ReactNode } from 'react'
import { useConvexAuth, useAuthToken } from '@convex-dev/auth/react'
import { setAuthToken, registerTokenRefresher } from './lib/authClient'

/** Copies the auth provider's token into module land (persist client +
 *  /api/* Bearer header) and nudges a refresh every 10 min so a long-idle
 *  session never holds an expired access token.
 *
 *  A transient null must never blank a still-valid token: useAuthToken()
 *  flips to null while a forced refresh re-resolves, and fetchAccessToken()
 *  resolves null if the refresh request itself fails — clearing then would
 *  leave every /api/* call unauthenticated for up to 10 min (the observed
 *  "no bearer token" 401 bursts). Clear only when genuinely signed out. */
export default function AuthBridge({ children }: { children: ReactNode }) {
  const token = useAuthToken()
  const { isLoading, isAuthenticated, fetchAccessToken } = useConvexAuth()
  useEffect(() => {
    if (token) setAuthToken(token)
    else if (!isLoading && !isAuthenticated) setAuthToken(null)
  }, [token, isLoading, isAuthenticated])
  useEffect(() => {
    const refresh = () =>
      fetchAccessToken({ forceRefreshToken: true })
        .then((t) => {
          if (t) setAuthToken(t)
          return t
        })
        .catch(() => null)
    registerTokenRefresher(refresh)
    const id = setInterval(() => {
      void refresh()
    }, 10 * 60 * 1000)
    return () => clearInterval(id)
  }, [fetchAccessToken])
  return children
}