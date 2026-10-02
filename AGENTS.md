# Agent instructions

## Deploying

This Vercel project IS Git-connected to `github.com/Heinrich-XIAO/mathtex`. Pushing to `main` auto-deploys to production; pushing to any other branch creates a preview deployment. No manual deploy is needed — just commit and push:

```
git push origin main
```

Verify the deployment reaches `● Ready` (e.g. `npx vercel ls`). The Vercel CLI is already authenticated in this environment.

Server-side logs from the `api/` edge functions are viewable with `npx vercel logs <deployment-url>` or the Vercel dashboard (Functions tab).

## Recording demos / screencasts

Use `node scripts/demo.mjs` (see `.opencode/skills/demo-recording/SKILL.md`). It drives the app in headless Chromium with a fake microphone and writes an MP4. Note: the app is Google-OAuth gated; the tool records the auth wall and prints unblock instructions when run without a session token (`--token`/`--storage-state`). Never mint tokens from deployment secrets.
