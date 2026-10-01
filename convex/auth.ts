import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

// process isn't in the app-side type graph (this file is pulled into the
// Vite tsconfig via _generated/api), so reach for it untyped.
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;

function siteUrl(): string {
  const url = env?.SITE_URL;
  if (!url) throw new Error("Missing SITE_URL env var");
  return url.replace(/\/$/, "");
}

/** Where the OAuth callback may land. Default Convex Auth behavior pins this
 *  to SITE_URL's origin, but the dev flow opens from localhost AND Tailscale
 *  hostnames (fedora-1, 100.x CGNAT) on several machines — allow those
 *  explicitly instead of an open redirect. */
function isAllowedOrigin(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "fedora-1" ||
    hostname.endsWith(".ts.net") ||
    hostname === "mathtex.vercel.app" ||
    hostname.endsWith(".vercel.app") ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)
  );
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Google],
  callbacks: {
    async redirect({ redirectTo }) {
      if (redirectTo.startsWith("?") || redirectTo.startsWith("/")) {
        return `${siteUrl()}${redirectTo}`;
      }
      let url: URL;
      try {
        url = new URL(redirectTo);
      } catch {
        throw new Error(`Invalid redirect target: ${redirectTo.slice(0, 120)}`);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error(`Invalid redirect protocol: ${url.protocol}`);
      }
      if (!isAllowedOrigin(url.hostname)) {
        throw new Error(`Redirect origin not allowed: ${url.hostname}`);
      }
      return redirectTo;
    },
  },
});