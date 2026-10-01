import { useAuthActions } from "@convex-dev/auth/react";

export default function Landing() {
  const { signIn } = useAuthActions();
  // Return to wherever the app was opened from (localhost dev, a Tailscale
  // host, prod) — the server side allowlists the origins in convex/auth.ts.
  const onClick = () => void signIn("google", { redirectTo: window.location.href });
  return (
    <div className="landing">
      <div className="landing-card">
        <div className="landing-mark">∫</div>
        <h1>MathTex</h1>
        <p className="landing-tagline">Say the math out loud. Get LaTeX.</p>
        <button className="landing-google" onClick={onClick}>
          <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden>
            <path
              fill="#4285F4"
              d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.29a5.38 5.38 0 0 1-2.34 3.53v2.93h3.79c2.22-2.04 3.76-5.05 3.76-8.65z"
            />
            <path
              fill="#34A853"
              d="M12 24c3.17 0 5.83-1.05 7.74-2.86l-3.79-2.93c-1.05.71-2.39 1.12-3.95 1.12-3.05 0-5.63-2.06-6.55-4.83H1.55v3.03A12 12 0 0 0 12 24z"
            />
            <path
              fill="#FBBC05"
              d="M5.45 14.5a7.2 7.2 0 0 1 0-4.6V6.87H1.55a12 12 0 0 0 0 10.66l3.9-3.03z"
            />
            <path
              fill="#EA4335"
              d="M12 4.67c1.72 0 3.26.59 4.47 1.75l3.35-3.35C17.82 1.18 15.17 0 12 0A12 12 0 0 0 1.55 6.87l3.9 3.03C6.37 6.73 8.95 4.67 12 4.67z"
            />
          </svg>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}