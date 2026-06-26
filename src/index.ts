type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

export interface Env {
  OPENAI_API_KEY?: string;
  ASSISTANT_ALLOWED_ORIGINS?: string;
  ASSISTANT_MODEL?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS?: string;
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
  image?: string;
};

type NormalizedQuery = {
  rawQuery: string;
  normalizedQuery: string;
  correctedQuery: string;
  matchedIntent: ProductIntent | null;
  confidence: number;
  matchedAliases: string[];
};

type ProductIntent =
  | "mc2_saint_barth"
  | "sprayground"
  | "jeans_globe_devid_label"
  | "cargo_courmayeur_devid_label"
  | "tshirt_mosca_devid_label"
  | "monterosso_devid_label"
  | "jeans_replay_uomo"
  | "kway"
  | "mare_uomo"
  | "bermuda_uomo";

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
  recommended_products?: AssistantSuggestion[];
  normalized_query?: { raw: string; normalized: string; corrected: string; intent: ProductIntent | null; confidence: number; aliases: string[] };
  intent?: ProductIntent | null;
  confidence?: number;
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
const DEFAULT_SHOPIFY_API_VERSION = "2025-10";
const DEFAULT_RECOMMENDATION_CACHE_TTL_SECONDS = 3600;
const SHOPIFY_TIMEOUT_MS = 4500;
const OPENAI_TIMEOUT_MS = 7000;

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


const INTENT_ALIASES: Record<ProductIntent, { correctedQuery: string; aliases: string[] }> = {
  mc2_saint_barth: { correctedQuery: "mc2 saint barth", aliases: ["saint barth", "mc2 saint barth", "mc2", "san barth", "san bart", "san bat", "sain barth", "sain bart", "saint bart", "saint bat", "mc2 san", "mc2 san barth", "mc2 saint", "mc2 saint bart"] },
  sprayground: { correctedQuery: "sprayground", aliases: ["sprayground", "spray ground", "spryground", "sprygrund", "sprygrounf", "spraygrund", "spraygroun", "spraygr", "spry"] },
  jeans_globe_devid_label: { correctedQuery: "jeans globe devid label", aliases: ["jeans globe", "globe", "denim globe", "pantalone globe", "jeans devid label", "jeans dl", "globe devid label"] },
  cargo_courmayeur_devid_label: { correctedQuery: "cargo courmayeur devid label", aliases: ["cargo courmayeur", "courmayeur", "courma", "cargo uomo", "cargo devid label", "pantalone cargo", "courmayer", "courmay"] },
  tshirt_mosca_devid_label: { correctedQuery: "t-shirt mosca devid label", aliases: ["mosca", "t-shirt mosca", "tshirt mosca", "tee mosca", "maglia mosca", "t shirt scollo v", "t-shirt scollo v", "scollo a v uomo"] },
  monterosso_devid_label: { correctedQuery: "monterosso devid label", aliases: ["monterosso", "t-shirt monterosso", "tshirt monterosso", "maglia monterosso", "filo monterosso", "cotone monterosso"] },
  jeans_replay_uomo: { correctedQuery: "jeans replay uomo", aliases: ["jeans replay", "jeans replay uomo", "replay jeans", "replay jeans uomo", "denim replay"] },
  kway: { correctedQuery: "k-way", aliases: ["kway", "k-way", "kayway", "kwai", "giacca kway", "giacca k-way"] },
  mare_uomo: { correctedQuery: "mare uomo", aliases: ["costume uomo", "costumi uomo", "mare uomo", "boxer mare", "costume saint barth uomo", "mc2 costume uomo"] },
  bermuda_uomo: { correctedQuery: "bermuda uomo", aliases: ["bermuda uomo", "short uomo", "shorts uomo", "bermuda", "shorts"] },
};

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

  const normalized = normalizeQuery(parsed.payload.query);
  const deterministic = routeDeterministicIntent(parsed.payload, "ai_backend", normalized);
  if (deterministic) return json(await enrichProductRecommendations(deterministic, env, normalized), 200, corsHeaders);

  const fallback = buildFallbackResponse(parsed.payload);
  if (!env.OPENAI_API_KEY) {
    return json({ ...fallback, guardrails: [...fallback.guardrails, "missing_api_key"] }, 200, corsHeaders);
  }

  try {
    const aiResponse = await callOpenAI(parsed.payload, env);
    return json(await enrichProductRecommendations(aiResponse, env, normalized), 200, corsHeaders);
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
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
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
  const normalized = normalizeQuery(query);
  const deterministic = routeDeterministicIntent({ query, guardrails }, "ai_backend", normalized);
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
    recommended_products: normalizeSuggestionArray(data.recommended_products, false),
    cross_sell: normalizeSuggestionArray(data.cross_sell, false),
    requires_backend_order_lookup: isOrderQuery(query),
    guardrails,
    ...responseContractV2(normalized),
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

function routeDeterministicIntent(payload: Pick<SanitizedPayload, "query" | "guardrails">, source: AssistantResponse["source"], normalized = normalizeQuery(payload.query)): AssistantResponse | null {
  const query = normalized.normalizedQuery;
  const base = responseBase(source, payload.guardrails, normalized);

  if (normalized.matchedIntent === "mc2_saint_barth" || hasAny(query, ["t-shirt saint barth uomo", "tshirt saint barth uomo", "mc2 saint barth t-shirt uomo", "saint barth uomo t-shirt"])) {
    return {
      ...base,
      type: "product_advice",
      title: query.includes("t-shirt") || query.includes("tshirt") ? "T-shirt MC2 Saint Barth uomo" : "MC2 Saint Barth",
      message: "Ti mostro prima le proposte MC2 Saint Barth coerenti con la tua ricerca.",
      primary_cta: cta(SAFE_DESTINATIONS.saintBarthSearch),
      devid_label_alternatives: [SAFE_DESTINATIONS.mosca, SAFE_DESTINATIONS.monterosso],
      cross_sell: [SAFE_DESTINATIONS.bermuda],
    };
  }

  if (normalized.matchedIntent === "jeans_replay_uomo" || hasAny(query, ["jeans replay uomo", "replay jeans uomo"])) {
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

  if (normalized.matchedIntent === "cargo_courmayeur_devid_label" || hasAny(query, ["cargo uomo", "cargo devid label", "courmayeur"])) {
    return {
      ...base,
      type: "product_advice",
      title: "Cargo Courmayeur Devid Label",
      message: "Ti propongo il Cargo Courmayeur Devid Label come scelta versatile e continuativa.",
      primary_cta: cta(SAFE_DESTINATIONS.courmayeur),
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.mosca, SAFE_DESTINATIONS.monterosso, SAFE_DESTINATIONS.teePolo],
    };
  }


  if (normalized.matchedIntent === "jeans_globe_devid_label") {
    return {
      ...base,
      type: "product_advice",
      title: "Jeans Globe Devid Label",
      message: "Ti propongo il Jeans Globe Devid Label come denim coerente con la tua ricerca.",
      primary_cta: cta(SAFE_DESTINATIONS.globe),
      recommended_products: [SAFE_DESTINATIONS.globe],
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.teePolo],
    };
  }

  if (normalized.matchedIntent === "tshirt_mosca_devid_label") {
    return {
      ...base,
      type: "product_advice",
      title: "T-shirt Mosca Devid Label",
      message: "Ti propongo la T-shirt Mosca Devid Label, essenziale e facile da abbinare.",
      primary_cta: cta(SAFE_DESTINATIONS.mosca),
      recommended_products: [SAFE_DESTINATIONS.mosca],
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.bermuda, SAFE_DESTINATIONS.globe],
    };
  }

  if (normalized.matchedIntent === "monterosso_devid_label") {
    return {
      ...base,
      type: "product_advice",
      title: "Monterosso Devid Label",
      message: "Ti propongo Monterosso Devid Label, una scelta in filo di cotone extrafine dal taglio premium.",
      primary_cta: cta(SAFE_DESTINATIONS.monterosso),
      recommended_products: [SAFE_DESTINATIONS.monterosso],
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.bermuda, SAFE_DESTINATIONS.globe],
    };
  }

  if (normalized.matchedIntent === "sprayground" || hasAny(query, ["zaino sprayground", "sprayground"])) {
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

  if (normalized.matchedIntent === "kway" || hasAny(query, ["k-way", "kway"])) {
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

  if (normalized.matchedIntent === "mare_uomo" || hasAny(query, ["costume uomo", "mare uomo"])) {
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
  const normalized = normalizeQuery(payload.query);
  return routeDeterministicIntent(payload, "backend_fallback", normalized) ?? {
    ...responseBase("backend_fallback", payload.guardrails, normalized),
    type: "fallback",
    title: "Assistente Devid Label",
    message: "Posso aiutarti con consigli prodotto, informazioni su spedizioni, InPost, contrassegno e supporto ordine. Prova a cercare un brand, una categoria o una domanda specifica.",
  };
}

function responseBase(source: AssistantResponse["source"], guardrails: string[], normalized?: NormalizedQuery): AssistantResponse {
  return {
    ok: true,
    source,
    type: "fallback",
    title: "",
    message: "",
    primary_cta: null,
    recommended_products: [],
    devid_label_alternatives: [],
    cross_sell: [],
    requires_backend_order_lookup: false,
    guardrails,
    ...(normalized ? responseContractV2(normalized) : {}),
  };
}

function cta(destination: AssistantSuggestion): AssistantCta {
  return { label: destination.label, url: destination.url };
}

function isOrderQuery(query: string): boolean {
  return /dov.?e il mio ordine|tracking ordine|stato ordine|tracking|ordine/.test(normalizeQueryText(query));
}

function isFaqQuery(query: string): boolean {
  return /pagamento alla consegna|contrassegno|prodotti originali|sono originali|original|inpost|spedizione|tempi di spedizione|reso|cambio taglia|guida taglie/.test(normalizeQueryText(query));
}

function isProductQuery(query: string): boolean {
  const normalized = normalizeQuery(query);
  return Boolean(normalized.matchedIntent) || /t-?shirt|tshirt|saint barth|replay|jeans|cargo|courmayeur|sprayground|k-?way|costume|mare uomo|bermuda|polo/.test(normalized.normalizedQuery);
}

function normalizeQuery(input: string): NormalizedQuery {
  const rawQuery = input;
  const normalizedQuery = normalizeQueryText(input);
  const aliasMatch = findAliasMatch(normalizedQuery);
  if (aliasMatch) {
    return {
      rawQuery,
      normalizedQuery,
      correctedQuery: INTENT_ALIASES[aliasMatch.intent].correctedQuery,
      matchedIntent: aliasMatch.intent,
      confidence: aliasMatch.confidence,
      matchedAliases: aliasMatch.aliases,
    };
  }

  return { rawQuery, normalizedQuery, correctedQuery: normalizedQuery, matchedIntent: null, confidence: 0, matchedAliases: [] };
}

function normalizeQueryText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`´]/g, "'")
    .replace(/[^a-z0-9'\s-]/g, " ")
    .replace(/'/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findAliasMatch(query: string): { intent: ProductIntent; confidence: number; aliases: string[] } | null {
  let best: { intent: ProductIntent; confidence: number; aliases: string[]; score: number } | null = null;
  for (const [intent, config] of Object.entries(INTENT_ALIASES) as Array<[ProductIntent, { correctedQuery: string; aliases: string[] }]>) {
    const matches = config.aliases.map(normalizeQueryText).filter((alias) => alias === query || query.includes(alias));
    if (matches.length > 0) {
      const longest = Math.max(...matches.map((alias) => alias.length));
      const exact = matches.some((alias) => alias === query);
      const confidence = exact ? 0.95 : 0.9;
      const score = confidence * 1000 + longest;
      if (!best || score > best.score) best = { intent, confidence, aliases: matches, score };
    }
  }
  return best ? { intent: best.intent, confidence: best.confidence, aliases: best.aliases } : findPartialIntentMatch(query);
}

function findPartialIntentMatch(query: string): { intent: ProductIntent; confidence: number; aliases: string[] } | null {
  const has = (pattern: RegExp) => pattern.test(query);
  if (has(/^(glo|glob)$/)) return { intent: "jeans_globe_devid_label", confidence: 0.86, aliases: [query] };
  if (has(/^(spry|sprayg)$/)) return { intent: "sprayground", confidence: 0.88, aliases: [query] };
  if (has(/^(san ba|saint b)$/)) return { intent: "mc2_saint_barth", confidence: 0.87, aliases: [query] };
  if (has(/^courm$/)) return { intent: "cargo_courmayeur_devid_label", confidence: 0.87, aliases: [query] };
  if (has(/^mosc$/)) return { intent: "tshirt_mosca_devid_label", confidence: 0.87, aliases: [query] };
  if (has(/^(mont|monte)$/)) return { intent: "monterosso_devid_label", confidence: 0.84, aliases: [query] };
  if (has(/^repl$/) && /jeans|denim/.test(query)) return { intent: "jeans_replay_uomo", confidence: 0.84, aliases: [query] };
  if (has(/^repla$/)) return { intent: "jeans_replay_uomo", confidence: 0.86, aliases: [query] };
  if (has(/^(k-w|kwa|kway)$/)) return { intent: "kway", confidence: 0.87, aliases: [query] };
  return null;
}

function responseContractV2(normalized: NormalizedQuery): Pick<AssistantResponse, "normalized_query" | "intent" | "confidence"> {
  return {
    normalized_query: {
      raw: normalized.rawQuery,
      normalized: normalized.normalizedQuery,
      corrected: normalized.correctedQuery,
      intent: normalized.matchedIntent,
      confidence: normalized.confidence,
      aliases: normalized.matchedAliases,
    },
    intent: normalized.matchedIntent,
    confidence: normalized.confidence,
  };
}


function hasAny(query: string, needles: string[]): boolean {
  return needles.some((needle) => query.includes(needle));
}

function json(body: AssistantResponse | ErrorResponse, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

type CandidateIntent = {
  intent: string;
  vendor: string;
  queryTerms: string[];
  productTerms: string[];
  categories: string[];
  gender?: "uomo" | "donna";
  forceNoDevidAlternatives?: boolean;
  alternativeIntents?: ProductIntent[];
};

type SalesStats = { productId: string; variantIds: string[]; unitsSold30d: number; revenue30d?: number; lastSoldAt?: string };
type ProductVariantCandidate = { variantId: string; title: string; selectedOptions: Array<{ name: string; value: string }>; inventoryQuantity?: number | null; availableForSale?: boolean | null };
type ProductCandidate = { productId: string; title: string; handle: string; vendor: string; productType: string; tags: string[]; image?: string; onlineStoreUrl?: string; status?: string; publishedAt?: string | null; variants: ProductVariantCandidate[] };
type AvailabilityResult = { isAvailableForRecommendation: boolean; availabilityRatio: number; availableVariantCount: number; totalVariantCount: number; isOneSize: boolean };
type RankedRecommendation = ProductCandidate & { salesStats?: SalesStats; availability: AvailabilityResult; coherenceScore: number };
type RecommendationSnapshot = { recommended_products: AssistantSuggestion[]; devid_label_alternatives: AssistantSuggestion[]; guardrails: string[]; expiresAt: number };

type ShopifyOrdersData = { orders: { edges: Array<{ node: { processedAt: string; lineItems: { edges: Array<{ node: { quantity: number; discountedTotalSet?: { shopMoney?: { amount?: string } }; product?: { id: string; vendor: string; title: string; productType: string; tags: string[] }; variant?: { id: string } } }> } } }> } };
type ShopifyProductsData = { products: { edges: Array<{ node: { id: string; title: string; handle: string; vendor: string; productType: string; tags: string[]; onlineStoreUrl?: string; status?: string; publishedAt?: string | null; featuredImage?: { url: string }; variants: { edges: Array<{ node: { id: string; title: string; selectedOptions: Array<{ name: string; value: string }>; inventoryQuantity?: number | null; availableForSale?: boolean | null } }> } } }> } };

const recommendationCache = new Map<string, RecommendationSnapshot>();
const KNOWN_VENDORS = ["Colmar Originals", "MC2 Saint Barth", "Sprayground", "Replay", "K-Way", "Palm Angels", "Mou", "Rains", "Goorin Bros", "Flower Mountain", "4B12", "Puraai", "G-Star", "Distretto12", "Ko Samui", "Devid Label"];
const INTENT_CANDIDATES: Partial<Record<ProductIntent, Omit<CandidateIntent, "intent">>> = {
  mc2_saint_barth: { vendor: "MC2 Saint Barth", queryTerms: ["saint barth", "mc2"], productTerms: [], categories: ["t-shirt", "polo", "costume", "mare", "beachwear"], alternativeIntents: ["tshirt_mosca_devid_label", "monterosso_devid_label"] },
  sprayground: { vendor: "Sprayground", queryTerms: ["sprayground"], productTerms: [], categories: [], forceNoDevidAlternatives: true },
  jeans_replay_uomo: { vendor: "Replay", queryTerms: ["replay"], productTerms: ["jeans", "denim"], categories: ["jeans", "denim"], gender: "uomo", alternativeIntents: ["jeans_globe_devid_label"] },
  jeans_globe_devid_label: { vendor: "Devid Label", queryTerms: ["globe"], productTerms: ["globe", "jeans", "denim"], categories: ["jeans", "denim"] },
  cargo_courmayeur_devid_label: { vendor: "Devid Label", queryTerms: ["courmayeur"], productTerms: ["cargo", "courmayeur"], categories: ["cargo"], alternativeIntents: ["tshirt_mosca_devid_label", "monterosso_devid_label"] },
  tshirt_mosca_devid_label: { vendor: "Devid Label", queryTerms: ["mosca"], productTerms: ["mosca", "t-shirt", "scollo v"], categories: ["t-shirt"] },
  monterosso_devid_label: { vendor: "Devid Label", queryTerms: ["monterosso"], productTerms: ["monterosso", "cotone", "filo"], categories: ["maglia", "t-shirt"] },
  kway: { vendor: "K-Way", queryTerms: ["k-way", "kway"], productTerms: [], categories: [], forceNoDevidAlternatives: true },
  mare_uomo: { vendor: "MC2 Saint Barth", queryTerms: ["mare", "saint barth"], productTerms: ["costume", "mare", "beachwear"], categories: ["costume", "mare", "beachwear"], gender: "uomo", alternativeIntents: ["tshirt_mosca_devid_label", "monterosso_devid_label"] },
  bermuda_uomo: { vendor: "Devid Label", queryTerms: ["bermuda"], productTerms: ["bermuda", "short"], categories: ["bermuda"], gender: "uomo" },
};

async function enrichProductRecommendations(response: AssistantResponse, env: Env, normalized: NormalizedQuery): Promise<AssistantResponse> {
  if (response.type !== "product_advice") return response;
  const candidate = candidateIntentFromNormalized(normalized);
  if (!candidate) return { ...response, guardrails: [...response.guardrails, "shopify_recommendations_unavailable"] };
  try {
    const snapshot = await getRecommendationSnapshot(env, normalized, candidate);
    return { ...response, recommended_products: snapshot.recommended_products.length ? snapshot.recommended_products : response.recommended_products, devid_label_alternatives: snapshot.devid_label_alternatives.length ? snapshot.devid_label_alternatives : response.devid_label_alternatives, guardrails: [...response.guardrails, ...snapshot.guardrails] };
  } catch (error) {
    console.error("Shopify recommendations unavailable", error instanceof Error ? error.message : "unknown_error");
    return { ...response, guardrails: [...response.guardrails, "shopify_recommendations_unavailable"] };
  }
}

function candidateIntentFromNormalized(normalized: NormalizedQuery): CandidateIntent | null {
  if (normalized.matchedIntent && INTENT_CANDIDATES[normalized.matchedIntent]) return { intent: normalized.matchedIntent, ...INTENT_CANDIDATES[normalized.matchedIntent]! };
  const vendor = KNOWN_VENDORS.find((name) => normalized.normalizedQuery.includes(normalizeQueryText(name)));
  return vendor ? { intent: `vendor:${vendor}`, vendor, queryTerms: [vendor], productTerms: [], categories: [] } : null;
}

async function getRecommendationSnapshot(env: Env, normalized: NormalizedQuery, candidate: CandidateIntent): Promise<RecommendationSnapshot> {
  const ttl = parsePositiveInt(env.SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS, DEFAULT_RECOMMENDATION_CACHE_TTL_SECONDS);
  const key = `v1:${candidate.intent}:${candidate.vendor}:${normalized.correctedQuery}:${candidate.gender ?? "any"}`.toLowerCase();
  const cached = recommendationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached, guardrails: [...cached.guardrails, "shopify_recommendations_cache_hit"] };
  assertShopifyConfigured(env);
  const [products, salesStats] = await Promise.all([fetchCandidateProducts(env, candidate), fetchSalesRankLast30Days(env, candidate)]);
  const ranked = rankRecommendations(products, salesStats, candidate).slice(0, 3);
  const snapshot: RecommendationSnapshot = { recommended_products: ranked.map(toAssistantSuggestion), devid_label_alternatives: await buildDevidLabelAlternatives(env, normalized, candidate), guardrails: [salesStats.size ? "shopify_recommendations_live" : "shopify_recommendations_no_recent_sales_fallback"], expiresAt: Date.now() + ttl * 1000 };
  recommendationCache.set(key, snapshot);
  return snapshot;
}

function assertShopifyConfigured(env: Env): void {
  if (!env.SHOPIFY_SHOP_DOMAIN || !env.SHOPIFY_ADMIN_ACCESS_TOKEN) throw new Error("shopify_config_missing");
}

async function shopifyGraphQL<T>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  assertShopifyConfigured(env);
  const domain = env.SHOPIFY_SHOP_DOMAIN!.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const version = env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_ACCESS_TOKEN!, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), signal: controller.signal });
    if (!response.ok) throw new Error(`shopify_status_${response.status}`);
    const payload = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors?.length) throw new Error("shopify_graphql_error");
    if (!payload.data) throw new Error("shopify_empty_data");
    return payload.data;
  } finally { clearTimeout(timeout); }
}

async function fetchSalesRankLast30Days(env: Env, candidateIntent: CandidateIntent): Promise<Map<string, SalesStats>> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const queryText = `created_at:>=${since} -status:cancelled financial_status:paid OR financial_status:partially_paid`;
  const data = await shopifyGraphQL<ShopifyOrdersData>(env, `query Sales($query: String!) { orders(first: 50, query: $query, sortKey: PROCESSED_AT, reverse: true) { edges { node { processedAt lineItems(first: 50) { edges { node { quantity discountedTotalSet { shopMoney { amount } } product { id vendor title productType tags } variant { id } } } } } } } }`, { query: queryText });
  const stats = new Map<string, SalesStats>();
  for (const edge of data.orders.edges) for (const itemEdge of edge.node.lineItems.edges) {
    const item = itemEdge.node; if (!item.product || !matchesCandidateProduct(item.product, candidateIntent)) continue;
    const current = stats.get(item.product.id) ?? { productId: item.product.id, variantIds: [], unitsSold30d: 0, revenue30d: 0, lastSoldAt: edge.node.processedAt };
    current.unitsSold30d += Math.max(0, item.quantity || 0); if (item.variant?.id && !current.variantIds.includes(item.variant.id)) current.variantIds.push(item.variant.id);
    current.revenue30d = (current.revenue30d ?? 0) + Number(item.discountedTotalSet?.shopMoney?.amount ?? 0); if (!current.lastSoldAt || edge.node.processedAt > current.lastSoldAt) current.lastSoldAt = edge.node.processedAt;
    stats.set(item.product.id, current);
  }
  return stats;
}

async function fetchCandidateProducts(env: Env, candidateIntent: CandidateIntent): Promise<ProductCandidate[]> {
  const terms = [`vendor:'${candidateIntent.vendor.replace(/'/g, "")}'`, ...candidateIntent.productTerms].join(" ");
  const data = await shopifyGraphQL<ShopifyProductsData>(env, `query Products($query: String!) { products(first: 30, query: $query) { edges { node { id title handle vendor productType tags onlineStoreUrl status publishedAt featuredImage { url } variants(first: 50) { edges { node { id title selectedOptions { name value } inventoryQuantity availableForSale } } } } } } }`, { query: terms });
  return data.products.edges.map(({ node }) => ({ productId: node.id, title: node.title, handle: node.handle, vendor: node.vendor, productType: node.productType, tags: node.tags ?? [], image: node.featuredImage?.url, onlineStoreUrl: node.onlineStoreUrl, status: node.status, publishedAt: node.publishedAt, variants: node.variants.edges.map(({ node: variant }) => ({ variantId: variant.id, title: variant.title, selectedOptions: variant.selectedOptions ?? [], inventoryQuantity: variant.inventoryQuantity, availableForSale: variant.availableForSale })) })).filter((product) => matchesCandidateProduct(product, candidateIntent));
}

function computeAvailabilityScore(product: ProductCandidate): AvailabilityResult {
  const variants = product.variants.length ? product.variants : [];
  const isOneSize = variants.length <= 1 || variants.every((v) => /default title|taglia unica|unica|unico|one size/i.test(v.title) || v.selectedOptions.every((o) => /title|taglia|size|numero/i.test(o.name) && /default title|taglia unica|unica|unico|one size/i.test(o.value)));
  const sizeVariants = variants.filter((v) => v.selectedOptions.some((o) => /size|taglia|numero/i.test(o.name)));
  const relevant = isOneSize ? variants.slice(0, 1) : (sizeVariants.length ? sizeVariants : variants);
  const totalVariantCount = Math.max(1, relevant.length || variants.length);
  const availableVariantCount = (relevant.length ? relevant : variants).filter(isVariantAvailable).length;
  const availabilityRatio = Math.min(1, availableVariantCount / totalVariantCount);
  return { isAvailableForRecommendation: isOneSize ? availableVariantCount > 0 : availabilityRatio >= 0.5, availabilityRatio, availableVariantCount, totalVariantCount, isOneSize };
}

function rankRecommendations(products: ProductCandidate[], salesStats: Map<string, SalesStats>, candidateIntent: CandidateIntent): RankedRecommendation[] {
  return products.map((product) => ({ ...product, salesStats: salesStats.get(product.productId), availability: computeAvailabilityScore(product), coherenceScore: coherenceScore(product, candidateIntent) })).filter((product) => product.availability.isAvailableForRecommendation).sort((a, b) => (b.salesStats?.unitsSold30d ?? 0) - (a.salesStats?.unitsSold30d ?? 0) || b.availability.availabilityRatio - a.availability.availabilityRatio || b.coherenceScore - a.coherenceScore || Number(Boolean(b.publishedAt || b.status === "ACTIVE")) - Number(Boolean(a.publishedAt || a.status === "ACTIVE")));
}

async function buildDevidLabelAlternatives(env: Env, normalizedIntent: NormalizedQuery, mainIntent: CandidateIntent): Promise<AssistantSuggestion[]> {
  if (mainIntent.forceNoDevidAlternatives) return [];
  const intents = mainIntent.alternativeIntents ?? (normalizedIntent.normalizedQuery.includes("mare") ? ["bermuda_uomo", "tshirt_mosca_devid_label", "monterosso_devid_label"] : []);
  const out: AssistantSuggestion[] = [];
  for (const intent of intents) {
    const config = INTENT_CANDIDATES[intent]; if (!config) continue;
    const products = await fetchCandidateProducts(env, { intent, ...config });
    const ranked = rankRecommendations(products, new Map(), { intent, ...config });
    if (ranked[0]) out.push(toAssistantSuggestion(ranked[0]));
    if (out.length >= 2) break;
  }
  return out;
}

function isVariantAvailable(variant: ProductVariantCandidate): boolean { return (typeof variant.inventoryQuantity === "number" && variant.inventoryQuantity > 0) || variant.availableForSale === true; }
function matchesCandidateProduct(product: Pick<ProductCandidate, "vendor" | "title" | "productType" | "tags">, candidate: CandidateIntent): boolean { const text = normalizeQueryText([product.title, product.productType, ...(product.tags ?? [])].join(" ")); const vendorMatches = normalizeQueryText(product.vendor) === normalizeQueryText(candidate.vendor); return vendorMatches && (candidate.productTerms.length === 0 || candidate.productTerms.every((term) => text.includes(normalizeQueryText(term)))); }
function coherenceScore(product: ProductCandidate, candidate: CandidateIntent): number { const text = normalizeQueryText([product.title, product.productType, product.vendor, ...product.tags].join(" ")); return [...candidate.queryTerms, ...candidate.productTerms, ...candidate.categories].reduce((score, term) => score + (text.includes(normalizeQueryText(term)) ? 1 : 0), 0); }
function toAssistantSuggestion(product: ProductCandidate): AssistantSuggestion { return { label: product.title, message: product.vendor || product.productType || "Prodotto consigliato", url: product.handle.startsWith("/products/") ? product.handle : `/products/${product.handle}`, image: product.image, type: "product" }; }
function parsePositiveInt(value: string | undefined, fallback: number): number { const parsed = Number.parseInt(value ?? "", 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }

export { shopifyGraphQL, fetchSalesRankLast30Days, fetchCandidateProducts, computeAvailabilityScore, rankRecommendations, buildDevidLabelAlternatives };
