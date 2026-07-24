import { handleRequest } from "./index";

type WorkerEnv = Parameters<typeof handleRequest>[1];
type WorkerExecutionContext = NonNullable<Parameters<typeof handleRequest>[2]>;
type AssistantTask = "order" | "returns" | "support" | "look" | "product";
type ConversationState = { flow?: string; next_step?: string; order_number?: string; email?: string } | null;
type ChatMessage = { role?: unknown; content?: unknown };
type AssistantPayload = Record<string, unknown> & {
  query?: unknown;
  message?: unknown;
  messages?: unknown;
  conversation_state?: unknown;
};

function normalizeShopifyOrigin(env: WorkerEnv): string {
  const domain = env.SHOPIFY_SHOP_DOMAIN
    ?.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) return "";
  return `https://${domain}`;
}

function addShopifyPreviewCors(response: Response, request: Request, env: WorkerEnv): Response {
  const requestOrigin = (request.headers.get("Origin") || "").trim().toLowerCase();
  if (!requestOrigin) return response;

  const existingAllowedOrigin = (response.headers.get("Access-Control-Allow-Origin") || "").trim().toLowerCase();
  if (existingAllowedOrigin === requestOrigin) return response;

  const shopifyOrigin = normalizeShopifyOrigin(env);
  if (!shopifyOrigin || requestOrigin !== shopifyOrigin) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", requestOrigin);
  headers.set("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function normalizeConversationText(value: unknown): string {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’']/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
    : "";
}

function hasOrderNumber(value: string): boolean {
  return /(?:^|\s)#?\d{3,12}(?:\s|$)/.test(value);
}

function hasEmail(value: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value);
}

function classifyAssistantTask(value: unknown): AssistantTask | null {
  const query = normalizeConversationText(value);
  if (!query) return null;

  if (/\b(dov e il mio ordine|dove e il mio ordine|stato ordine|tracking ordine|traccia ordine|where is my order|track my order|order status|order tracking)\b/.test(query)) return "order";
  if (/\b(reso|resi|cambio|cambi|restituire|return|returns|exchange)\b/.test(query)) return "returns";
  if (/\b(tempi di spedizione|spedizione|inpost|contrassegno|pagamento alla consegna|shipping|delivery|cash on delivery|cod|prodotti originali|originali|rivenditore autorizzato|authentic|authorized retailer|guida taglie|taglia|size guide|sizing)\b/.test(query)) return "support";
  if (/\b(crea un look|consigliami un look|look|outfit|abbinamento|abbina|build a look|style me)\b/.test(query)) return "look";
  if (/\b(aiutami a scegliere|consiglio prodotto|cerco un prodotto|prodotto giusto|recommend|help me choose|product advice|sprayground|saint barth|mc2|k-way|kway|replay|devid label|t-shirt|tshirt|polo|pantaloni|cargo|jeans|bermuda|shorts|maglieria|giacca|costume|zaino|borsa|scarpe|sneaker)\b/.test(query)) return "product";
  return null;
}

function normalizeConversationState(value: unknown): ConversationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  return {
    flow: typeof state.flow === "string" ? state.flow : undefined,
    next_step: typeof state.next_step === "string" ? state.next_step : undefined,
    order_number: typeof state.order_number === "string" ? state.order_number : undefined,
    email: typeof state.email === "string" ? state.email : undefined,
  };
}

function isBroadOrderRestart(query: string): boolean {
  return classifyAssistantTask(query) === "order" && !hasOrderNumber(query) && !hasEmail(query);
}

function isOrderFlowContinuation(query: string, state: ConversationState): boolean {
  if (!state || state.flow !== "order_lookup") return false;
  if (isBroadOrderRestart(query)) return false;

  const strongTask = classifyAssistantTask(query);
  if (strongTask && strongTask !== "order") return false;

  if (hasOrderNumber(query) && hasEmail(query)) return true;
  if (state.next_step === "order_number") return hasOrderNumber(query);
  if (state.next_step === "email") return hasEmail(query);
  if (state.next_step === "lookup") return /\b(riprova|riprovare|retry|prova ancora|try again)\b/.test(normalizeConversationText(query));
  return false;
}

function sanitizedMessages(value: unknown): ChatMessage[] {
  return Array.isArray(value) ? value.filter((message): message is ChatMessage => Boolean(message && typeof message === "object" && !Array.isArray(message))) : [];
}

function previousTask(messages: ChatMessage[], currentQuery: string): AssistantTask | null {
  let skippedCurrent = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (!skippedCurrent && normalizeConversationText(message.content) === normalizeConversationText(currentQuery)) {
      skippedCurrent = true;
      continue;
    }
    const task = classifyAssistantTask(message.content);
    if (task) return task;
  }
  return null;
}

function currentMessageOnly(query: string): ChatMessage[] {
  return query ? [{ role: "user", content: query }] : [];
}

function prepareConversationPayload(input: AssistantPayload): AssistantPayload {
  const payload: AssistantPayload = { ...input };
  const query = typeof payload.query === "string" ? payload.query.trim() : typeof payload.message === "string" ? payload.message.trim() : "";
  const task = classifyAssistantTask(query);
  const state = normalizeConversationState(payload.conversation_state);
  const messages = sanitizedMessages(payload.messages);
  const priorTask = previousTask(messages, query);

  let resetContext = Boolean(task && priorTask && task !== priorTask);
  if (state?.flow === "order_lookup" && !isOrderFlowContinuation(query, state)) resetContext = true;
  if (isBroadOrderRestart(query)) resetContext = true;

  if (resetContext) {
    payload.conversation_state = null;
    payload.messages = currentMessageOnly(query);
  }

  return payload;
}

async function prepareAssistantRequest(request: Request): Promise<Request> {
  const url = new URL(request.url);
  if (url.pathname !== "/chat" || request.method !== "POST") return request;
  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) return request;

  let payload: AssistantPayload;
  try {
    payload = (await request.clone().json()) as AssistantPayload;
  } catch {
    return request;
  }

  const prepared = prepareConversationPayload(payload);
  if (JSON.stringify(prepared) === JSON.stringify(payload)) return request;

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(prepared),
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const preparedRequest = await prepareAssistantRequest(request);
    const response = await handleRequest(preparedRequest, env, context);
    return addShopifyPreviewCors(response, request, env);
  },
};

export {
  addShopifyPreviewCors,
  classifyAssistantTask,
  isOrderFlowContinuation,
  normalizeShopifyOrigin,
  prepareConversationPayload,
};
