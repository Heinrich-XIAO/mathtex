// Shared forwarding logic for the /api/* Edge functions.
// Forwards to the upstream OpenAI-compatible endpoint and injects the
// Authorization header server-side so the key never reaches the browser.
// UPSTREAM_BASE_URL lets prod use a different provider than local dev.
// Edge runtime: Web Request/Response, streams pass-through natively.
const TARGET = process.env.UPSTREAM_BASE_URL;

export async function proxy(request, subpath) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!TARGET || !key) {
    return new Response(
      JSON.stringify({ error: { message: "Missing UPSTREAM_BASE_URL or OPENROUTER_API_KEY env vars" } }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  for (const p of [...params.keys()]) {
    if (p.startsWith("x-vercel-")) params.delete(p);
  }
  const qs = params.size ? `?${params}` : "";

  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    try {
      body = JSON.stringify(JSON.parse(raw));
    } catch {
      body = raw; // forward as-is (e.g. warm-up "{}" pings)
    }
  }

  try {
    const upstream = await fetch(`${TARGET}/${subpath}${qs}`, {
      method: request.method,
      headers: {
        "Content-Type": request.headers.get("content-type") || "application/json",
        Authorization: `Bearer ${key}`,
      },
      body,
    });

    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("Content-Type", ct);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: { message: `Upstream error: ${String(e).slice(0, 200)}` } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}