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
};
type OrderConversationState = {
  flow?: unknown;
  next_step?: unknown;
  order_number?: unknown;
  email?: unknown;
};

function normalizeEmail(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  return match ? match[0] : "";
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

async function maybeHandleOrderEmailContinuation(
  request: Request,
  env: WorkerEnv,
  context: WorkerExecutionContext,
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

  const safeRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(safePayload),
  });
  const response = await handleRequest(safeRequest, env, context);
  return addShopifyPreviewCors(response, request, env);
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const emailContinuation = await maybeHandleOrderEmailContinuation(request, env, context);
    if (emailContinuation) return emailContinuation;
    return baseWorker.fetch(request, env, context);
  },
};
