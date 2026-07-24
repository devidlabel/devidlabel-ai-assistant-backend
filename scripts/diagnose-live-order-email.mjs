import { writeFile } from "node:fs/promises";

const endpoint = process.env.ASSISTANT_LIVE_ENDPOINT || "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/chat";
const origin = process.env.ASSISTANT_LIVE_ORIGIN || "https://www.devidlabel.com";

async function chat(query, conversationState, messages = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Origin: origin },
    body: JSON.stringify({
      query,
      message: query,
      messages,
      conversation_state: conversationState,
      locale: "it-IT",
      language: "it",
      country: "IT",
      path: "/",
      page_context: { page_type: "storefront", path: "/", locale: "it-IT", language: "it" },
      cart_context: [],
      knowledge_version: "assistant-v2",
    }),
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }
  return { http_status: response.status, payload };
}

const opening = await chat("Dov'è il mio ordine?", null, [{ role: "user", content: "Dov'è il mio ordine?" }]);
const numberMessages = [
  { role: "user", content: "Dov'è il mio ordine?" },
  { role: "assistant", content: opening.payload?.message || "" },
  { role: "user", content: "92637" },
];
const number = await chat("92637", opening.payload?.conversation_state, numberMessages);
const emailMessages = numberMessages.concat([
  { role: "assistant", content: number.payload?.message || "" },
  { role: "user", content: "probe608@example.invalid" },
]);
const email = await chat("probe608@example.invalid", number.payload?.conversation_state, emailMessages);

await writeFile("live-order-email-diagnostic.json", JSON.stringify({ endpoint, opening, number, email }, null, 2));
console.log(JSON.stringify({
  opening_status: opening.payload?.order_lookup?.status,
  number_status: number.payload?.order_lookup?.status,
  email_status: email.payload?.order_lookup?.status,
  email_order_number: email.payload?.conversation_state?.order_number,
  email_next_step: email.payload?.conversation_state?.next_step,
}, null, 2));
