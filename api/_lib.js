// Shared forwarding logic for the /api/* Edge functions.
// Forwards to the upstream OpenAI-compatible endpoint and injects the
// Authorization header server-side so the key never reaches the browser.
// UPSTREAM_BASE_URL lets prod use a different provider than local dev.
// Edge runtime: Web Request/Response, streams pass-through natively.
const TARGET = process.env.UPSTREAM_BASE_URL;
// Public half of the Convex Auth keypair: verifies the Bearer JWT the client
// sends on every /api/* call, so only signed-in users spend upstream credits.
const JWT_PUBLIC_KEY = process.env.AUTH_JWT_PUBLIC_KEY;

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function pemToSpkiBytes(pem) {
  const body = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  return b64urlToBytes(body);
}

/** Verify the Convex Auth JWT: RS256 signature against AUTH_JWT_PUBLIC_KEY,
 *  exp window, aud "convex". Returns the subject (user id) or null. */
export async function verifyAuth(request) {
  if (!JWT_PUBLIC_KEY) {
    console.log(JSON.stringify({ auth: "fail", reason: "no public key configured" }));
    return null;
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    console.log(JSON.stringify({ auth: "fail", reason: "no bearer token" }));
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    console.log(JSON.stringify({ auth: "fail", reason: "malformed token" }));
    return null;
  }
  const [h, p, sig] = parts;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  } catch {
    console.log(JSON.stringify({ auth: "fail", reason: "bad payload" }));
    return null;
  }
  if ((payload.exp ?? 0) * 1000 < Date.now()) {
    console.log(JSON.stringify({ auth: "fail", reason: "expired" }));
    return null;
  }
  if (payload.aud !== "convex") {
    console.log(JSON.stringify({ auth: "fail", reason: `aud ${String(payload.aud)}` }));
    return null;
  }
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToSpkiBytes(JWT_PUBLIC_KEY),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) {
      console.log(JSON.stringify({ auth: "fail", reason: "bad signature" }));
      return null;
    }
    return payload.sub ?? null;
  } catch (e) {
    console.log(JSON.stringify({ auth: "fail", reason: `crypto: ${String(e).slice(0, 120)}` }));
    return null;
  }
}

export function unauthorized(reason) {
  console.log(JSON.stringify({ auth: "rejected", reason }));
  return Response.json(
    { error: { message: "Sign in to use MathTex", code: "unauthorized" } },
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

export async function proxy(request, subpath) {
  const t0 = Date.now();
  const userId = await verifyAuth(request);
  if (!userId) return unauthorized("missing/invalid/expired token");
  const vad = request.headers.get("x-vad-stats") || undefined;
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
  let model;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const raw = await request.text();
    try {
      const parsed = JSON.parse(raw);
      model = typeof parsed?.model === "string" ? parsed.model : undefined;
      body = JSON.stringify(parsed);
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

    console.log(
      JSON.stringify({
        route: subpath,
        model,
        vad,
        user: userId,
        status: upstream.status,
        ms: Date.now() - t0,
      }),
    );

    const headers = new Headers();
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("Content-Type", ct);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    console.log(
      JSON.stringify({ route: subpath, model, vad, error: String(e).slice(0, 200), ms: Date.now() - t0 }),
    );
    return new Response(
      JSON.stringify({ error: { message: `Upstream error: ${String(e).slice(0, 200)}` } }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}