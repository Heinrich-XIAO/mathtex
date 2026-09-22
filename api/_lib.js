// Shared forwarding logic for /api/* Vercel functions.
// Forwards to the upstream OpenAI-compatible endpoint and injects the
// Authorization header server-side so the key never reaches the browser.
const TARGET = process.env.UPSTREAM_BASE_URL;

export async function proxy(req, res, subpath) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!TARGET || !key) {
    res.status(500).json({
      error: { message: "Missing UPSTREAM_BASE_URL or OPENROUTER_API_KEY env vars" },
    });
    return;
  }

  const url = req.url || "";
  const params = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
  for (const p of [...params.keys()]) {
    if (p.startsWith("x-vercel-")) params.delete(p);
  }
  const qs = params.size ? `?${params}` : "";

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