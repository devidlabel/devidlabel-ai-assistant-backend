import { mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const outDir = ".tmp/bilingual-test";
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
try {
  await execFileAsync("./node_modules/.bin/tsc", ["src/index.ts", "--target", "ES2022", "--module", "ES2022", "--moduleResolution", "Bundler", "--outDir", outDir, "--skipLibCheck", "--noEmitOnError", "false"]);
} catch (error) {
  if (!String(error?.stdout || "").includes("error TS")) throw error;
}
const { handleRequest } = await import(`../${outDir}/index.js?cache=${Date.now()}`);

async function chat(payload) {
  const request = new Request("https://assistant.test/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const response = await handleRequest(request, {}, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  return response.json();
}

const enContext = { locale: "en", language: "en", country: "IT", path: "/en", page_context: { locale: "en", language: "en", path: "/en" } };
const cases = [
  { payload: { message: "where is my order?", ...enContext }, type: "order_help", includes: "order number", notIncludes: "ordine" },
  { payload: { query: "cash on delivery", ...enContext }, type: "faq", includes: "Cash on delivery", notIncludes: "consegna" },
  { payload: { query: "are your products original?", ...enContext }, type: "faq", includes: "original", notIncludes: "prodotti" },
  { payload: { query: "shipping times", ...enContext }, type: "faq", includes: "business days", notIncludes: "giorni lavorativi" },
  { payload: { query: "size guide", ...enContext }, type: "faq", includes: "size guide", notIncludes: "taglie" },
  { payload: { query: "men swimwear", ...enContext }, type: "product_advice", includes: "Swimwear", notIncludes: "Costumi" },
  { payload: { query: "t-shirt saint barth uomo", ...enContext }, type: "product_advice", includes: "MC2 Saint Barth", notIncludes: "Ti mostro" },
  { payload: { query: "jeans replay uomo", ...enContext }, type: "product_advice", includes: "Replay", notIncludes: "Ti mostro" },
  { payload: { query: "cargo courmayeur", ...enContext }, type: "product_advice", includes: "Cargo", notIncludes: "Ti propongo" },
  { payload: { query: "dov’è il mio ordine?", locale: "it", language: "it", path: "/" }, type: "order_help", includes: "ordine", notIncludes: "order number" },
  { payload: { query: "pagamento alla consegna", locale: "it", language: "it" }, type: "faq", includes: "consegna", notIncludes: "Cash on delivery is" },
  { payload: { query: "prodotti originali", locale: "it", language: "it" }, type: "faq", includes: "prodotti", notIncludes: "External-brand" },
  { payload: { query: "t-shirt uomo", locale: "it", language: "it" }, type: "product_advice", includes: "prodotti", notIncludes: "I’ll" },
  { payload: { query: "t-shirt saint barth uomo", locale: "it", language: "it" }, type: "product_advice", includes: "MC2 Saint Barth", notIncludes: "I’ll" },
];

for (const testCase of cases) {
  const body = await chat(testCase.payload);
  const haystack = `${body.title} ${body.message}`;
  assert.equal(body.type, testCase.type, `${testCase.payload.query || testCase.payload.message}: type`);
  assert.match(haystack, new RegExp(testCase.includes, "i"), `${testCase.payload.query || testCase.payload.message}: expected ${testCase.includes}`);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(haystack, new RegExp(testCase.notIncludes, "i"), `${testCase.payload.query || testCase.payload.message}: unexpected ${testCase.notIncludes}`);
  if ((testCase.payload.locale || testCase.payload.language) === "en") {
    assert.doesNotMatch(serialized, /Ti mostro|Ti propongo|Ti porto|Vedi risultati|Cerca nel catalogo|Vedi collection|Completa il look|Scopri le proposte|Apri la ricerca|Costumi e proposte|Mare uomo|Bermuda uomo|Prodotto consigliato/i, `${testCase.payload.query || testCase.payload.message}: leaked Italian legacy copy`);
  }
}

console.log(`Validated ${cases.length} bilingual assistant cases, including legacy product copy checks.`);
