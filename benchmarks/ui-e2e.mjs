import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

const SSE = (obj) => `data: ${JSON.stringify({ choices: [{ delta: { content: obj } }] })}\n\n`;
const fullLatex = '"mode":"append","transcript":"dy dx equals x squared times x cubed","latex":"\\\\frac{dy}{dx} = x^{2} \\\\cdot x^{3}","confidence":0.95,"note":""';
const sseBody = [
  SSE('{"mode":"append","transcript":"dy dx eq'),
  SSE('uals x squared times x cubed","latex":"\\\\frac{dy}{dx} = x^{2} \\\\cdot x^{3}","confidence":0.95,"note":""}'),
  "data: [DONE]\n\n",
].join("");
console.log("SSE preview:", sseBody.slice(0, 200));

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error" || m.text().includes("mathtex")) console.log("[" + m.type() + "]", m.text().slice(0, 300)); });

await page.goto("https://localhost:4173", { waitUntil: "networkidle" });
check("page title", (await page.title()) === "MathTex");
check("placeholder visible", await page.locator(".placeholder").isVisible());

// Stub chat/completions with a streaming SSE response (transcript first, then latex)
await page.evaluate((body) => {
  const orig = window.fetch.bind(window);
  let sseCalls = 0;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (String(url).endsWith("/api/chat/completions") && !(init?.body === "{}")) {
      const canned = JSON.stringify({ choices: [{ message: { content: '{"mode":"append","transcript":"dy dx equals x squared times x cubed","latex":"\\\\frac{dy}{dx} = x^{2} \\\\cdot x^{3}","confidence":0.95,"note":""}' } }] });
      window.__sseCalls = (window.__sseCalls || 0) + 1;
      if (window.__sseCalls > 1) {
        return Promise.resolve(new Response(canned, { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const stream = new ReadableStream({
        start(c) {
          setTimeout(() => c.enqueue(new TextEncoder().encode(body.split("data: [DONE]")[0])), 300);
          setTimeout(() => c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")), 700);
          setTimeout(() => c.close(), 750);
        },
      });
      return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    }
    return orig(input, init);
  };
}, sseBody);

const mic = page.locator(".mic");
const box = await mic.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
await page.mouse.up();
// Progressive: transcript should appear in status before final render
try {
  await page.waitForFunction(() => document.querySelector(".status")?.textContent?.includes("heard:"), { timeout: 5000 });
  check("progressive transcript shown while thinking", true);
} catch {
  check("progressive transcript shown while thinking", false, (await page.locator(".status").textContent()) ?? "");
}
try {
  await page.waitForSelector(".lines .line", { timeout: 8000 });
  check("line rendered from SSE", true);
} catch {
  const diag = {
    status: (await page.locator(".status").textContent()) ?? "",
    error: (await page.locator(".error-banner").textContent().catch(() => ""))?.trim() ?? "",
    lines: await page.locator(".lines").count(),
  };
  await page.screenshot({ path: "/tmp/opencode/mathtex-e2e/fail.png", fullPage: true });
  check("line rendered from SSE", false, JSON.stringify(diag));
}
try {
  const h = await page.locator(".line .latex").first().innerHTML({ timeout: 5000 });
  check("KaTeX fraction", h.includes("frac"), h.slice(0, 80));
} catch (e) {
  check("KaTeX fraction", false, `ERR:${String(e).slice(0, 80)} lines=${await page.locator(".lines").count()} status=${await page.locator(".status").textContent()} err=${await page.locator(".error-banner").textContent().catch(() => "-")}`);
}
try {
  const t = await page.locator(".transcript").first().textContent({ timeout: 5000 });
  check("transcript caption", t?.includes("dy dx equals"), t ?? "");
} catch (e) {
  const dump = await page.evaluate(() => ({
    stage: document.querySelector(".stage")?.innerHTML.slice(0, 400),
    lineCount: document.querySelectorAll(".lines .line").length,
    latexCount: document.querySelectorAll(".line .latex").length,
  }));
  check("transcript caption", false, `ERR:${String(e).slice(0, 60)} dump=${JSON.stringify(dump)}`);
}
await page.screenshot({ path: "/tmp/opencode/mathtex-e2e/ui2.png", fullPage: true });

// Real flow: reload (no stub), fake mic tone through OpenRouter via local tunnel
await page.reload({ waitUntil: "networkidle" });
const b2 = await page.locator(".mic").boundingBox();
await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
await page.mouse.down();
await page.waitForTimeout(2500);
await page.mouse.up();
await page.waitForFunction(
  () => document.querySelector(".status")?.textContent?.includes("hold space") ||
        document.querySelector(".error-banner") !== null,
  { timeout: 30000 },
);
const real = {
  error: (await page.locator(".error-banner").textContent().catch(() => null))?.trim(),
  lines: await page.locator(".lines").count(),
  transcript: (await page.locator(".transcript").textContent().catch(() => null)) ?? "",
};
check("real e2e flow completes", !real.error, JSON.stringify(real).slice(0, 150));

console.log(results.join("\n"));
await browser.close();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
