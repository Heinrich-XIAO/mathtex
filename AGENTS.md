# Agent instructions

## Deploying

This Vercel project IS Git-connected to `github.com/Heinrich-XIAO/mathtex`. Pushing to `main` auto-deploys to production; pushing to any other branch creates a preview deployment. No manual deploy is needed — just commit and push:

```
git push origin main
```

Verify the deployment reaches `● Ready` (e.g. `npx vercel ls`). The Vercel CLI is already authenticated in this environment.

Server-side logs from the `api/` edge functions are viewable with `npx vercel logs <deployment-url>` or the Vercel dashboard (Functions tab).
