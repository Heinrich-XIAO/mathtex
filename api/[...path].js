// Catch-all Vercel function: forwards /api/* to the upstream OpenAI-compatible
// endpoint and injects the Authorization header server-side so the key never
// reaches the browser. Mirrors the Vite dev/preview proxy (see vite.config.ts).
// ESM: package.json has "type": "module".
// UPSTREAM_BASE_URL lets prod use a different provider than local dev
// (e.g. openrouter.ai — the Hack Club proxy blocks datacenter IPs).
const TARGET = process.env.UPSTREAM_BASE_URL || "https://ai.hackclub.com/proxy/v1";

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    res.status(500).json({ error: { message: "Missing OPENROUTER_API_KEY env var" } });
    return;
  }

  const subpath = Array.isArray(req.query.path)
    ? req.query.path.join("/")
    : req.query.path || "";
  const url = req.url || "";
  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";

  try {
    const upstream = await fetch(`${TARGET}/${subpath}${qs}`, {
      method: req.method,
      headers: {
        "Content-Type": req.headers["content-type"] || "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body),
    });

    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.send(await upstream.text());
  } catch (e) {
    res.status(502).json({ error: { message: `Upstream error: ${String(e).slice(0, 200)}` } });
  }
}