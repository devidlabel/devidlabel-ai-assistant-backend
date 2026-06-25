type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export interface Env {
  OPENAI_API_KEY?: string;
  ASSISTANT_ALLOWED_ORIGINS?: string;
  ASSISTANT_MODEL?: string;
}

type AssistantResponseType = "product_advice" | "faq" | "order_help" | "fallback";

type AssistantCta = {
  label: string;
  url: string;
};

type AssistantSuggestion = {
  label: string;
  message: string;
  url: string;
  type: "product" | "collection" | "search";
};

type AssistantResponse = {
  ok: boolean;
  source: "ai_backend" | "backend_fallback";
  type: AssistantResponseType;
  title: string;
  message: string;
  primary_cta: AssistantCta | null;
  devid_label_alternatives: AssistantSuggestion[];
  cross_sell: AssistantSuggestion[];
  requires_backend_order_lookup: boolean;
  guardrails: string[];
};

type ErrorResponse = { ok: false; source: "ai_backend"; type: "error"; message: string; guardrails: string[] };

type CartItem = {
  vendor?: unknown;
  product_type?: unknown;
  title?: unknown;
  variant?: unknown;
};

type SanitizedPayload = {
  query: string;
  locale?: string;
  page_context?: { page_type?: string; path?: string };
  cart_context: Array<Record<string, string>>;
  knowledge_version?: string;
  guardrails: string[];
};

const DEFAULT_ALLOWED_ORIGINS = ["https://devidlabel.com", "https://www.devidlabel.com"];
const ALLOWED_KEYS = new Set(["query", "locale", "page_context", "cart_context", "knowledge_version"]);
const ASSISTANT_TYPES: AssistantResponseType[] = ["product_advice", "faq", "order_help", "fallback"];
const SENSITIVE_KEY_PATTERN = /(email|mail|phone|telefono|tel|first.?name|last.?name|nome|cognome|address|indirizzo|payment|card|customer.?id|order.?id|ordine|token|access.?token|password|secret)/i;

const SAFE_DESTINATIONS = {
  mosca: {
    label: "T-shirt Mosca Devid Label",
    message: "Alternativa Devid Label in jersey, essenziale e facile da abbinare.",
    url: "/products/devid-label-t-shirt-100-cotone-scollo-a-v-bianco-mosca-dlmosca-bianco",
    type: "product",
  },
  monterosso: {
    label: "Monterosso Devid Label",
    message: "Alternativa in filo di cotone extrafine, più premium.",
    url: "/products/devid-label-t-shirt-in-filo-100-cotone-monterosso-panna-dlmonterosso-mt25100-panna",
    type: "product",
  },
  globe: {
    label: "Jeans Globe Devid Label",
    message: "Alternativa denim Devid Label coerente.",
    url: "/products/devid-label-jeans-globe-medium-blue-dldenimglobeess105",
    type: "product",
  },
  courmayeur: {
    label: "Cargo Courmayeur Devid Label",
    message: "Cargo Devid Label continuativo, versatile e quattro stagioni.",
    url: "/products/devid-label-cargo-courmayeur-old-military-dlcourmayer19304-military",
    type: "product",
  },
  bermuda: { label: "Bermuda uomo", message: "Completa il look estivo.", url: "/collections/bermuda-shorts-uomo", type: "collection" },
  teePolo: { label: "T-shirt e polo uomo", message: "Scopri le proposte uomo facili da abbinare.", url: "/collections/t-shirt-polo-uomo", type: "collection" },
  mare: { label: "Mare uomo", message: "Costumi e proposte mare uomo.", url: "/collections/moda-mare-uomo", type: "collection" },
  saintBarthSearch: { label: "Vedi risultati Saint Barth", message: "Apri la ricerca MC2 Saint Barth t-shirt uomo.", url: "/search?type=product&q=mc2%20saint%20barth%20t-shirt%20uomo", type: "search" },
  replaySearch: { label: "Vedi risultati Replay", message: "Apri la ricerca Replay jeans uomo.", url: "/search?type=product&q=replay%20jeans%20uomo", type: "search" },
  spraygroundSearch: { label: "Vedi risultati Sprayground", message: "Apri la ricerca Sprayground.", url: "/search?type=product&q=sprayground", type: "search" },
  kwaySearch: { label: "Vedi risultati K-Way", message: "Apri la ricerca K-Way.", url: "/search?type=product&q=k-way", type: "search" },
} as const satisfies Record<string, AssistantSuggestion>;

const ALLOWED_SUGGESTION_URLS: Set<string> = new Set(Object.values(SAFE_DESTINATIONS).map((item) => item.url));
const ALLOWED_CTA_URLS: Set<string> = ALLOWED_SUGGESTION_URLS;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

export async function handleRequest(request: Request, env: Env, _ctx?: ExecutionContext): Promise<Response> {
  const corsHeaders = buildCorsHeaders(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/chat") {
    return json({ ok: false, source: "ai_backend", type: "error", message: "Endpoint non trovato.", guardrails: [] }, 404, corsHeaders);
  }

  if (request.method !== "POST") {
    return json({ ok: false, source: "ai_backend", type: "error", message: "Metodo non supportato.", guardrails: [] }, 405, {
      ...corsHeaders,
      Allow: "POST, OPTIONS",
    });
  }

  const parsed = await parseAndValidatePayload(request);
  if (!parsed.ok) {
    return json(parsed.error, 400, corsHeaders);
  }

  const deterministic = routeDeterministicIntent(parsed.payload, "ai_backend");
  if (deterministic) return json(deterministic, 200, corsHeaders);

  const fallback = buildFallbackResponse(parsed.payload);
  if (!env.OPENAI_API_KEY) {
    return json({ ...fallback, guardrails: [...fallback.guardrails, "missing_api_key"] }, 200, corsHeaders);
  }

  try {
    const aiResponse = await callOpenAI(parsed.payload, env);
    return json(aiResponse, 200, corsHeaders);
  } catch (error) {
    console.error("AI provider failed", error instanceof Error ? error.message : "unknown_error");
    return json({ ...fallback, guardrails: [...fallback.guardrails, "provider_fallback"] }, 200, corsHeaders);
  }
}

function buildCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = parseAllowedOrigins(env.ASSISTANT_ALLOWED_ORIGINS);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function parseAllowedOrigins(value?: string): string[] {
  const configured = value?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : DEFAULT_ALLOWED_ORIGINS;
}

async function parseAndValidatePayload(request: Request): Promise<{ ok: true; payload: SanitizedPayload } | { ok: false; error: ErrorResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, error: validationError("JSON non valido.", ["invalid_json"]) };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: validationError("Payload non valido.", ["invalid_payload"]) };
  }

  const input = body as Record<string, unknown>;
  const guardrails: string[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      guardrails.push(SENSITIVE_KEY_PATTERN.test(key) ? `ignored_sensitive_field:${key}` : `ignored_extra_field:${key}`);
    }
  }

  const query = normalizeString(input.query, 500);
  if (!query) {
    return { ok: false, error: validationError("Il campo query è obbligatorio.", guardrails.concat("missing_query")) };
  }

  const cart = Array.isArray(input.cart_context) ? input.cart_context.slice(0, 10) : [];
  if (Array.isArray(input.cart_context) && input.cart_context.length > 10) guardrails.push("cart_context_truncated");

  return {
    ok: true,
    payload: {
      query,
      locale: normalizeString(input.locale, 20) || "it-IT",
      page_context: sanitizePageContext(input.page_context),
      cart_context: cart.map(sanitizeCartItem),
      knowledge_version: normalizeString(input.knowledge_version, 50),
      guardrails,
    },
  };
}

function validationError(message: string, guardrails: string[]): ErrorResponse {
  return { ok: false, source: "ai_backend", type: "error", message, guardrails };
}

function sanitizePageContext(value: unknown): SanitizedPayload["page_context"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const page = value as Record<string, unknown>;
  return { page_type: normalizeString(page.page_type, 100), path: normalizeString(page.path, 200) };
}

function sanitizeCartItem(value: unknown): Record<string, string> {
  const item = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as CartItem;
  return {
    vendor: normalizeString(item.vendor, 200),
    product_type: normalizeString(item.product_type, 200),
    title: normalizeString(item.title, 200),
    variant: normalizeString(item.variant, 200),
  };
}

function normalizeString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function callOpenAI(payload: SanitizedPayload, env: Env): Promise<AssistantResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.ASSISTANT_MODEL || "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: JSON.stringify(payload) },
        ],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`provider_status_${response.status}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("provider_empty_content");
    return normalizeAssistantResponse(JSON.parse(content), payload.query, payload.guardrails);
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(): string {
  return `Rispondi sempre in italiano con tono commerciale sintetico.
Devi restituire SOLO JSON valido.
Non usare markdown.
Non usare testo fuori dal JSON.
Il JSON deve rispettare esattamente questo schema: {"ok":true,"source":"ai_backend","type":"product_advice|faq|order_help|fallback","title":"string","message":"string","primary_cta":{"label":"string","url":"string"}|null,"devid_label_alternatives":[{"label":"string","message":"string","url":"string","type":"product|collection|search"}],"cross_sell":[{"label":"string","message":"string","url":"string","type":"product|collection|search"}],"requires_backend_order_lookup":false,"guardrails":[]}.
"devid_label_alternatives" e "cross_sell" devono essere array di oggetti, mai stringhe.
"requires_backend_order_lookup" deve essere true solo per richieste su stato ordine/tracking; per richieste prodotto e FAQ deve essere sempre false.
Non inventare prodotti, label, URL, prezzi, disponibilità, tracking o status ordine.
Puoi usare solo URL già presenti nel payload o nella conoscenza sicura del backend; se non sei sicuro, usa primary_cta null e array vuoti.
Devid Label è un brand proprietario; i brand esterni venduti sono originali.
InPost è disponibile scegliendo Locker/Punto InPost; il contrassegno è disponibile solo con spedizione a domicilio e non con InPost.
Non si spedisce sabato/domenica. Non dire Made in Italy se non verificato.
Se non sai, usa type fallback e arrays vuoti.`;
}

function normalizeAssistantResponse(raw: unknown, query: string, guardrails: string[]): AssistantResponse {
  const deterministic = routeDeterministicIntent({ query, guardrails }, "ai_backend");
  if (deterministic) return deterministic;

  const fallback = buildFallbackResponse({ query, guardrails });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback;

  const data = raw as Record<string, unknown>;
  const type = isAssistantType(data.type) ? data.type : deriveTypeFromQuery(query);
  const safeType = type === "order_help" && !isOrderQuery(query) ? deriveTypeFromQuery(query) : type;

  return {
    ok: true,
    source: "ai_backend",
    type: safeType,
    title: normalizeString(data.title, 120) || fallback.title,
    message: normalizeString(data.message, 800) || fallback.message,
    primary_cta: normalizeCta(data.primary_cta),
    devid_label_alternatives: normalizeSuggestionArray(data.devid_label_alternatives, true),
    cross_sell: normalizeSuggestionArray(data.cross_sell, false),
    requires_backend_order_lookup: isOrderQuery(query),
    guardrails,
  };
}

function normalizeCta(value: unknown): AssistantCta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const cta = value as Record<string, unknown>;
  const label = normalizeString(cta.label, 80);
  const url = normalizeString(cta.url, 300);
  if (!label || !url || !ALLOWED_CTA_URLS.has(url)) return null;
  return { label, url };
}

function normalizeSuggestionArray(value: unknown, onlyDevidLabel: boolean): AssistantSuggestion[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const output: AssistantSuggestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const suggestion = item as Record<string, unknown>;
    const url = normalizeString(suggestion.url, 300);
    if (!url || !ALLOWED_SUGGESTION_URLS.has(url) || seen.has(url)) continue;
    const safe = Object.values(SAFE_DESTINATIONS).find((destination) => destination.url === url);
    if (!safe) continue;
    if (onlyDevidLabel && !safe.label.toLowerCase().includes("devid label")) continue;
    seen.add(url);
    output.push({ ...safe });
    if (output.length === 3) break;
  }
  return output;
}

function isAssistantType(value: unknown): value is AssistantResponseType {
  return typeof value === "string" && ASSISTANT_TYPES.includes(value as AssistantResponseType);
}

function deriveTypeFromQuery(query: string): AssistantResponseType {
  if (isOrderQuery(query)) return "order_help";
  if (isFaqQuery(query)) return "faq";
  if (isProductQuery(query)) return "product_advice";
  return "fallback";
}

function routeDeterministicIntent(payload: Pick<SanitizedPayload, "query" | "guardrails">, source: AssistantResponse["source"]): AssistantResponse | null {
  const query = normalizeQuery(payload.query);
  const base = responseBase(source, payload.guardrails);

  if (hasAny(query, ["t-shirt saint barth uomo", "tshirt saint barth uomo", "mc2 saint barth t-shirt uomo", "saint barth uomo t-shirt"])) {
    return {
      ...base,
      type: "product_advice",
      title: "T-shirt MC2 Saint Barth uomo",
      message: "Ti mostro prima le proposte MC2 Saint Barth coerenti con la tua ricerca.",
      primary_cta: cta(SAFE_DESTINATIONS.saintBarthSearch),
      devid_label_alternatives: [SAFE_DESTINATIONS.mosca, SAFE_DESTINATIONS.monterosso],
      cross_sell: [SAFE_DESTINATIONS.bermuda],
    };
  }

  if (hasAny(query, ["jeans replay uomo", "replay jeans uomo"])) {
    return {
      ...base,
      type: "product_advice",
      title: "Jeans Replay uomo",
      message: "Ti mostro prima i risultati Replay coerenti con la tua ricerca.",
      primary_cta: cta(SAFE_DESTINATIONS.replaySearch),
      devid_label_alternatives: [SAFE_DESTINATIONS.globe],
      cross_sell: [SAFE_DESTINATIONS.teePolo],
    };
  }

  if (hasAny(query, ["cargo uomo", "cargo devid label", "courmayeur"])) {
    return {
      ...base,
      type: "product_advice",
      title: "Cargo uomo Devid Label",
      message: "Ti propongo il Cargo Courmayeur Devid Label come scelta versatile e continuativa.",
      primary_cta: cta(SAFE_DESTINATIONS.courmayeur),
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.mosca, SAFE_DESTINATIONS.monterosso, SAFE_DESTINATIONS.teePolo],
    };
  }

  if (hasAny(query, ["zaino sprayground", "sprayground"])) {
    return {
      ...base,
      type: "product_advice",
      title: "Sprayground",
      message: "Ti mostro i risultati Sprayground disponibili nella ricerca del negozio.",
      primary_cta: cta(SAFE_DESTINATIONS.spraygroundSearch),
      devid_label_alternatives: [],
      cross_sell: [],
    };
  }

  if (hasAny(query, ["k-way", "kway"])) {
    return {
      ...base,
      type: "product_advice",
      title: "K-Way",
      message: "Ti mostro i risultati K-Way coerenti con la tua ricerca.",
      primary_cta: cta(SAFE_DESTINATIONS.kwaySearch),
      devid_label_alternatives: [],
      cross_sell: [],
    };
  }

  if (hasAny(query, ["costume uomo", "mare uomo"])) {
    return {
      ...base,
      type: "product_advice",
      title: "Mare uomo",
      message: "Ti porto alla selezione mare uomo e ti suggerisco abbinamenti estivi coerenti.",
      primary_cta: cta(SAFE_DESTINATIONS.mare),
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.bermuda, SAFE_DESTINATIONS.teePolo],
    };
  }

  if (isOrderQuery(query)) {
    return {
      ...base,
      type: "order_help",
      title: "Dov’è il mio ordine?",
      message: "In questa versione non posso ancora verificare automaticamente tracking o stato ordine. Non invento dati di spedizione: per il controllo reale servirà un lookup backend sicuro collegato agli ordini.",
      requires_backend_order_lookup: true,
    };
  }

  if (/pagamento alla consegna|contrassegno/.test(query)) {
    return { ...base, type: "faq", title: "Pagamento alla consegna", message: "Il pagamento alla consegna è disponibile con spedizione a domicilio. Non è disponibile con InPost, Locker o Punto InPost." };
  }
  if (/prodotti originali|sono originali|original/.test(query)) {
    return { ...base, type: "faq", title: "Prodotti originali", message: "I prodotti dei brand esterni venduti da Devid Label sono originali. Devid Label propone anche capi del proprio brand come alternative o abbinamenti coerenti." };
  }
  if (/inpost/.test(query)) {
    return { ...base, type: "faq", title: "InPost", message: "InPost è disponibile scegliendo Locker o Punto InPost. Il pagamento alla consegna non è disponibile con questa modalità." };
  }
  if (/spedizione|tempi di spedizione/.test(query)) {
    return { ...base, type: "faq", title: "Tempi di spedizione", message: "Gli ordini vengono gestiti nei giorni lavorativi. Non vengono effettuate spedizioni il sabato e la domenica." };
  }
  if (/reso|cambio taglia|guida taglie/.test(query)) {
    return { ...base, type: "faq", title: "Resi, cambi e taglie", message: "Per resi, cambi taglia e guida taglie segui le indicazioni presenti nel negozio. In questa versione non apro pratiche né verifico ordini reali." };
  }

  return null;
}

function buildFallbackResponse(payload: Pick<SanitizedPayload, "query" | "guardrails">): AssistantResponse {
  return routeDeterministicIntent(payload, "backend_fallback") ?? {
    ...responseBase("backend_fallback", payload.guardrails),
    type: "fallback",
    title: "Assistente Devid Label",
    message: "Posso aiutarti con consigli prodotto, informazioni su spedizioni, InPost, contrassegno e supporto ordine. Prova a cercare un brand, una categoria o una domanda specifica.",
  };
}

function responseBase(source: AssistantResponse["source"], guardrails: string[]): AssistantResponse {
  return { ok: true, source, type: "fallback", title: "", message: "", primary_cta: null, devid_label_alternatives: [], cross_sell: [], requires_backend_order_lookup: false, guardrails };
}

function cta(destination: AssistantSuggestion): AssistantCta {
  return { label: destination.label, url: destination.url };
}

function isOrderQuery(query: string): boolean {
  return /dov.?e il mio ordine|tracking ordine|stato ordine|tracking|ordine/.test(normalizeQuery(query));
}

function isFaqQuery(query: string): boolean {
  return /pagamento alla consegna|contrassegno|prodotti originali|sono originali|original|inpost|spedizione|tempi di spedizione|reso|cambio taglia|guida taglie/.test(normalizeQuery(query));
}

function isProductQuery(query: string): boolean {
  return /t-?shirt|tshirt|saint barth|replay|jeans|cargo|courmayeur|sprayground|k-?way|costume|mare uomo|bermuda|polo/.test(normalizeQuery(query));
}

function normalizeQuery(query: string): string {
  return query.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, " ").replace(/\s+/g, " ").trim();
}

function hasAny(query: string, needles: string[]): boolean {
  return needles.some((needle) => query.includes(needle));
}

function json(body: AssistantResponse | ErrorResponse, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}
