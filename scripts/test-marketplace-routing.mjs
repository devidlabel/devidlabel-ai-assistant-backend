import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const outDir = ".tmp/marketplace-routing-test";
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

try {
  await execFileAsync("./node_modules/.bin/tsc", [
    "src/index.ts",
    "src/worker.ts",
    "--target", "ES2022",
    "--module", "ES2022",
    "--moduleResolution", "Bundler",
    "--outDir", outDir,
    "--skipLibCheck",
    "--noEmitOnError", "false",
  ]);
} catch (error) {
  if (!String(error?.stdout || "").includes("error TS")) throw error;
}

const compiledWorkerPath = `${outDir}/worker.js`;
const compiledWorker = await readFile(compiledWorkerPath, "utf8");
await writeFile(compiledWorkerPath, compiledWorker.replace('from "./index"', 'from "./index.js"'), "utf8");
const moduleUrl = new URL(`../${compiledWorkerPath}?cache=${Date.now()}`, import.meta.url);
const { default: worker } = await import(moduleUrl);

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || "{}");
  const searchQuery = body.variables?.query || "";
  const node = /92665/.test(searchQuery) ? {
    name: "#92665",
    number: 92665,
    email: "marketplace@example.com",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    sourceName: "Spartoo",
    sourceIdentifier: "spartoo",
    tags: ["marketplace-spartoo"],
    customAttributes: [],
    paymentGatewayNames: [],
    shippingLines: { edges: [] },
    fulfillments: [],
  } : null;
  return new Response(JSON.stringify({ data: { orders: { edges: node ? [{ node }] : [] } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

try {
  const origin = "https://www.devidlabel.com";
  const request = new Request("https://assistant.test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      query: "92665",
      locale: "it",
      language: "it",
      conversation_state: { flow: "order_lookup", order_number: "92664", next_step: "email" },
      messages: [{ role: "assistant", content: "Inserisci l'email" }, { role: "user", content: "92665" }],
    }),
  });

  const response = await worker.fetch(request, {
    SHOPIFY_SHOP_DOMAIN: "devid-label.myshopify.com",
    SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_test",
  }, { waitUntil() {}, passThroughOnException() {} });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin, "early marketplace response preserves public storefront CORS");
  const body = await response.json();
  assert.equal(body.type, "order_help");
  assert.equal(body.order_lookup?.status, "marketplace_unsupported");
  assert.equal(body.needs_input, false);
  assert.match(`${body.title} ${body.message}`, /marketplace|Spartoo/i);
  assert.doesNotMatch(body.message, /e-?mail|email/i);
} finally {
  globalThis.fetch = nativeFetch;
}

console.log("Validated immediate marketplace routing without email and preserved storefront CORS.");
