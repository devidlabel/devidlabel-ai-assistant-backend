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
  locale?: unknown;
  language?: unknown;
  path?: unknown;
  page_context?: unknown;
};
type OrderLookupPayload = {
  ok?: boolean;
  status?: string;
  next_step?: string;
  message?: string;
  order_lookup?: unknown;
  guardrails?: string[];
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

function normalizeOrderNumber(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const match = text.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10)).match(/#?\s*(\d{3,12})\b/);
  return match ? match[1] : "";
}

function normalizeEmail(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0] : "";
}

function hasOrderNumber(value: string): boolean {
  return Boolean(normalizeOrderNumber(value));
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

  // A fresh number always replaces the previous number while the customer is inside the order flow.
  // This prevents a mistyped order from falling through to product advice when the assistant was asking for email.
  if (hasOrderNumber(query)) return true;
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

function responseLanguage(payload: AssistantPayload): "it" | "en" {
  const values = [payload.language, payload.locale]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return values.some((value) => value === "en" || value.startsWith("en-") || value.startsWith("en_")) ? "en" : "it";
}

function orderTitle(status: string, language: "it" | "en"): string {
  const copy = language === "en"
    ? {
        marketplace_unsupported: "Marketplace order",
        ask_email: "Order number received",
        found: "Order status",
        not_found: "Order not found",
        temporarily_unavailable: "Order check unavailable",
        invalid_input: "Check order number",
      }
    : {
        marketplace_unsupported: "Ordine marketplace",
        ask_email: "Numero ordine ricevuto",
        found: "Stato ordine",
        not_found: "Ordine non trovato",
        temporarily_unavailable: "Verifica ordine non disponibile",
        invalid_input: "Controlla il numero ordine",
      };
  return copy[status as keyof typeof copy] || (language === "en" ? "Order status" : "Stato ordine");
}

function assistantOrderResponse(lookup: OrderLookupPayload, payload: AssistantPayload, orderNumber: string, email: string, lookupResponse: Response): Response {
  const language = responseLanguage(payload);
  const status = typeof lookup.status === "string" ? lookup.status : "temporarily_unavailable";
  const lookupNextStep = typeof lookup.next_step === "string" ? lookup.next_step : "order_number";
  const nextStep = status === "ask_email" ? "email" : status === "found" || status === "marketplace_unsupported" ? "none" : "order_number";
  const needsInput = nextStep !== "none";
  const missingFields = nextStep === "email" ? ["email"] : nextStep === "order_number" ? ["order_number"] : [];
  const conversationState = {
    flow: "order_lookup",
    ...(orderNumber ? { order_number: orderNumber } : {}),
    ...(email ? { email } : {}),
    next_step: nextStep,
  };

  const body = {
    ok: true,
    source: "ai_backend",
    type: "order_help",
    title: orderTitle(status, language),
    message: typeof lookup.message === "string" && lookup.message.trim()
      ? lookup.message
      : language === "en"
        ? "I could not complete the order check right now. Please try again shortly."
        : "Non riesco a completare ora la verifica dell’ordine. Riprova tra poco.",
    primary_cta: null,
    devid_label_alternatives: [],
    recommended_products: [],
    cross_sell: [],
    requires_backend_order_lookup: true,
    needs_input: needsInput,
    missing_fields: missingFields,
    order_lookup: {
      status,
      next_step: lookupNextStep,
      ...(status === "found" && lookup.order_lookup ? { details: lookup.order_lookup } : {}),
    },
    conversation_state: conversationState,
    suggested_replies: [],
    guardrails: Array.isArray(lookup.guardrails) ? lookup.guardrails : [],
  };

  // Preserve the CORS decision already produced by the canonical /order/lookup handler.
  // This covers both the public storefront origins and Shopify preview origins.
  const headers = new Headers(lookupResponse.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    status: 200,
    headers,
  });
}

async function maybeHandleOrderNumberEarly(request: Request, env: WorkerEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/chat" || request.method !== "POST") return null;
  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) return null;

  let payload: AssistantPayload;
  try {
    payload = (await request.clone().json()) as AssistantPayload;
  } catch {
    return null;
  }

  const query = typeof payload.query === "string" ? payload.query.trim() : typeof payload.message === "string" ? payload.message.trim() : "";
  const state = normalizeConversationState(payload.conversation_state);
  const orderNumber = normalizeOrderNumber(query);
  const belongsToOrderFlow = Boolean(orderNumber && (state?.flow === "order_lookup" || classifyAssistantTask(query) === "order"));
  if (!belongsToOrderFlow) return null;

  const email = normalizeEmail(query) || normalizeEmail(state?.email);
  const internalUrl = new URL("/order/lookup", request.url);
  const lookupRequest = new Request(internalUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(request.headers.get("Origin") ? { Origin: request.headers.get("Origin") as string } : {}),
    },
    body: JSON.stringify({
      order_number: orderNumber,
      query: orderNumber,
      ...(email ? { email } : {}),
      ...(typeof payload.locale === "string" ? { locale: payload.locale } : {}),
      ...(typeof payload.language === "string" ? { language: payload.language } : {}),
      ...(typeof payload.path === "string" ? { path: payload.path } : {}),
      ...(payload.page_context && typeof payload.page_context === "object" ? { page_context: payload.page_context } : {}),
    }),
  });

  const lookupResponse = await handleRequest(lookupRequest, env);
  let lookup: OrderLookupPayload;
  try {
    lookup = (await lookupResponse.clone().json()) as OrderLookupPayload;
  } catch {
    lookup = { status: "temporarily_unavailable", next_step: "order_number", message: "" };
  }
  return assistantOrderResponse(lookup, payload, orderNumber, email, lookupResponse);
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
    const earlyOrderResponse = await maybeHandleOrderNumberEarly(request, env);
    if (earlyOrderResponse) return addShopifyPreviewCors(earlyOrderResponse, request, env);

    const preparedRequest = await prepareAssistantRequest(request);
    const response = await handleRequest(preparedRequest, env, context);
    return addShopifyPreviewCors(response, request, env);
  },
};

export {
  addShopifyPreviewCors,
  classifyAssistantTask,
  isOrderFlowContinuation,
  maybeHandleOrderNumberEarly,
  normalizeShopifyOrigin,
  prepareConversationPayload,
};
