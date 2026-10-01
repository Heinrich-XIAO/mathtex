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
  const c = getConvexClient();
  if (!c) return;
  if (next) c.setAuth(next);
  else c.clearAuth();
}

export function authToken(): string | null {
  return token;
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