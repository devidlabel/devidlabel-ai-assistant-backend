import { handleRequest } from "./index";
import baseWorker, { addShopifyPreviewCors } from "./worker";

type WorkerEnv = Parameters<typeof handleRequest>[1];
type WorkerExecutionContext = NonNullable<Parameters<typeof handleRequest>[2]>;
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
type OrderConversationState = {
  flow?: unknown;
  next_step?: unknown;
  order_number?: unknown;
  email?: unknown;
};
type OrderTrackingItem = {
  company?: unknown;
  number?: unknown;
  url?: unknown;
};
type OrderLookupDetails = {
  fulfillment_state?: unknown;
  tracking_items?: unknown;
  cash_on_delivery_note?: unknown;
};
type OrderLookupPayload = {
  ok?: boolean;
  status?: string;
  next_step?: string;
  message?: string;
  order_lookup?: unknown;
  guardrails?: string[];
};

function normalizeEmail(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0] : "";
}

function normalizeText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeStoredOrderNumber(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .trim();
  const match = normalized.match(/^#?\s*(\d{3,12})$/);
  return match ? match[1] : "";
}

function normalizeConversationState(value: unknown): OrderConversationState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as OrderConversationState;
}

function normalizeOrderDetails(value: unknown): OrderLookupDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as OrderLookupDetails;
}

function normalizeTrackingItems(value: unknown): Array<{ company: string; number: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as OrderTrackingItem;
    const company = normalizeText(item.company, 80);
    const number = normalizeText(item.number, 120);
    const url = safeTrackingUrl(item.url);
    return company || number || url ? [{ company, number, url }] : [];
  });
}

function safeTrackingUrl(value: unknown): string {
  const raw = normalizeText(value, 1000);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function responseLanguage(payload: AssistantPayload): "it" | "en" {
  const values = [payload.language, payload.locale]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  return values.some((value) => value === "en" || value.startsWith("en-") || value.startsWith("en_")) ? "en" : "it";
}

function scrubEmailFromMessages(value: unknown, replacement: string): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const entry = message as Record<string, unknown>;
    if (typeof entry.content !== "string" || !normalizeEmail(entry.content)) return entry;
    return { ...entry, content: replacement };
  });
}

export function buildSafeOrderEmailContinuationPayload(input: AssistantPayload): AssistantPayload | null {
  const state = normalizeConversationState(input.conversation_state);
  const query = typeof input.query === "string"
    ? input.query.trim()
    : typeof input.message === "string"
      ? input.message.trim()
      : "";
  const email = normalizeEmail(query);
  const orderNumber = normalizeStoredOrderNumber(state?.order_number);

  if (state?.flow !== "order_lookup" || state.next_step !== "email" || !email || !orderNumber) return null;

  const placeholder = responseLanguage(input) === "en" ? "Confirm order email" : "Conferma email ordine";
  return {
    ...input,
    query: placeholder,
    message: placeholder,
    messages: scrubEmailFromMessages(input.messages, placeholder),
    conversation_state: {
      ...state,
      flow: "order_lookup",
      order_number: orderNumber,
      email,
      next_step: "lookup",
    },
  };
}

function orderTitle(status: string, language: "it" | "en"): string {
  const copy = language === "en"
    ? {
        marketplace_unsupported: "Marketplace order",
        ask_email: "Order number received",
        found: "Order status",
        email_mismatch: "Check the order email",
        not_found: "Order not found",
        temporarily_unavailable: "Order check unavailable",
        invalid_input: "Check order number",
      }
    : {
        marketplace_unsupported: "Ordine marketplace",
        ask_email: "Numero ordine ricevuto",
        found: "Stato ordine",
        email_mismatch: "Controlla l’e-mail dell’ordine",
        not_found: "Ordine non trovato",
        temporarily_unavailable: "Verifica ordine non disponibile",
        invalid_input: "Controlla il numero ordine",
      };
  return copy[status as keyof typeof copy] || (language === "en" ? "Order status" : "Stato ordine");
}

function trackingSummary(
  lookup: OrderLookupPayload,
  language: "it" | "en",
): { message: string; primaryCta: { label: string; url: string } | null } {
  const details = normalizeOrderDetails(lookup.order_lookup);
  const items = normalizeTrackingItems(details?.tracking_items);
  if (!items.length) {
    return {
      message: normalizeText(lookup.message) || (language === "en"
        ? "I could not complete the order check right now. Please try again shortly."
        : "Non riesco a completare ora la verifica dell’ordine. Riprova tra poco."),
      primaryCta: null,
    };
  }

  const first = items[0];
  const carrier = first.company || (language === "en" ? "the courier" : "il corriere");
  const numberPart = first.number
    ? language === "en"
      ? ` Your tracking number is ${first.number}.`
      : ` Il codice di tracking è ${first.number}.`
    : "";
  const multiplePart = items.length > 1
    ? language === "en"
      ? ` This order has ${items.length} separate shipments.`
      : ` Per questo ordine sono previste ${items.length} spedizioni separate.`
    : "";
  const delivered = normalizeText(details?.fulfillment_state, 40).toLowerCase() === "delivered";
  const message = language === "en"
    ? delivered
      ? `Your order appears to have been delivered by ${carrier}.${numberPart}${multiplePart}`
      : `Your order has been shipped and is now with ${carrier}.${numberPart}${multiplePart}`
    : delivered
      ? `Il tuo ordine risulta consegnato da ${carrier}.${numberPart}${multiplePart}`
      : `Il tuo ordine è stato spedito ed è ora affidato a ${carrier}.${numberPart}${multiplePart}`;

  return {
    message,
    primaryCta: first.url
      ? {
          label: language === "en"
            ? items.length > 1 ? "Track the first shipment" : "Track shipment"
            : items.length > 1 ? "Segui la prima spedizione" : "Segui la spedizione",
          url: first.url,
        }
      : null,
  };
}

export function orderChatResponse(
  lookup: OrderLookupPayload,
  payload: AssistantPayload,
  orderNumber: string,
  email: string,
  lookupResponse: Response,
): Response {
  const language = responseLanguage(payload);
  const status = typeof lookup.status === "string" ? lookup.status : "temporarily_unavailable";
  const lookupNextStep = typeof lookup.next_step === "string" ? lookup.next_step : "order_number";
  const nextStep = status === "ask_email" || status === "email_mismatch"
    ? "email"
    : status === "found" || status === "marketplace_unsupported"
      ? "none"
      : "order_number";
  const needsInput = nextStep !== "none";
  const missingFields = nextStep === "email" ? ["email"] : nextStep === "order_number" ? ["order_number"] : [];
  const conversationState = {
    flow: "order_lookup",
    ...(orderNumber ? { order_number: orderNumber } : {}),
    ...(email ? { email } : {}),
    next_step: nextStep,
  };
  const tracking = status === "found"
    ? trackingSummary(lookup, language)
    : {
        message: normalizeText(lookup.message) || (language === "en"
          ? "I could not complete the order check right now. Please try again shortly."
          : "Non riesco a completare ora la verifica dell’ordine. Riprova tra poco."),
        primaryCta: null,
      };

  const body = {
    ok: true,
    source: "ai_backend",
    type: "order_help",
    title: orderTitle(status, language),
    message: tracking.message,
    primary_cta: tracking.primaryCta,
    recommended_products: [],
    devid_label_alternatives: [],
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

  const headers = new Headers(lookupResponse.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status: 200, headers });
}

async function maybeHandleOrderEmailContinuation(
  request: Request,
  env: WorkerEnv,
  _context: WorkerExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/chat" || request.method !== "POST") return null;
  if (!(request.headers.get("Content-Type") || "").toLowerCase().includes("application/json")) return null;

  let payload: AssistantPayload;
  try {
    payload = (await request.clone().json()) as AssistantPayload;
  } catch {
    return null;
  }

  const safePayload = buildSafeOrderEmailContinuationPayload(payload);
  if (!safePayload) return null;

  const state = normalizeConversationState(safePayload.conversation_state);
  const orderNumber = normalizeStoredOrderNumber(state?.order_number);
  const email = normalizeEmail(state?.email);
  if (!orderNumber || !email) return null;

  const lookupUrl = new URL("/order/lookup", request.url);
  const lookupRequest = new Request(lookupUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(request.headers.get("Origin") ? { Origin: request.headers.get("Origin") as string } : {}),
    },
    body: JSON.stringify({
      order_number: orderNumber,
      query: orderNumber,
      email,
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

  return addShopifyPreviewCors(
    orderChatResponse(lookup, payload, orderNumber, email, lookupResponse),
    request,
    env,
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const emailContinuation = await maybeHandleOrderEmailContinuation(request, env, context);
    if (emailContinuation) return emailContinuation;
    return baseWorker.fetch(request, env, context);
  },
};
