import { ConvexHttpClient } from "convex/browser";

const URL = import.meta.env.VITE_CONVEX_URL as string | undefined;

let client: ConvexHttpClient | null = null;
let token: string | null = null;

export function getConvexClient(): ConvexHttpClient | null {
  if (!URL) return null;
  if (!client) client = new ConvexHttpClient(URL);
  return client;
}

/** Copy the auth provider's token into module land. The fire-and-forget
 *  ConvexHttpClient and the /api/* Bearer header both need the JWT outside
 *  React state. The React provider refreshes tokens on its own schedule;
 *  access tokens live ~1h, so a set token stays valid between refreshes. */
export function setAuthToken(next: string | null): void {
  token = next;
  if (next) {
    // First real token has landed — release anything waiting for it.
    const waiters = tokenWaiters;
    tokenWaiters = null;
    waiters?.forEach((w) => w());
  }
  const c = getConvexClient();
  if (!c) return;
  if (next) c.setAuth(next);
  else c.clearAuth();
}

/** Waiters parked until the module client holds an auth token. */
let tokenWaiters: (() => void)[] | null = null;

/** Resolves true once setAuthToken has received a token, false on timeout.
 *
 *  Boot needs this: the auth provider flips isAuthenticated in the same
 *  render commit where AuthBridge's effect copies the token into this
 *  module client, and React runs child effects before parent effects —
 *  so the first workspace:list could fire unauthenticated, come back as
 *  an empty list, and boot would then mint a stray empty default-named
 *  instead of opening the user's files (observed in production). */
export function waitForAuthToken(timeoutMs = 5000): Promise<boolean> {
  if (token) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiter = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      tokenWaiters = (tokenWaiters ?? []).filter((w) => w !== waiter);
      resolve(false);
    }, timeoutMs);
    tokenWaiters = [...(tokenWaiters ?? []), waiter];
  });
}

export function authToken(): string | null {
  return token;
}

/** Decode a JWT's `exp` (seconds) without verifying the signature — a
 *  client-side freshness estimate only, used to decide whether the first
 *  Convex query can safely reuse the cached token. */
function jwtExpiry(jwt: string): number | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when the cached access token is missing, unreadable, or within the
 *  refresh leeway of expiry. Convex Auth persists the JWT in localStorage and
 *  only rotates it on a schedule while a client is connected; a page load
 *  after the token has lapsed still presents the stale JWT as
 *  `isAuthenticated`, and a query sent with it reads as unauthenticated
 *  (empty) until the React client's background refresh lands. */
function tokenExpiringSoon(leewaySeconds = 60): boolean {
  if (!token) return true;
  const exp = jwtExpiry(token);
  if (exp === null) return true;
  return exp - Date.now() / 1000 <= leewaySeconds;
}

/** Boot guard: hold until the module client has an auth token the backend
 *  will actually accept. waitForAuthToken only proves a token exists — the
 *  stored JWT can be expired on a cold load, in which case the first
 *  workspace:list reads as empty and boot mints a stray default-named file
 *  instead of opening the user's documents (observed in production). Force a
 *  refresh through AuthBridge's fetchAccessToken when the token is stale. */
export async function ensureAuthTokenReady(): Promise<void> {
  await waitForAuthToken(5000);
  if (!tokenExpiringSoon()) return;
  // Bounded: a hung refresh must not wedge boot on the loading screen. On
  // timeout we fall back to the cached token and let the query's own retry
  // path recover.
  const fresh = await Promise.race([
    refreshAuthToken(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  if (fresh) setAuthToken(fresh);
}

/** AuthBridge registers the provider's fetchAccessToken here so non-React
 *  code (api.ts) can force a fresh JWT when an edge call comes back 401. */
let refresher: (() => Promise<string | null>) | null = null;

export function registerTokenRefresher(fn: () => Promise<string | null>): void {
  refresher = fn;
}

export async function refreshAuthToken(): Promise<string | null> {
  if (!refresher) return null;
  try {
    return await refresher();
  } catch {
    return null;
  }
}