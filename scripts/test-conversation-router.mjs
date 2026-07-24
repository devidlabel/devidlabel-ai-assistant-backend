import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execFileAsync = promisify(execFile);
const outDir = ".tmp/conversation-router-test";
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

// TypeScript preserves the extensionless Worker import for bundlers. Node's direct ESM loader
// needs the emitted .js extension in this isolated test directory.
const compiledWorkerPath = `${outDir}/worker.js`;
const compiledWorker = await readFile(compiledWorkerPath, "utf8");
await writeFile(compiledWorkerPath, compiledWorker.replace('from "./index"', 'from "./index.js"'), "utf8");

const moduleUrl = new URL(`../${compiledWorkerPath}?cache=${Date.now()}`, import.meta.url);
const { default: worker, prepareConversationPayload, isOrderFlowContinuation } = await import(moduleUrl);

const waitingEmail = { flow: "order_lookup", order_number: "92665", next_step: "email" };
const waitingNumber = { flow: "order_lookup", next_step: "order_number" };
const terminalOrder = { flow: "order_lookup", order_number: "92665", email: "test@example.com", next_step: "none" };

const validEmailContinuation = prepareConversationPayload({
  query: "test@example.com",
  conversation_state: waitingEmail,
  messages: [{ role: "user", content: "92665" }],
});
assert.deepEqual(validEmailContinuation.conversation_state, waitingEmail, "email continues an order flow that is waiting for email");

const validNumberContinuation = prepareConversationPayload({
  query: "92665",
  conversation_state: waitingNumber,
  messages: [{ role: "assistant", content: "Inserisci il numero ordine" }, { role: "user", content: "92665" }],
});
assert.deepEqual(validNumberContinuation.conversation_state, waitingNumber, "order number continues a flow that is waiting for the number");

const replacementNumberContinuation = prepareConversationPayload({
  query: "92664",
  conversation_state: waitingEmail,
  messages: [{ role: "assistant", content: "Inserisci l'email" }, { role: "user", content: "92664" }],
});
assert.deepEqual(replacementNumberContinuation.conversation_state, waitingEmail, "a new order number replaces the previous number instead of leaving the order task");

const switchedToReturns = prepareConversationPayload({
  query: "Come funziona il reso?",
  conversation_state: waitingEmail,
  messages: [
    { role: "user", content: "Dov'è il mio ordine?" },
    { role: "assistant", content: "Inserisci il numero ordine" },
    { role: "user", content: "92665" },
    { role: "assistant", content: "Inserisci l'email" },
    { role: "user", content: "Come funziona il reso?" },
  ],
});
assert.equal(switchedToReturns.conversation_state, null, "return request clears stale order state");
assert.deepEqual(switchedToReturns.messages, [{ role: "user", content: "Come funziona il reso?" }], "task switch keeps only the new request as model context");

const switchedToProduct = prepareConversationPayload({
  query: "Aiutami a scegliere il prodotto giusto",
  conversation_state: terminalOrder,
  messages: [
    { role: "user", content: "Dov'è il mio ordine?" },
    { role: "assistant", content: "Ordine marketplace" },
    { role: "user", content: "Aiutami a scegliere il prodotto giusto" },
  ],
});
assert.equal(switchedToProduct.conversation_state, null, "product advice cannot inherit a terminal order state");
assert.deepEqual(switchedToProduct.messages, [{ role: "user", content: "Aiutami a scegliere il prodotto giusto" }]);

const broadOrderRestart = prepareConversationPayload({
  query: "Dov'è il mio ordine?",
  conversation_state: terminalOrder,
  messages: [
    { role: "user", content: "92665" },
    { role: "user", content: "test@example.com" },
    { role: "user", content: "Dov'è il mio ordine?" },
  ],
});
assert.equal(broadOrderRestart.conversation_state, null, "root order action starts a new lookup instead of replaying the old result");

assert.equal(isOrderFlowContinuation("test@example.com", waitingEmail), true);
assert.equal(isOrderFlowContinuation("92664", waitingEmail), true, "a replacement number remains inside the order flow");
assert.equal(isOrderFlowContinuation("Consigliami un look", waitingEmail), false);
assert.equal(isOrderFlowContinuation("Dov'è il mio ordine?", terminalOrder), false);

async function chat(payload, env = {}) {
  const request = new Request("https://assistant.test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
  assert.equal(response.status, 200);
  return response.json();
}

const returnResponse = await chat({
  query: "Come funziona il reso?",
  locale: "it",
  language: "it",
  conversation_state: waitingEmail,
  messages: [
    { role: "user", content: "Dov'è il mio ordine?" },
    { role: "assistant", content: "Inserisci l'email" },
    { role: "user", content: "Come funziona il reso?" },
  ],
});
assert.equal(returnResponse.type, "faq", "end-to-end router reaches the new return task");
assert.match(`${returnResponse.title} ${returnResponse.message}`, /reso|resi|policy/i);
assert.doesNotMatch(`${returnResponse.title} ${returnResponse.message}`, /numero ordine|stato ordine|marketplace/i);

const restartedOrder = await chat({
  query: "Dov'è il mio ordine?",
  locale: "it",
  language: "it",
  conversation_state: terminalOrder,
  messages: [
    { role: "user", content: "92665" },
    { role: "assistant", content: "Ordine non trovato" },
    { role: "user", content: "Dov'è il mio ordine?" },
  ],
});
assert.equal(restartedOrder.type, "order_help");
assert.equal(restartedOrder.order_lookup?.status, "ask_order_number", "reopening order help asks for a fresh order number");

const orderEnv = { SHOPIFY_SHOP_DOMAIN: "devid-label.myshopify.com", SHOPIFY_ADMIN_ACCESS_TOKEN: "shpat_test" };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body || "{}");
  const searchQuery = body.variables?.query || "";
  let node = null;

  if (/92665/.test(searchQuery)) {
    node = {
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
    };
  } else if (/92664/.test(searchQuery)) {
    node = {
      name: "#92664",
      number: 92664,
      email: "direct@example.com",
      displayFulfillmentStatus: "UNFULFILLED",
      cancelledAt: null,
      sourceName: "web",
      sourceIdentifier: null,
      tags: [],
      customAttributes: [],
      paymentGatewayNames: [],
      shippingLines: { edges: [] },
      fulfillments: [],
    };
  }

  return new Response(JSON.stringify({ data: { orders: { edges: node ? [{ node }] : [] } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

try {
  const marketplaceResponse = await chat({
    query: "92665",
    locale: "it",
    language: "it",
    conversation_state: waitingEmail,
    messages: [{ role: "assistant", content: "Inserisci l'email" }, { role: "user", content: "92665" }],
  }, orderEnv);
  assert.equal(marketplaceResponse.type, "order_help");
  assert.equal(marketplaceResponse.order_lookup?.status, "marketplace_unsupported", "marketplace is identified immediately from the order number");
  assert.equal(marketplaceResponse.needs_input, false, "marketplace orders must not request email");
  assert.match(`${marketplaceResponse.title} ${marketplaceResponse.message}`, /marketplace|Spartoo/i);
  assert.doesNotMatch(marketplaceResponse.message, /e-?mail|email/i, "marketplace response must not waste time asking for email");

  const replacementDirectResponse = await chat({
    query: "92664",
    locale: "it",
    language: "it",
    conversation_state: waitingEmail,
    messages: [{ role: "assistant", content: "Inserisci l'email" }, { role: "user", content: "92664" }],
  }, orderEnv);
  assert.equal(replacementDirectResponse.order_lookup?.status, "ask_email", "a replacement direct-store order is looked up before asking for email");
  assert.equal(replacementDirectResponse.conversation_state?.order_number, "92664", "the replacement number becomes the active order");
  assert.match(replacementDirectResponse.message, /e-?mail|email/i);
} finally {
  globalThis.fetch = nativeFetch;
}

console.log("Validated task switching, replacement order numbers, immediate marketplace routing and clean order-flow restarts.");
