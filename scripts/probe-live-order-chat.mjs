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

async function probeOrderNumber(orderNumber, expectedStatuses) {
  const opening = await beginOrderFlow();
  const messages = [
    { role: "user", content: "Dov'è il mio ordine?" },
    { role: "assistant", content: opening.message },
    { role: "user", content: orderNumber },
  ];
  const numberResponse = await chat(orderNumber, opening.conversation_state, messages);
  const status = numberResponse.payload?.order_lookup?.status;
  assert.ok(
    expectedStatuses.includes(status),
    `Order ${orderNumber}: expected ${expectedStatuses.join(" or ")}, received ${status}. Payload: ${JSON.stringify(numberResponse.payload)}`,
  );
  assert.notEqual(status, "not_found", `Existing order ${orderNumber} was reported as not found.`);
  return { opening, messages, numberResponse };
}

const marketplaceProbe = await probeOrderNumber("92665", ["marketplace_unsupported"]);
assert.equal(marketplaceProbe.numberResponse.payload.needs_input, false, "Marketplace order must not ask for an email.");
assert.equal(marketplaceProbe.numberResponse.payload?.conversation_state?.next_step, "none", "Marketplace order must end the secure lookup flow.");

const deliveredProbe = await probeOrderNumber("92637", ["ask_email"]);
assert.equal(deliveredProbe.numberResponse.payload?.conversation_state?.next_step, "email", "Existing storefront order must request its email.");

const digitEmail = "probe608@example.invalid";
const emailMessages = deliveredProbe.messages.concat([
  { role: "assistant", content: deliveredProbe.numberResponse.payload.message },
  { role: "user", content: digitEmail },
]);
const emailResponse = await chat(digitEmail, deliveredProbe.numberResponse.payload.conversation_state, emailMessages);
assert.equal(
  emailResponse.payload?.order_lookup?.status,
  "email_mismatch",
  `Digits inside an email must not replace order 92637. Payload: ${JSON.stringify(emailResponse.payload)}`,
);
assert.notEqual(emailResponse.payload?.order_lookup?.status, "not_found", "The Worker incorrectly treated 608 inside the email as an order number.");
assert.equal(emailResponse.payload?.conversation_state?.order_number, "92637", "The original order number must survive the email step.");
assert.equal(emailResponse.payload?.conversation_state?.next_step, "email", "After an email mismatch the customer must be allowed to retry the email.");

console.log(JSON.stringify({
  endpoint,
  marketplace: {
    orderNumber: "92665",
    status: marketplaceProbe.numberResponse.payload?.order_lookup?.status,
    nextStep: marketplaceProbe.numberResponse.payload?.conversation_state?.next_step,
  },
  delivered: {
    orderNumber: "92637",
    numberStatus: deliveredProbe.numberResponse.payload?.order_lookup?.status,
    digitEmailStatus: emailResponse.payload?.order_lookup?.status,
    preservedOrderNumber: emailResponse.payload?.conversation_state?.order_number,
  },
}, null, 2));
