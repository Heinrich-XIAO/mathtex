# Agent instructions

## Deploying

This Vercel project is NOT Git-connected — pushing to `main` does NOT auto-deploy. When asked to "commit and push" (or any wording implying shipping changes), always finish with a manual production deploy:

```
npx vercel --prod
```

Then verify the deployment reaches `● Ready` (e.g. `npx vercel ls`). The Vercel CLI is already authenticated in this environment.

Server-side logs from the `api/` edge functions are viewable with `npx vercel logs <deployment-url>` or the Vercel dashboard (Functions tab).
