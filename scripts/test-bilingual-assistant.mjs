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

const lookupEnv = { SHOPIFY_SHOP_DOMAIN: "devid-label.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_test" };
const lookupFetchCalls = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || "{}");
  lookupFetchCalls.push(body);
  const query = body.variables?.query || "";
  const found = /91991/.test(query);
  const node = found ? { name: "#91991", number: 91991, email: "test@example.com", displayFulfillmentStatus: "FULFILLED", cancelledAt: null, sourceName: "web", sourceIdentifier: null, tags: [], customAttributes: [], paymentGatewayNames: [], shippingLines: { edges: [] }, fulfillments: [{ status: "SUCCESS", displayStatus: "FULFILLED", trackingInfo: [{ company: "BRT", number: "TRACK91991", url: "https://tracking.example/TRACK91991" }] }] } : null;
  return new Response(JSON.stringify({ data: { orders: { edges: node ? [{ node }] : [] } } }), { status: 200, headers: { "content-type": "application/json" } });
};

async function chat(payload, env = {}) {
  const request = new Request("https://assistant.test/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const response = await handleRequest(request, env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  return response.json();
}

const enContext = { locale: "en", language: "en", country: "IT", path: "/en", page_context: { locale: "en", language: "en", path: "/en" } };
const itContext = { locale: "it", language: "it", path: "/" };
const cases = [
  { payload: { message: "where is my order?", ...enContext }, type: "order_help", includes: "order number", notIncludes: "ordine" },
  { payload: { query: "Where is my order? 91991", ...enContext }, type: "order_help", includes: "I found the order number", notIncludes: "Enter your order number", orderStatus: "ask_email" },
  { payload: { query: "order status", ...enContext }, type: "order_help", includes: "order number", notIncludes: "Recommended products" },
  { payload: { query: "track my order", ...enContext }, type: "order_help", includes: "order number", notIncludes: "Recommended products" },
  { payload: { query: "cash on delivery", ...enContext }, type: "faq", includes: "Cash on delivery is available when you choose home delivery at checkout", notIncludes: "Recommended products" },
  { payload: { query: "pay on delivery", ...enContext }, type: "faq", includes: "home delivery", notIncludes: "Recommended products" },
  { payload: { query: "COD", ...enContext }, type: "faq", includes: "home delivery", notIncludes: "Recommended products" },
  { payload: { query: "shipping times", ...enContext }, type: "faq", includes: "Orders are not shipped on Saturdays or Sundays", notIncludes: "Recommended products" },
  { payload: { query: "delivery times", ...enContext }, type: "faq", includes: "delivery method selected", notIncludes: "Recommended products" },
  { payload: { query: "free shipping", ...enContext }, type: "faq", includes: "Available options are shown at checkout", notIncludes: "Recommended products" },
  { payload: { query: "InPost shipping", ...enContext }, type: "faq", includes: "Orders are not shipped on Saturdays or Sundays", notIncludes: "Recommended products" },
  { payload: { query: "easy returns", ...enContext }, type: "faq", includes: "Returns are simple", notIncludes: "Recommended products" },
  { payload: { query: "returns", ...enContext }, type: "faq", includes: "returns policy", notIncludes: "Recommended products" },
  { payload: { query: "return policy", ...enContext }, type: "faq", includes: "returns policy", notIncludes: "Recommended products" },
  { payload: { query: "size guide", ...enContext }, type: "faq", includes: "size guide", notIncludes: "Recommended products" },
  { payload: { query: "what size should I choose", ...enContext }, type: "faq", includes: "fit notes", notIncludes: "Recommended products" },
  { payload: { query: "are your products original", ...enContext }, type: "faq", includes: "authorized channels", notIncludes: "Recommended products" },
  { payload: { query: "authentic products", ...enContext }, type: "faq", includes: "authorized channels", notIncludes: "Recommended products" },
  { payload: { query: "authorized retailer", ...enContext }, type: "faq", includes: "authorized channels", notIncludes: "Recommended products" },
  { payload: { query: "men swimwear", ...enContext }, type: "product_advice", includes: "Swimwear", notIncludes: "Costumi" },
  { payload: { query: "men pants", ...enContext }, type: "product_advice", includes: "Pants", notIncludes: "Ti mostro" },
  { payload: { query: "men cargo pants", ...enContext }, type: "product_advice", includes: "Cargo", notIncludes: "Ti mostro" },
  { payload: { query: "men jackets", ...enContext }, type: "product_advice", includes: "Outerwear", notIncludes: "Ti mostro" },
  { payload: { query: "men Saint Barth t-shirt", ...enContext }, type: "product_advice", includes: "MC2 Saint Barth", notIncludes: "Ti mostro" },
  { payload: { query: "t-shirt saint barth uomo", ...enContext }, type: "product_advice", includes: "MC2 Saint Barth", notIncludes: "Ti mostro" },
  { payload: { query: "jeans replay uomo", ...enContext }, type: "product_advice", includes: "Replay", notIncludes: "Ti mostro" },
  { payload: { query: "cargo courmayeur", ...enContext }, type: "product_advice", includes: "Cargo", notIncludes: "Ti propongo" },
  { payload: { query: "sprayground backpack", ...enContext }, type: "product_advice", includes: "Sprayground", notIncludes: "Recommended products" },
  { payload: { query: "k-way donna", ...enContext }, type: "product_advice", includes: "K-Way", notIncludes: "Recommended products" },
  { payload: { query: "dov’è il mio ordine?", ...itContext }, type: "order_help", includes: "ordine", notIncludes: "order number" },
  { payload: { query: "dov’è il mio ordine 91991", ...itContext }, type: "order_help", includes: "Ho rilevato il numero", notIncludes: "Inserisci il numero ordine", orderStatus: "ask_email" },
  { payload: { query: "stato ordine", ...itContext }, type: "order_help", includes: "numero ordine", notIncludes: "Recommended products" },
  { payload: { query: "tracking ordine", ...itContext }, type: "order_help", includes: "numero ordine", notIncludes: "Recommended products" },
  { payload: { query: "pagamento alla consegna", ...itContext }, type: "faq", includes: "spedizione a domicilio", notIncludes: "Recommended products" },
  { payload: { query: "contrassegno", ...itContext }, type: "faq", includes: "spedizione a domicilio", notIncludes: "Recommended products" },
  { payload: { query: "tempi di spedizione", ...itContext }, type: "faq", includes: "sabato e domenica", notIncludes: "Recommended products" },
  { payload: { query: "reso facile", ...itContext }, type: "faq", includes: "policy resi", notIncludes: "Recommended products" },
  { payload: { query: "resi", ...itContext }, type: "faq", includes: "policy resi", notIncludes: "Recommended products" },
  { payload: { query: "guida taglie", ...itContext }, type: "faq", includes: "guida taglie", notIncludes: "Recommended products" },
  { payload: { query: "prodotti originali", ...itContext }, type: "faq", includes: "canali autorizzati", notIncludes: "Recommended products" },
  { payload: { query: "rivenditore autorizzato", ...itContext }, type: "faq", includes: "canali autorizzati", notIncludes: "Recommended products" },
  { payload: { query: "t-shirt uomo", ...itContext }, type: "product_advice", includes: "prodotti", notIncludes: "I’ll" },
  { payload: { query: "t-shirt saint barth uomo", ...itContext }, type: "product_advice", includes: "MC2 Saint Barth", notIncludes: "I’ll" },
];

for (const testCase of cases) {
  const body = await chat(testCase.payload);
  const haystack = `${body.title} ${body.message}`;
  assert.equal(body.type, testCase.type, `${testCase.payload.query || testCase.payload.message}: type`);
  assert.match(haystack, new RegExp(testCase.includes, "i"), `${testCase.payload.query || testCase.payload.message}: expected ${testCase.includes}`);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Recommended products/i, `${testCase.payload.query || testCase.payload.message}: should not use commerce fallback title`);
  assert.doesNotMatch(haystack, new RegExp(testCase.notIncludes, "i"), `${testCase.payload.query || testCase.payload.message}: unexpected ${testCase.notIncludes}`);
  if (testCase.orderStatus) assert.equal(body.order_lookup?.status, testCase.orderStatus, `${testCase.payload.query}: order status`);
  if ((testCase.payload.locale || testCase.payload.language) === "en") {
    assert.doesNotMatch(serialized, /Ti mostro|Ti propongo|Ti porto|Vedi risultati|Cerca nel catalogo|Vedi collection|Completa il look|Scopri le proposte|Apri la ricerca|Costumi e proposte|Mare uomo|Bermuda uomo|Prodotto consigliato/i, `${testCase.payload.query || testCase.payload.message}: leaked Italian legacy copy`);
  }
}

const enStart = await chat({ message: "Where is my order?", ...enContext }, lookupEnv);
assert.equal(enStart.order_lookup?.status, "ask_order_number", "EN flow starts by asking order number");
const enNumber = await chat({ message: "91991", ...enContext, conversation_state: enStart.conversation_state }, lookupEnv);
assert.equal(enNumber.order_lookup?.status, "ask_email", "EN flow asks email after order number");
const beforeEnEmailCalls = lookupFetchCalls.length;
const enEmail = await chat({ message: "test@example.com", ...enContext, conversation_state: enNumber.conversation_state }, lookupEnv);
assert.equal(enEmail.order_lookup?.status, "found", "EN flow reaches final lookup after email");
assert.match(enEmail.message, /shipped|Tracking|TRACK91991/i, "EN final lookup returns useful order status/tracking");
assert(lookupFetchCalls.length > beforeEnEmailCalls, "EN email follow-up triggers Shopify lookup");
assert.doesNotMatch(enEmail.message, /Thanks\. I have the order number and email needed/i, "EN flow must not stop at acknowledgement");

const itStart = await chat({ message: "Dov’è il mio ordine?", ...itContext }, lookupEnv);
assert.equal(itStart.order_lookup?.status, "ask_order_number", "IT flow starts by asking order number");
const itNumber = await chat({ message: "91991", ...itContext, conversation_state: itStart.conversation_state }, lookupEnv);
assert.equal(itNumber.order_lookup?.status, "ask_email", "IT flow asks email after order number");
const beforeItEmailCalls = lookupFetchCalls.length;
const itEmail = await chat({ message: "test@example.com", ...itContext, conversation_state: itNumber.conversation_state }, lookupEnv);
assert.equal(itEmail.order_lookup?.status, "found", "IT flow reaches final lookup after email");
assert.match(itEmail.message, /spedito|Tracking|TRACK91991/i, "IT final lookup returns useful order status/tracking");
assert(lookupFetchCalls.length > beforeItEmailCalls, "IT email follow-up triggers Shopify lookup");

const enSingle = await chat({ message: "Where is my order? 91991 test@example.com", ...enContext }, lookupEnv);
assert.equal(enSingle.order_lookup?.status, "found", "EN single-message order and email reaches lookup");
const itSingle = await chat({ message: "Dov’è il mio ordine 91991 test@example.com", ...itContext }, lookupEnv);
assert.equal(itSingle.order_lookup?.status, "found", "IT single-message order and email reaches lookup");
const enMissing = await chat({ message: "Where is my order? 99999 test@example.com", ...enContext }, lookupEnv);
assert.equal(enMissing.order_lookup?.status, "not_found", "missing order returns safe not_found");
assert.match(enMissing.message, /couldn’t find an order matching those details/i, "missing order returns prudent EN copy");
const enMismatch = await chat({ message: "Where is my order? 91991 wrong@example.com", ...enContext }, lookupEnv);
assert.equal(enMismatch.order_lookup?.status, "email_mismatch", "email mismatch returns safe status");
assert(!JSON.stringify(enMismatch).includes("TRACK91991"), "email mismatch must not leak tracking");

console.log(`Validated ${cases.length} bilingual assistant cases, including support-first intent routing and conversational order lookup checks.`);
