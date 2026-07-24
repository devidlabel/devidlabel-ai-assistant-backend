import assert from "node:assert/strict";

const endpoint = process.env.ASSISTANT_LIVE_ENDPOINT || "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/chat";
const origin = process.env.ASSISTANT_LIVE_ORIGIN || "https://www.devidlabel.com";

async function chat(query, conversationState, messages = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Origin: origin,
    },
    body: JSON.stringify({
      query,
      message: query,
      messages,
      conversation_state: conversationState,
      locale: "it-IT",
      language: "it",
      country: "IT",
      path: "/",
      page_context: {
        page_type: "storefront",
        path: "/",
        locale: "it-IT",
        language: "it",
      },
      cart_context: [],
      knowledge_version: "assistant-v2",
    }),
  });

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Live Worker returned non-JSON (${response.status}): ${raw.slice(0, 500)}`);
  }

  assert.equal(response.status, 200, `Expected HTTP 200, received ${response.status}: ${raw}`);
  assert.equal(payload?.ok, true, `Expected ok=true: ${raw}`);
  assert.equal(payload?.type, "order_help", `Order flow must never become ${payload?.type || "unknown"}: ${raw}`);
  return { payload, response };
}

async function beginOrderFlow() {
  const first = await chat("Dov'è il mio ordine?", null, [
    { role: "user", content: "Dov'è il mio ordine?" },
  ]);
  assert.equal(first.payload?.order_lookup?.status, "ask_order_number", JSON.stringify(first.payload));
  assert.equal(first.payload?.conversation_state?.flow, "order_lookup", JSON.stringify(first.payload));
  return first.payload;
}

async function probeOrder(orderNumber, expectedStatuses) {
  const opening = await beginOrderFlow();
  const numberResponse = await chat(orderNumber, opening.conversation_state, [
    { role: "user", content: "Dov'è il mio ordine?" },
    { role: "assistant", content: opening.message },
    { role: "user", content: orderNumber },
  ]);

  const status = numberResponse.payload?.order_lookup?.status;
  assert.ok(
    expectedStatuses.includes(status),
    `Order ${orderNumber}: expected ${expectedStatuses.join(" or ")}, received ${status}. Payload: ${JSON.stringify(numberResponse.payload)}`,
  );
  assert.notEqual(status, "not_found", `Existing order ${orderNumber} was reported as not found.`);
  return {
    orderNumber,
    status,
    title: numberResponse.payload.title,
    needsInput: numberResponse.payload.needs_input,
    nextStep: numberResponse.payload?.conversation_state?.next_step,
    cors: numberResponse.response.headers.get("access-control-allow-origin"),
  };
}

const marketplace = await probeOrder("92665", ["marketplace_unsupported"]);
assert.equal(marketplace.needsInput, false, "Marketplace order must not ask for an email.");
assert.equal(marketplace.nextStep, "none", "Marketplace order must end the secure lookup flow.");

const delivered = await probeOrder("92637", ["ask_email", "marketplace_unsupported"]);
assert.equal(delivered.status === "ask_email" ? delivered.nextStep : "none", delivered.status === "ask_email" ? "email" : "none");

console.log(JSON.stringify({ endpoint, marketplace, delivered }, null, 2));
