type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

export interface Env {
  OPENAI_API_KEY?: string;
  ASSISTANT_ALLOWED_ORIGINS?: string;
  ASSISTANT_MODEL?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_CLIENT_ID?: string;
  SHOPIFY_CLIENT_SECRET?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_TOKENS_KV?: KVNamespace;
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS?: string;
  ASSISTANT_ADMIN_TOKEN?: string;
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
  commerce_intent?: { vendor: string | null; category: string | null; gender: "uomo" | "donna" | "unisex" | null; product: string | null; confidence: number; is_vendor_only_query: boolean };
  ranking_strategy?: string;
  recommendation_guardrails?: string[];
  order_lookup?: { status: string; next_step: string };
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
const SHOPIFY_TOKEN_FALLBACK_TTL_SECONDS = 23 * 60 * 60;
const SHOPIFY_TOKEN_REFRESH_SKEW_SECONDS = 5 * 60;
const OPENAI_TIMEOUT_MS = 7000;
const SHOPIFY_OAUTH_SCOPES = "read_products,read_inventory,read_orders";
const SHOPIFY_OAUTH_REDIRECT_URI = "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev/auth/callback";
const SHOPIFY_OAUTH_STATE_TTL_SECONDS = 600;
type ShopifyAuthTokenSource = "oauth_kv" | "legacy_secret" | "none";

let shopifyTokenCache = { accessToken: "", expiresAt: 0, source: "none" as ShopifyAuthTokenSource };

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
  mare_uomo: { correctedQuery: "mare uomo", aliases: ["mc2 costume uomo", "mc2 saint barth costume uomo"] },
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
  if (url.pathname === "/" && request.method === "GET") {
    return html("Devid Label AI Assistant Backend is running.", 200, corsHeaders);
  }

  if (url.pathname === "/install") {
    return handleShopifyInstallRequest(request, env, corsHeaders);
  }

  if (url.pathname === "/auth/callback") {
    return handleShopifyAuthCallbackRequest(request, env, corsHeaders);
  }

  if (url.pathname === "/debug/shopify") {
    return handleShopifyDebugRequest(request, env, corsHeaders);
  }

  if (url.pathname === "/debug/recommendation") {
    return handleRecommendationDebugRequest(request, env, corsHeaders);
  }

  if (url.pathname === "/order/lookup") {
    return handleOrderLookupRequest(request, env, corsHeaders);
  }

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
  const commerceV2 = analyzeCommerceQueryV2(parsed.payload.query);
  const deterministic = routeDeterministicIntent(parsed.payload, "ai_backend", normalized, commerceV2);
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


type OrderLookupStatus = "ask_order_number" | "ask_email" | "found" | "email_mismatch" | "not_found" | "marketplace_unsupported" | "invalid_input" | "temporarily_unavailable";
type OrderNextStep = "order_number" | "email" | "none";
type FulfillmentState = "not_shipped" | "shipped" | "delivered" | "partial" | "cancelled" | "unknown";
type OrderTrackingItem = { company: string | null; number: string | null; url?: string | null };
type SafeOrderLookup = { public_order_name: string; fulfillment_state: FulfillmentState; shipping_message: string; tracking_items: OrderTrackingItem[]; cash_on_delivery_note?: boolean };
type OrderLookupResponse = { ok: true; source: "order_lookup"; type: "order_lookup"; status: OrderLookupStatus; next_step: OrderNextStep; message: string; order_lookup: SafeOrderLookup | null; guardrails: string[] };
type ShopifyOrderLookupNode = { name?: string | null; email?: string | null; displayFulfillmentStatus?: string | null; cancelledAt?: string | null; sourceName?: string | null; sourceIdentifier?: string | null; number?: number | null; tags?: string[] | null; customAttributes?: Array<{ key?: string | null; value?: string | null }> | null; shippingLines?: { edges?: Array<{ node?: { title?: string | null; code?: string | null } | null }> } | null; paymentGatewayNames?: string[] | null; fulfillments?: Array<{ status?: string | null; displayStatus?: string | null; trackingInfo?: Array<{ company?: string | null; number?: string | null; url?: string | null }> | null }> | null };
type ShopifyOrderLookupData = { orders: { edges: Array<{ node: ShopifyOrderLookupNode }> } };

const ORDER_LOOKUP_ALLOWED_KEYS = new Set(["order_number", "query", "email"]);
const MARKETPLACE_MESSAGE = "Per gli ordini effettuati tramite marketplace, l’assistenza deve essere gestita direttamente dal servizio clienti del marketplace di riferimento. Ti consigliamo di aprire la richiesta dalla piattaforma da cui hai effettuato l’acquisto.";
const EMAIL_MISMATCH_MESSAGE = "L’email inserita non corrisponde a quella associata all’ordine. Controlla l’indirizzo usato in fase d’acquisto e verifica anche la cartella spam/promozioni della tua casella email.";

async function handleOrderLookupRequest(request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
  if (request.method !== "POST") return json(orderLookupResponse("invalid_input", "none", "Metodo non supportato.", null, []), 405, { ...corsHeaders, Allow: "POST, OPTIONS" });
  const input = await parseOrderLookupPayload(request);
  if (!input.ok) return json(orderLookupResponse("invalid_input", "order_number", "Inserisci un numero ordine valido, usando solo le cifre.", null, input.guardrails), 200, corsHeaders);
  if (!input.orderNumber) return json(orderLookupResponse("ask_order_number", "order_number", "Inserisci il numero ordine per iniziare la verifica.", null, input.guardrails), 200, corsHeaders);
  try {
    const order = await fetchShopifyOrderByNumber(env, input.orderNumber);
    if (!order) return json(orderLookupResponse("not_found", "order_number", "Non riesco a trovare un ordine con questo numero. Verifica di aver inserito correttamente il numero ordine, usando solo le cifre.", null, []), 200, corsHeaders);
    if (isMarketplaceOrder(order)) return json(orderLookupResponse("marketplace_unsupported", "none", MARKETPLACE_MESSAGE, null, ["marketplace_order_blocked"]), 200, corsHeaders);
    if (!input.email) return json(orderLookupResponse("ask_email", "email", "Perfetto, ora inserisci l’email usata per effettuare l’ordine.", null, []), 200, corsHeaders);
    if (!order.email || normalizeEmail(order.email) !== input.email) return json(orderLookupResponse("email_mismatch", "email", EMAIL_MISMATCH_MESSAGE, null, ["email_mismatch_no_order_data_returned"]), 200, corsHeaders);
    const safe = buildSafeOrderLookup(order);
    return json(orderLookupResponse("found", "none", safe.shipping_message, safe, []), 200, corsHeaders);
  } catch (error) {
    console.error("Order lookup unavailable", classifyShopifyGuardrail(error, "shopify_order_lookup_unavailable"));
    return json(orderLookupResponse("temporarily_unavailable", "order_number", "Il servizio di verifica ordine è temporaneamente non disponibile. Riprova tra poco.", null, ["shopify_order_lookup_unavailable"]), 200, corsHeaders);
  }
}

async function parseOrderLookupPayload(request: Request): Promise<{ ok: true; orderNumber: string; email: string; guardrails: string[] } | { ok: false; guardrails: string[] }> {
  let body: unknown;
  try { body = await request.json(); } catch { return { ok: false, guardrails: ["invalid_json"] }; }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, guardrails: ["invalid_payload"] };
  const input = body as Record<string, unknown>;
  const guardrails = Object.keys(input).filter((key) => !ORDER_LOOKUP_ALLOWED_KEYS.has(key)).map((key) => SENSITIVE_KEY_PATTERN.test(key) ? `ignored_sensitive_field:${key}` : `ignored_extra_field:${key}`);
  const orderNumber = normalizeOrderNumber(input.order_number ?? input.query);
  const emailRaw = normalizeString(input.email, 254);
  const email = emailRaw ? normalizeEmail(emailRaw) : "";
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, guardrails: guardrails.concat("invalid_email") };
  if (!orderNumber && (input.order_number !== undefined || input.query !== undefined)) return { ok: false, guardrails: guardrails.concat("invalid_order_number") };
  return { ok: true, orderNumber, email, guardrails };
}

function normalizeOrderNumber(value: unknown): string {
  const raw = normalizeString(value, 120);
  const match = raw.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10)).match(/#?\s*(\d{3,12})\b/);
  return match ? match[1] : "";
}
function normalizeEmail(value: string): string { return value.trim().toLowerCase(); }
function orderLookupResponse(status: OrderLookupStatus, next_step: OrderNextStep, message: string, order_lookup: SafeOrderLookup | null, guardrails: string[]): OrderLookupResponse { return { ok: true, source: "order_lookup", type: "order_lookup", status, next_step, message, order_lookup, guardrails }; }

async function fetchShopifyOrderByNumber(env: Env, orderNumber: string): Promise<ShopifyOrderLookupNode | null> {
  const fragments = [`name:#${orderNumber}`, `name:${orderNumber}`, `order_number:${orderNumber}`];
  const gql = `query OrderLookup($query: String!) { orders(first: 1, query: $query) { edges { node { name number email displayFulfillmentStatus cancelledAt sourceName sourceIdentifier tags customAttributes { key value } paymentGatewayNames shippingLines(first: 10) { edges { node { title code } } } fulfillments(first: 10) { status displayStatus trackingInfo { company number url } } } } } } }`;
  for (const query of fragments) {
    const data = await shopifyGraphQL<ShopifyOrderLookupData>(env, gql, { query });
    const node = data.orders.edges[0]?.node;
    if (node) return node;
  }
  return null;
}

function isMarketplaceOrder(order: ShopifyOrderLookupNode): boolean {
  const haystack = [order.sourceName, order.sourceIdentifier, ...(order.tags ?? []), ...(order.customAttributes ?? []).flatMap((a) => [a.key, a.value]), order.email].filter(Boolean).join(" ").toLowerCase();
  return /marketplace|spartoo|amazon|tiktok|tik tok|miinto|packlink_pending|relay|seller|channeladvisor|mirakl/.test(haystack);
}

function isCashOnDeliveryOrder(order: ShopifyOrderLookupNode): boolean {
  const haystack = [...(order.tags ?? []), ...(order.paymentGatewayNames ?? []), ...(order.customAttributes ?? []).flatMap((a) => [a.key, a.value]), ...(order.shippingLines?.edges ?? []).flatMap((e) => [e.node?.title, e.node?.code])].filter(Boolean).join(" ").toLowerCase();
  return /contrassegno|cash on delivery|cod|pagamento alla consegna/.test(haystack);
}

function buildSafeOrderLookup(order: ShopifyOrderLookupNode): SafeOrderLookup {
  const tracking_items = collectTrackingItems(order);
  const lowerStatuses = (order.fulfillments ?? []).flatMap((f) => [f.status, f.displayStatus]).filter(Boolean).join(" ").toLowerCase();
  let fulfillment_state: FulfillmentState = "unknown";
  if (order.cancelledAt) fulfillment_state = "cancelled";
  else if (/delivered|consegn/.test(lowerStatuses)) fulfillment_state = "delivered";
  else if (tracking_items.length > 0) fulfillment_state = "shipped";
  else if (/partial/.test(String(order.displayFulfillmentStatus).toLowerCase())) fulfillment_state = "partial";
  else if (/unfulfilled|not_fulfilled|none|null|undefined/.test(String(order.displayFulfillmentStatus).toLowerCase()) || !(order.fulfillments ?? []).length) fulfillment_state = "not_shipped";
  else if (/fulfilled|in_transit|out_for_delivery|shipped|success/.test(lowerStatuses + " " + String(order.displayFulfillmentStatus).toLowerCase())) fulfillment_state = "shipped";
  const cod = isCashOnDeliveryOrder(order);
  const shipping_message = buildShippingMessage(fulfillment_state, tracking_items.length, cod);
  return { public_order_name: order.name || "", fulfillment_state, shipping_message, tracking_items, ...(cod ? { cash_on_delivery_note: true } : {}) };
}

function collectTrackingItems(order: ShopifyOrderLookupNode): OrderTrackingItem[] {
  const items: OrderTrackingItem[] = [];
  for (const fulfillment of order.fulfillments ?? []) for (const info of fulfillment.trackingInfo ?? []) {
    const number = normalizeString(info.number, 120) || null;
    const company = normalizeString(info.company, 80) || null;
    items.push({ company, number, url: normalizeTrackingUrl(info.url, number) });
  }
  return items;
}
function normalizeTrackingUrl(url: unknown, trackingNumber: string | null): string | null {
  let value = normalizeString(url, 500);
  if (!value) return null;
  if (trackingNumber) value = value.replace(/\[\[trackingNumber\]\]|\{\{trackingNumber\}\}|\{trackingNumber\}|\[trackingNumber\]/gi, encodeURIComponent(trackingNumber));
  try { const parsed = new URL(value); return /^https?:$/.test(parsed.protocol) ? parsed.toString() : null; } catch { return null; }
}
function buildShippingMessage(state: FulfillmentState, trackingCount: number, cod: boolean): string {
  const codNote = cod ? " Il pagamento è previsto alla consegna." : "";
  if (trackingCount > 1) return `Sono presenti più spedizioni collegate all’ordine.${codNote}`;
  if (state === "delivered") return `Il tuo ordine risulta consegnato.${codNote}`;
  if (state === "shipped") return `${trackingCount > 0 ? "Il tuo ordine risulta spedito ed è stato affidato al corriere." : "Il tuo ordine risulta spedito."}${codNote}`;
  if (state === "cancelled") return `L’ordine risulta annullato. Per maggiori dettagli contatta l’assistenza clienti.${codNote}`;
  return `Il tuo ordine risulta ricevuto, ma non è ancora stato spedito. Appena verrà affidato al corriere riceverai il tracking via email.${codNote}`;
}

async function handleShopifyInstallRequest(request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
  if (request.method !== "GET") {
    return json({ ok: false, source: "ai_backend", type: "error", message: "Metodo non supportato.", guardrails: [] }, 405, { ...corsHeaders, Allow: "GET, OPTIONS" });
  }
  const configuredShop = normalizeShopifyDomainCandidate(env.SHOPIFY_SHOP_DOMAIN || "");
  if (!env.SHOPIFY_CLIENT_ID) return json(validationError("Configurazione Shopify OAuth incompleta.", ["shopify_oauth_client_id_missing"]), 500, corsHeaders);
  if (!env.SHOPIFY_CLIENT_SECRET) return json(validationError("Configurazione Shopify OAuth incompleta.", ["shopify_oauth_client_secret_missing"]), 500, corsHeaders);
  if (!isValidShopifyShopDomain(configuredShop)) return json(validationError("Shop Shopify configurato non valido.", ["shopify_shop_domain_missing_or_invalid"]), 500, corsHeaders);
  if (!env.SHOPIFY_TOKENS_KV) return json(validationError("Storage Shopify OAuth non configurato.", ["shopify_tokens_kv_missing"]), 500, corsHeaders);
  if (!env.SHOPIFY_TOKEN_ENCRYPTION_KEY) return json(validationError("Chiave cifratura Shopify OAuth non configurata.", ["shopify_token_encryption_key_missing"]), 500, corsHeaders);

  const url = new URL(request.url);
  const shop = normalizeShopifyDomainCandidate(url.searchParams.get("shop") || configuredShop);
  if (!isValidShopifyShopDomain(shop)) return json(validationError("Shop Shopify non valido.", ["invalid_shopify_shop_domain"]), 400, corsHeaders);
  if (shop !== configuredShop) return json(validationError("Shop Shopify non autorizzato.", ["shopify_shop_not_allowed"]), 403, corsHeaders);

  const state = createOAuthState();
  await env.SHOPIFY_TOKENS_KV.put(shopifyOAuthStateKey(state), JSON.stringify({ shop, created_at: new Date().toISOString() }), { expirationTtl: SHOPIFY_OAUTH_STATE_TTL_SECONDS });
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", env.SHOPIFY_CLIENT_ID);
  authorizeUrl.searchParams.set("scope", SHOPIFY_OAUTH_SCOPES);
  authorizeUrl.searchParams.set("redirect_uri", SHOPIFY_OAUTH_REDIRECT_URI);
  authorizeUrl.searchParams.set("state", state);

  return new Response(null, { status: 302, headers: { ...corsHeaders, Location: authorizeUrl.toString(), "Cache-Control": "no-store" } });
}

async function handleShopifyAuthCallbackRequest(request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
  if (request.method !== "GET") {
    return json({ ok: false, source: "ai_backend", type: "error", message: "Metodo non supportato.", guardrails: [] }, 405, { ...corsHeaders, Allow: "GET, OPTIONS" });
  }
  if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) return json(validationError("Configurazione Shopify OAuth incompleta.", ["shopify_oauth_config_missing"]), 500, corsHeaders);
  if (!env.SHOPIFY_TOKENS_KV) return json(validationError("Storage Shopify OAuth non configurato.", ["shopify_tokens_kv_missing"]), 500, corsHeaders);
  if (!env.SHOPIFY_TOKEN_ENCRYPTION_KEY) return json(validationError("Chiave cifratura Shopify OAuth non configurata.", ["shopify_token_encryption_key_missing"]), 500, corsHeaders);

  const configuredShop = normalizeShopifyDomainCandidate(env.SHOPIFY_SHOP_DOMAIN || "");
  const url = new URL(request.url);
  const shop = normalizeShopifyDomainCandidate(url.searchParams.get("shop") || "");
  if (!isValidShopifyShopDomain(shop)) return json(validationError("Shop Shopify non valido.", ["invalid_shopify_shop_domain"]), 400, corsHeaders);
  if (shop !== configuredShop) return json(validationError("Shop Shopify non autorizzato.", ["shopify_shop_not_allowed"]), 403, corsHeaders);
  if (!(await verifyShopifyHmac(url.searchParams, env.SHOPIFY_CLIENT_SECRET))) return json(validationError("Firma Shopify non valida.", ["invalid_shopify_hmac"]), 403, corsHeaders);

  const state = url.searchParams.get("state") || "";
  const stateKey = shopifyOAuthStateKey(state);
  const stateValue = state ? await env.SHOPIFY_TOKENS_KV.get(stateKey) : null;
  if (!stateValue) return json(validationError("State Shopify OAuth non valido.", ["invalid_shopify_oauth_state"]), 403, corsHeaders);

  const code = url.searchParams.get("code") || "";
  if (!code) return json(validationError("Codice OAuth Shopify mancante.", ["missing_shopify_oauth_code"]), 400, corsHeaders);

  const result = await exchangeShopifyOAuthCode(env, shop, code);
  if (!result.ok) return json(validationError("Installazione Shopify non completata.", [result.error]), 502, corsHeaders);

  await persistShopifyOAuthToken(env, shop, result.accessToken, result.scope || SHOPIFY_OAUTH_SCOPES);
  await env.SHOPIFY_TOKENS_KV.delete(stateKey);
  shopifyTokenCache = { accessToken: result.accessToken, expiresAt: Date.now() + SHOPIFY_TOKEN_FALLBACK_TTL_SECONDS * 1000, source: "oauth_kv" };
  return html("App installata correttamente. Puoi chiudere questa finestra.", 200, corsHeaders);
}

async function handleShopifyDebugRequest(request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, source: "shopify_debug", errors: [] }, 405, { ...corsHeaders, Allow: "POST, OPTIONS" });
  }

  if (!isValidAssistantAdminRequest(request, env)) {
    return json({ ok: false, source: "shopify_debug", errors: [] }, 404, corsHeaders);
  }

  const checks: Record<string, boolean> = {
    shop_domain_configured: Boolean(env.SHOPIFY_SHOP_DOMAIN),
    client_id_configured: Boolean(env.SHOPIFY_CLIENT_ID),
    client_secret_configured: Boolean(env.SHOPIFY_CLIENT_SECRET),
    kv_token_store_configured: Boolean(env.SHOPIFY_TOKENS_KV),
    token_encryption_key_configured: Boolean(env.SHOPIFY_TOKEN_ENCRYPTION_KEY),
    stored_oauth_token_found: false,
    legacy_admin_token_configured: Boolean(env.SHOPIFY_ADMIN_ACCESS_TOKEN),
    auth_token_obtained: false,
    products_graphql_ok: false,
    orders_graphql_ok: false,
    inventory_graphql_ok: false,
  };
  const errors: ShopifyDebugError[] = [];
  const response: ShopifyDebugResponse = {
    ok: false,
    source: "shopify_debug",
    checks,
    auth_token_source: "none",
    shop_domain_hint: maskShopDomain(env.SHOPIFY_SHOP_DOMAIN ?? ""),
    api_version: env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION,
    errors,
  };

  try {
    checks.stored_oauth_token_found = await hasStoredShopifyOAuthToken(env);
    const auth = await resolveShopifyAdminAccessToken(env);
    checks.auth_token_obtained = Boolean(auth.accessToken);
    response.auth_token_source = auth.source;
  } catch (error) {
    errors.push({ stage: "auth", ...sanitizeDebugError(error) });
    return json(response, 200, corsHeaders);
  }

  try {
    const data = await shopifyGraphQL<{ products: { edges: unknown[] } }>(env, `query DebugProducts { products(first: 1) { edges { node { id title handle vendor } } } }`);
    checks.products_graphql_ok = true;
    response.products_count_sample = Math.min(1, data.products.edges.length);
  } catch (error) {
    errors.push({ stage: "products", ...sanitizeDebugError(error) });
  }

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await shopifyGraphQL(env, `query DebugOrders($query: String!) { orders(first: 1, query: $query) { edges { node { id createdAt lineItems(first: 1) { edges { node { quantity } } } } } } }`, { query: `created_at:>=${since}` });
    checks.orders_graphql_ok = true;
  } catch (error) {
    errors.push({ stage: "orders", ...sanitizeDebugError(error) });
  }

  try {
    await shopifyGraphQL(env, `query DebugVariants { products(first: 1) { edges { node { variants(first: 1) { edges { node { id inventoryQuantity availableForSale } } } } } } }`);
    checks.inventory_graphql_ok = true;
  } catch (error) {
    errors.push({ stage: "inventory", ...sanitizeDebugError(error) });
  }

  response.ok = errors.length === 0;
  return json(response, 200, corsHeaders);
}

function isValidAssistantAdminRequest(request: Request, env: Env): boolean {
  const expected = env.ASSISTANT_ADMIN_TOKEN;
  const provided = request.headers.get("X-Assistant-Admin-Token");
  return Boolean(expected && provided && provided === expected);
}

function buildCorsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = parseAllowedOrigins(env.ASSISTANT_ALLOWED_ORIGINS);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Assistant-Admin-Token",
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

function routeDeterministicIntent(payload: Pick<SanitizedPayload, "query" | "guardrails">, source: AssistantResponse["source"], normalized = normalizeQuery(payload.query), commerceV2 = analyzeCommerceQueryV2(payload.query)): AssistantResponse | null {
  const query = normalized.normalizedQuery;
  const base = responseBase(source, payload.guardrails, normalized);

  if (["collection_category", "vendor_collection_category", "vendor_only", "product_intent"].includes(commerceV2.candidateStrategy ?? "fallback_search")) {
    return {
      ...base,
      type: "product_advice",
      title: commerceV2.vendorIntent ? `${commerceV2.vendorIntent}${commerceV2.categoryIntent ? `: ${commerceV2.categoryIntent.replace(/_/g, " ")}` : ""}` : commerceV2.categoryIntent ? commerceV2.categoryIntent.replace(/_/g, " ") : "Consigli prodotto",
      message: commerceV2.isCategoryOnlyQuery ? "Ti mostro prodotti dalla collection Shopify più coerente, senza forzare brand specifici." : commerceV2.isVendorCategoryQuery ? "Ti mostro prodotti della collection coerente filtrati per brand." : "Ti mostro prodotti coerenti ordinati per stagione, disponibilità e venduto recente.",
      primary_cta: buildPrimaryCtaForIntent(commerceV2),
      devid_label_alternatives: [],
      cross_sell: commerceV2.categoryIntent === "costumi_mare" ? [SAFE_DESTINATIONS.bermuda, SAFE_DESTINATIONS.teePolo] : [],
      commerce_intent: toResponseCommerceIntent(commerceV2),
      ranking_strategy: commerceV2.candidateStrategy,
      recommendation_guardrails: commerceV2.guardrails,
    };
  }

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

  const commerceIntent = analyzeCommerceQuery(payload.query, query);
  if (!commerceIntent.vendorIntent && commerceIntent.categoryIntent === "costumi_mare") {
    return {
      ...base,
      type: "product_advice",
      title: "Costumi e mare uomo",
      message: "Ti mostro solo proposte mare coerenti, senza riempire le card con prodotti fuori categoria.",
      primary_cta: cta(SAFE_DESTINATIONS.mare),
      devid_label_alternatives: [],
      cross_sell: [SAFE_DESTINATIONS.bermuda],
      commerce_intent: toResponseCommerceIntent(commerceIntent),
    };
  }

  if (commerceIntent.vendorIntent) {
    return {
      ...base,
      type: "product_advice",
      title: commerceIntent.categoryIntent ? `${commerceIntent.vendorIntent}: ${commerceIntent.categoryIntent.replace(/_/g, " ")}` : commerceIntent.vendorIntent,
      message: commerceIntent.isVendorOnlyQuery ? `Ti mostro i prodotti ${commerceIntent.vendorIntent} disponibili ordinati per venduto recente.` : `Ti mostro prima prodotti ${commerceIntent.vendorIntent} coerenti con categoria e taglia/genere richiesti.`,
      primary_cta: { label: `Cerca ${commerceIntent.vendorIntent}`, url: `/search?type=product&q=${encodeURIComponent([commerceIntent.vendorIntent, commerceIntent.categoryIntent ?? "", commerceIntent.genderIntent ?? ""].filter(Boolean).join(" "))}` },
      devid_label_alternatives: [],
      cross_sell: [],
    };
  }

  if (isOrderQuery(query)) {
    return {
      ...base,
      type: "order_help",
      title: "Dov’è il mio ordine?",
      message: "Inserisci il numero ordine per iniziare la verifica.",
      requires_backend_order_lookup: true,
      order_lookup: { status: "ask_order_number", next_step: "order_number" },
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
  const commerceIntent = analyzeCommerceQuery(query, normalized.normalizedQuery);
  return Boolean(normalized.matchedIntent || commerceIntent.vendorIntent || commerceIntent.categoryIntent) || /t-?shirt|tshirt|saint barth|replay|jeans|cargo|courmayeur|sprayground|k-?way|costume|mare uomo|bermuda|polo/.test(normalized.normalizedQuery);
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

function json(body: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function html(body: string, status: number, headers: HeadersInit): Response {
  return new Response(`<!doctype html><html lang="it"><meta charset="utf-8"><title>Devid Label AI Assistant</title><body>${escapeHtml(body)}</body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char] ?? char));
}

function normalizeShopifyDomainCandidate(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

function isValidShopifyShopDomain(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value);
}

function createOAuthState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyShopifyHmac(params: URLSearchParams, clientSecret: string): Promise<boolean> {
  const received = params.get("hmac") || "";
  if (!received || !/^[a-f0-9]{64}$/i.test(received) || !clientSecret) return false;
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => entries.push([key, value]));
  const message = entries
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(clientSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(expected, received.toLowerCase());
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function exchangeShopifyOAuthCode(env: Env, shop: string, code: string): Promise<{ ok: true; accessToken: string; scope: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, code }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `shopify_oauth_status_${response.status}` };
    const payload = await response.json() as { access_token?: unknown; scope?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) return { ok: false, error: "shopify_oauth_empty_token" };
    return { ok: true, accessToken: payload.access_token, scope: typeof payload.scope === "string" && payload.scope ? payload.scope : SHOPIFY_OAUTH_SCOPES };
  } catch (error) {
    return { ok: false, error: error instanceof DOMException && error.name === "AbortError" ? "shopify_oauth_timeout" : "shopify_oauth_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

function shopifyOfflineTokenKey(shop: string): string { return `shopify:offline_token:${shop}`; }
function shopifyOAuthStateKey(state: string): string { return `shopify:oauth_state:${state}`; }

type StoredShopifyOAuthToken = { shop: string; scope: string; created_at: string; updated_at: string; encrypted_access_token: string; iv: string };

async function persistShopifyOAuthToken(env: Env, shop: string, accessToken: string, scope: string): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("shopify_tokens_kv_missing");
  const existingRaw = await env.SHOPIFY_TOKENS_KV.get(shopifyOfflineTokenKey(shop));
  const existing = parseStoredShopifyOAuthToken(existingRaw);
  const encrypted = await encryptShopifyToken(env, accessToken);
  const now = new Date().toISOString();
  const value: StoredShopifyOAuthToken = { shop, scope, created_at: existing?.created_at || now, updated_at: now, encrypted_access_token: encrypted.ciphertext, iv: encrypted.iv };
  await env.SHOPIFY_TOKENS_KV.put(shopifyOfflineTokenKey(shop), JSON.stringify(value));
}

async function hasStoredShopifyOAuthToken(env: Env): Promise<boolean> {
  if (!env.SHOPIFY_TOKENS_KV || !env.SHOPIFY_SHOP_DOMAIN) return false;
  return Boolean(await env.SHOPIFY_TOKENS_KV.get(shopifyOfflineTokenKey(normalizeShopifyShopDomain(env))));
}

async function loadStoredShopifyOAuthToken(env: Env): Promise<string | null> {
  if (!env.SHOPIFY_TOKENS_KV) return null;
  const shop = normalizeShopifyShopDomain(env);
  const stored = parseStoredShopifyOAuthToken(await env.SHOPIFY_TOKENS_KV.get(shopifyOfflineTokenKey(shop)));
  if (!stored || stored.shop !== shop) return null;
  return decryptShopifyToken(env, stored.encrypted_access_token, stored.iv);
}

function parseStoredShopifyOAuthToken(value: string | null): StoredShopifyOAuthToken | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredShopifyOAuthToken>;
    return typeof parsed.shop === "string" && typeof parsed.encrypted_access_token === "string" && typeof parsed.iv === "string" && typeof parsed.scope === "string" && typeof parsed.created_at === "string" && typeof parsed.updated_at === "string" ? parsed as StoredShopifyOAuthToken : null;
  } catch { return null; }
}

async function importShopifyTokenEncryptionKey(env: Env): Promise<CryptoKey> {
  const raw = base64ToBytes(env.SHOPIFY_TOKEN_ENCRYPTION_KEY || "");
  if (raw.byteLength !== 32) throw new Error("shopify_token_encryption_key_invalid");
  return crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptShopifyToken(env: Env, token: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importShopifyTokenEncryptionKey(env);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token));
  return { ciphertext: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

async function decryptShopifyToken(env: Env, ciphertext: string, iv: string): Promise<string> {
  const key = await importShopifyTokenEncryptionKey(env);
  const ivBytes = base64ToBytes(iv);
  const cipherBytes = base64ToBytes(ciphertext);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(ivBytes) }, key, toArrayBuffer(cipherBytes));
  return new TextDecoder().decode(plain);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return new Uint8Array(); }
}

type CommerceGenderIntent = "uomo" | "donna" | "unisex";
type CommerceCategoryIntent = "tshirt" | "polo" | "jeans" | "costumi_mare" | "bermuda_shorts" | "zaini" | "borse_accessori" | "outerwear" | "felpe" | "camicie" | "top_donna" | "calzature" | "teli_mare" | "cargo" | "maglieria";
type CandidateStrategy = "faq" | "product_intent" | "collection_category" | "vendor_collection_category" | "vendor_only" | "fallback_search";
type CommerceQueryIntent = {
  normalized_query?: string;
  vendorIntent: string | null;
  categoryIntent: CommerceCategoryIntent | null;
  genderIntent: CommerceGenderIntent | null;
  productIntent: string | null;
  collectionTargets?: string[];
  candidateStrategy?: CandidateStrategy;
  confidence: number;
  isVendorOnlyQuery: boolean;
  isCategoryOnlyQuery?: boolean;
  isVendorCategoryQuery?: boolean;
  requiresStrictProductMatch?: boolean;
  guardrails?: string[];
};
type CandidateIntent = {
  intent: string;
  vendor: string;
  queryTerms: string[];
  productTerms: string[];
  categories: CommerceCategoryIntent[];
  gender?: CommerceGenderIntent;
  commerceIntent: CommerceQueryIntent;
  forceNoDevidAlternatives?: boolean;
  alternativeIntents?: ProductIntent[];
};

type SalesStats = { productId: string; variantIds: string[]; unitsSold30d: number; revenue30d?: number; lastSoldAt?: string };
type ProductVariantCandidate = { variantId: string; title: string; selectedOptions: Array<{ name: string; value: string }>; inventoryQuantity?: number | null; availableForSale?: boolean | null };
type ProductCollectionCandidate = { handle: string; title: string };
type ProductCandidate = { productId: string; title: string; handle: string; vendor: string; productType: string; tags: string[]; collections: ProductCollectionCandidate[]; image?: string; onlineStoreUrl?: string; status?: string; publishedAt?: string | null; updatedAt?: string | null; variants: ProductVariantCandidate[] };
type AvailabilityResult = { isAvailableForRecommendation: boolean; availabilityRatio: number; availableVariantCount: number; totalVariantCount: number; isOneSize: boolean };
type RankedRecommendation = ProductCandidate & { salesStats?: SalesStats; availability: AvailabilityResult; coherenceScore: number; categoryMatch: "strong" | "medium" | "denied" | "unknown" };
type RecommendationSnapshot = { recommended_products: AssistantSuggestion[]; devid_label_alternatives: AssistantSuggestion[]; guardrails: string[]; expiresAt: number; ranking_strategy: string; commerce_intent: CommerceQueryIntent; debug?: RecommendationDebugSummary };
type RecommendationRankingResult = { ranked: RankedRecommendation[]; guardrails: string[] };
type SeasonSignal = "summer" | "winter" | "neutral";
type ShopifyDebugError = { stage: string; code: string; message: string };
type ShopifyDebugResponse = { ok: boolean; source: "shopify_debug"; checks: Record<string, boolean>; auth_token_source: ShopifyAuthTokenSource; shop_domain_hint?: string; api_version: string; products_count_sample?: number; errors: ShopifyDebugError[] };

type ShopifyOrdersData = { orders: { edges: Array<{ node: { processedAt: string; lineItems: { edges: Array<{ node: { quantity: number; discountedTotalSet?: { shopMoney?: { amount?: string } }; product?: { id: string; vendor: string; title: string; productType: string; tags: string[] }; variant?: { id: string } } }> } } }> } };
type ShopifyProductsData = { products: { edges: Array<{ node: { id: string; title: string; handle: string; vendor: string; productType: string; tags: string[]; onlineStoreUrl?: string; status?: string; publishedAt?: string | null; updatedAt?: string | null; featuredImage?: { url: string }; collections?: { edges: Array<{ node: { handle: string; title: string } }> }; variants: { edges: Array<{ node: { id: string; title: string; selectedOptions: Array<{ name: string; value: string }>; inventoryQuantity?: number | null; availableForSale?: boolean | null } }> } } }> } };
type ShopifyCollectionProductsData = { collectionByHandle?: { products: ShopifyProductsData["products"] } | null };
type RecommendationDebugSummary = { candidateCountBeforeFilters: number; candidateCountAfterFilters: number; excludedReasonCounts: Record<string, number>; topCandidates: Array<{ label: string; handle: string; vendor: string; category: string | null; availability: number; units_sold_30d: number }> };


const VENDOR_ALIASES: Array<{ vendor: string; aliases: string[] }> = [
  { vendor: "MC2 Saint Barth", aliases: ["mc2 saint barth", "saint barth", "saint bart", "san bat", "san bart", "mc2"] },
  { vendor: "Sprayground", aliases: ["sprayground", "sprygrund", "sprygrounf", "sprayg", "spray ground"] },
  { vendor: "Colmar Originals", aliases: ["colmar originals", "colmar"] },
  { vendor: "K-Way", aliases: ["k-way", "kway"] },
  { vendor: "Replay", aliases: ["replay"] },
  { vendor: "Mou", aliases: ["mou"] },
  { vendor: "Rains", aliases: ["rains"] },
  { vendor: "Palm Angels", aliases: ["palm angels", "palm"] },
  { vendor: "Flower Mountain", aliases: ["flower mountain", "flower"] },
  { vendor: "Goorin Bros", aliases: ["goorin bros", "goorin"] },
  { vendor: "Devid Label", aliases: ["devid label", "devid", "dl"] },
];

const CATEGORY_KEYWORDS: Record<CommerceCategoryIntent, string[]> = {
  tshirt: ["t shirt", "t-shirt", "tshirt", "tee", "maglietta", "maglia manica corta"],
  polo: ["polo"], jeans: ["jeans", "denim"],
  costumi_mare: ["costume", "costumi", "boxer mare", "swim shorts", "swimwear", "beachwear", "mare uomo"],
  bermuda_shorts: ["bermuda", "shorts", "short"], zaini: ["zaino", "zaini", "backpack", "bagpack"],
  borse_accessori: ["borsa", "borse", "pochette", "vanity", "clutch", "marsupio"],
  outerwear: ["giacca", "giacche", "giubbino", "piumino", "smanicato", "jacket", "outerwear"],
  felpe: ["felpa", "hoodie", "sweatshirt"], camicie: ["camicia", "camicie", "blusa", "bluse"],
  top_donna: ["top", "canotta", "bralette"], calzature: ["scarpe", "sneaker", "sneakers", "sandali", "ciabatte"],
  teli_mare: ["telo", "teli", "towel", "foutas", "asciugamano mare"], cargo: ["cargo", "courma", "courmayeur"],
  maglieria: ["maglieria", "maglia", "cardigan", "girocollo", "scollo v", "serafino", "monterosso"],
};

const WINTER_KEYWORDS = /(^|\s)(cuffia|beanie|ski|lover\s+ski|winter|wool|lana|cashmere|piumino|giacca\s+pesante|maglia\s+invernale|knitwear\s+invernale)(\s|$)/;
const SUMMER_KEYWORDS = /(^|\s)(costume|costumi|boxer|boxer\s+mare|mare|beach|swim|swim\s+shorts|swimwear|beachwear|telo|teli|towel|foutas|linen|lino|cotton|cotone|t\s?shirt|t-shirt|tshirt|polo|camicia|camicie|bermuda|short|shorts)(\s|$)/;
// Gender source terms: uomo|man|male|men|maschile and donna|woman|women|female|femminile.
const MALE_KEYWORDS = /(^|\s)(uomo|man|men|male|maschile)(\s|$)/;
const FEMALE_KEYWORDS = /(^|\s)(donna|woman|women|female|femminile)(\s|$)/;

const CATEGORY_COMPATIBILITY: Record<CommerceCategoryIntent, { strong: CommerceCategoryIntent[]; medium: CommerceCategoryIntent[]; deny: CommerceCategoryIntent[] }> = {
  tshirt: { strong: ["tshirt"], medium: ["polo", "maglieria"], deny: ["teli_mare", "costumi_mare", "zaini", "borse_accessori", "calzature", "jeans"] },
  polo: { strong: ["polo"], medium: ["tshirt", "maglieria"], deny: ["teli_mare", "costumi_mare", "zaini", "borse_accessori", "calzature", "jeans"] },
  costumi_mare: { strong: ["costumi_mare"], medium: ["bermuda_shorts"], deny: ["tshirt", "polo", "jeans", "outerwear", "zaini", "borse_accessori", "calzature", "felpe", "maglieria", "camicie", "top_donna", "teli_mare"] },
  teli_mare: { strong: ["teli_mare"], medium: [], deny: ["tshirt", "polo", "jeans", "outerwear", "zaini", "borse_accessori"] },
  jeans: { strong: ["jeans"], medium: ["cargo"], deny: ["tshirt", "polo", "zaini", "borse_accessori", "teli_mare", "costumi_mare"] },
  zaini: { strong: ["zaini"], medium: ["borse_accessori"], deny: ["tshirt", "jeans", "costumi_mare", "teli_mare"] },
  outerwear: { strong: ["outerwear"], medium: ["felpe"], deny: ["teli_mare", "costumi_mare", "tshirt", "borse_accessori", "zaini"] },
  bermuda_shorts: { strong: ["bermuda_shorts"], medium: ["costumi_mare", "cargo"], deny: ["zaini", "teli_mare", "outerwear"] },
  borse_accessori: { strong: ["borse_accessori"], medium: ["zaini"], deny: ["tshirt", "jeans", "teli_mare"] },
  felpe: { strong: ["felpe"], medium: ["outerwear", "maglieria"], deny: ["teli_mare", "costumi_mare"] },
  camicie: { strong: ["camicie"], medium: ["top_donna", "tshirt"], deny: ["teli_mare", "zaini"] },
  top_donna: { strong: ["top_donna"], medium: ["camicie", "tshirt"], deny: ["teli_mare", "zaini"] },
  calzature: { strong: ["calzature"], medium: [], deny: ["tshirt", "jeans", "teli_mare", "zaini"] },
  cargo: { strong: ["cargo"], medium: ["jeans", "bermuda_shorts"], deny: ["tshirt", "zaini", "teli_mare"] },
  maglieria: { strong: ["maglieria"], medium: ["tshirt", "polo", "felpe"], deny: ["teli_mare", "zaini"] },
};

const recommendationCache = new Map<string, RecommendationSnapshot>();
const KNOWN_VENDORS = ["Colmar Originals", "MC2 Saint Barth", "Sprayground", "Replay", "K-Way", "Palm Angels", "Mou", "Rains", "Goorin Bros", "Flower Mountain", "4B12", "Puraai", "G-Star", "Distretto12", "Ko Samui", "Devid Label"];
const INTENT_CANDIDATES: Partial<Record<ProductIntent, Omit<CandidateIntent, "intent" | "commerceIntent">>> = {
  mc2_saint_barth: { vendor: "MC2 Saint Barth", queryTerms: ["saint barth", "mc2"], productTerms: [], categories: ["tshirt", "polo", "costumi_mare"], alternativeIntents: ["tshirt_mosca_devid_label", "monterosso_devid_label"] },
  sprayground: { vendor: "Sprayground", queryTerms: ["sprayground"], productTerms: [], categories: [], forceNoDevidAlternatives: true },
  jeans_replay_uomo: { vendor: "Replay", queryTerms: ["replay"], productTerms: ["jeans", "denim"], categories: ["jeans"], gender: "uomo", alternativeIntents: ["jeans_globe_devid_label"] },
  jeans_globe_devid_label: { vendor: "Devid Label", queryTerms: ["globe"], productTerms: ["globe", "jeans", "denim"], categories: ["jeans"] },
  cargo_courmayeur_devid_label: { vendor: "Devid Label", queryTerms: ["courmayeur"], productTerms: ["cargo", "courmayeur"], categories: ["cargo"], alternativeIntents: ["tshirt_mosca_devid_label", "monterosso_devid_label"] },
  tshirt_mosca_devid_label: { vendor: "Devid Label", queryTerms: ["mosca"], productTerms: ["mosca", "t-shirt", "scollo v"], categories: ["tshirt"] },
  monterosso_devid_label: { vendor: "Devid Label", queryTerms: ["monterosso"], productTerms: ["monterosso", "cotone", "filo"], categories: ["maglieria", "tshirt"] },
  kway: { vendor: "K-Way", queryTerms: ["k-way", "kway"], productTerms: [], categories: [], forceNoDevidAlternatives: true },
  mare_uomo: { vendor: "MC2 Saint Barth", queryTerms: ["mc2 saint barth", "costume", "mare"], productTerms: ["costume", "boxer mare", "swimwear", "beachwear"], categories: ["costumi_mare"], gender: "uomo" },
  bermuda_uomo: { vendor: "Devid Label", queryTerms: ["bermuda"], productTerms: ["bermuda", "short"], categories: ["bermuda_shorts"], gender: "uomo" },
};

async function enrichProductRecommendations(response: AssistantResponse, env: Env, normalized: NormalizedQuery): Promise<AssistantResponse> {
  if (response.type !== "product_advice") return response;
  const candidate = candidateIntentFromNormalized(normalized);
  if (!candidate) return { ...response, guardrails: [...response.guardrails, "shopify_recommendations_unavailable"] };
  try {
    const snapshot = await getRecommendationSnapshot(env, normalized, candidate);
    return { ...response, recommended_products: snapshot.recommended_products.length ? snapshot.recommended_products : response.recommended_products, devid_label_alternatives: snapshot.devid_label_alternatives.length ? snapshot.devid_label_alternatives : response.devid_label_alternatives, guardrails: [...response.guardrails, ...snapshot.guardrails], commerce_intent: toResponseCommerceIntent(snapshot.commerce_intent), ranking_strategy: snapshot.ranking_strategy, recommendation_guardrails: snapshot.guardrails };
  } catch (error) {
    console.error("Shopify recommendations unavailable", sanitizeDebugError(error).code);
    return { ...response, guardrails: [...response.guardrails, classifyShopifyGuardrail(error)] };
  }
}


const COLLECTION_TAXONOMY = {
  "moda-mare-uomo": { category: "costumi_mare", gender: "uomo", season: "summer", synonyms: ["mare uomo", "costumi uomo", "costume uomo", "boxer mare uomo"] },
  "moda-mare-donna": { category: "costumi_mare", gender: "donna", season: "summer", synonyms: ["mare donna", "costumi donna", "costume donna"] },
  "bermuda-shorts-uomo": { category: "bermuda_shorts", gender: "uomo", season: "summer", synonyms: ["short uomo", "shorts uomo", "bermuda uomo"] },
  "t-shirt-polo-uomo": { category: "tee_polo", gender: "uomo", season: "summer/continuativo", synonyms: ["tee e polo uomo", "t-shirt uomo", "t shirt uomo", "polo uomo"] },
  "t-shirt-top-donna": { category: "top_tshirt_donna", gender: "donna", season: "summer/continuativo", synonyms: ["top donna", "t-shirt donna", "t shirt donna"] },
  "camicie-bluse-donna": { category: "camicie", gender: "donna", season: "continuativo", synonyms: ["camicie donna", "camicia donna", "bluse donna"] },
} as const;

type TaxonomyCategory = typeof COLLECTION_TAXONOMY[keyof typeof COLLECTION_TAXONOMY]["category"];
const TAXONOMY_CATEGORY_TO_COMMERCE: Record<TaxonomyCategory, CommerceCategoryIntent> = { costumi_mare: "costumi_mare", bermuda_shorts: "bermuda_shorts", tee_polo: "tshirt", top_tshirt_donna: "top_donna", camicie: "camicie" };

function analyzeCommerceQueryV2(query: string): CommerceQueryIntent {
  const normalized = normalizeQueryText(query);
  const vendor = detectVendorIntent(normalized);
  const product = detectProductIntent(normalized);
  const taxonomyTargets = detectCollectionTargets(normalized);
  let category = detectCategoryIntent(normalized);
  let gender = detectGenderIntent(normalized);
  if (taxonomyTargets.length) {
    const first = COLLECTION_TAXONOMY[taxonomyTargets[0] as keyof typeof COLLECTION_TAXONOMY];
    category = TAXONOMY_CATEGORY_TO_COMMERCE[first.category];
    gender = (gender ?? first.gender) as CommerceGenderIntent;
  }
  if (/\btee e polo uomo\b|\bt-shirt uomo\b|\bt shirt uomo\b/.test(normalized)) category = "tshirt";
  if (/\btop donna\b/.test(normalized)) category = "top_donna";
  if (/\btelo|teli|towel|foutas\b/.test(normalized)) category = "teli_mare";
  if (/\bgiacca|giacche|piumino|giubbino\b/.test(normalized)) category = "outerwear";
  if (/\bzaino|zaini|backpack\b/.test(normalized)) category = "zaini";
  const faq = isFaqQuery(normalized) || isOrderQuery(normalized);
  const isVendorOnlyQuery = Boolean(vendor) && !category && !gender && !product;
  const isCategoryOnlyQuery = Boolean(category || taxonomyTargets.length) && !vendor && !product;
  const isVendorCategoryQuery = Boolean(vendor && category && !product);
  let collectionTargets = taxonomyTargets;
  if (!collectionTargets.length) collectionTargets = inferCollectionTargets(category, gender);
  let candidateStrategy: CandidateStrategy = "fallback_search";
  if (faq) candidateStrategy = "faq";
  else if (product) candidateStrategy = "product_intent";
  else if (isVendorCategoryQuery) candidateStrategy = "vendor_collection_category";
  else if (isCategoryOnlyQuery && collectionTargets.length) candidateStrategy = "collection_category";
  else if (isVendorOnlyQuery) candidateStrategy = "vendor_only";
  const confidence = faq ? 0.95 : product ? 0.97 : candidateStrategy === "fallback_search" ? 0.6 : vendor || collectionTargets.length || category ? 0.92 : 0.5;
  const guardrails = ["recommendation_engine_v2", ...(isCategoryOnlyQuery ? ["category_only_uses_collection_targets"] : []), ...(collectionTargets.length ? ["collection_taxonomy_primary"] : [])];
  return { normalized_query: normalized, vendorIntent: vendor?.vendor ?? null, categoryIntent: category, genderIntent: gender, productIntent: product, collectionTargets, candidateStrategy, confidence, isVendorOnlyQuery, isCategoryOnlyQuery, isVendorCategoryQuery, requiresStrictProductMatch: Boolean(product), guardrails };
}

function detectCollectionTargets(query: string): string[] {
  const targets: string[] = [];
  for (const [handle, meta] of Object.entries(COLLECTION_TAXONOMY)) {
    if (meta.synonyms.some((synonym) => new RegExp(`(^|\\s)${normalizeQueryText(synonym).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(query))) targets.push(handle);
  }
  if (/^costumi?$/.test(query)) targets.push("moda-mare-uomo", "moda-mare-donna");
  return [...new Set(targets)];
}

function inferCollectionTargets(category: CommerceCategoryIntent | null, gender: CommerceGenderIntent | null): string[] {
  if (category === "costumi_mare" && gender === "uomo") return ["moda-mare-uomo"];
  if (category === "costumi_mare" && gender === "donna") return ["moda-mare-donna"];
  if (category === "costumi_mare") return ["moda-mare-uomo", "moda-mare-donna"];
  if (category === "bermuda_shorts" && gender === "uomo") return ["bermuda-shorts-uomo"];
  if ((category === "tshirt" || category === "polo") && gender === "uomo") return ["t-shirt-polo-uomo"];
  if (category === "top_donna" && gender === "donna") return ["t-shirt-top-donna"];
  if (category === "camicie" && gender === "donna") return ["camicie-bluse-donna"];
  return [];
}

function buildPrimaryCtaForIntent(intent: CommerceQueryIntent): AssistantCta | null {
  const handle = intent.collectionTargets?.[0];
  if (handle) return { label: "Vedi collection", url: `/collections/${handle}` };
  const q = [intent.vendorIntent, intent.categoryIntent, intent.genderIntent].filter(Boolean).join(" ") || intent.normalized_query || "";
  return { label: "Cerca nel catalogo", url: `/search?type=product&q=${encodeURIComponent(q)}` };
}

function analyzeCommerceQuery(query: string, normalizedQuery = normalizeQueryText(query)): CommerceQueryIntent {
  const vendor = detectVendorIntent(normalizedQuery);
  const category = detectCategoryIntent(normalizedQuery);
  const gender = detectGenderIntent(normalizedQuery);
  const product = detectProductIntent(normalizedQuery);
  const residue = normalizedQuery.split(" ").filter((token) => token && ![...(vendor?.matchedAliases ?? []), ...(category ? CATEGORY_KEYWORDS[category].flatMap((x) => x.split(" ")) : []), ...(gender ? [gender, "uomo", "donna", "man", "men", "woman", "women", "unisex", "maschile", "femminile"] : [])].includes(token));
  const isVendorOnlyQuery = Boolean(vendor) && !category && !gender && !product && residue.length <= 1;
  const confidence = Math.min(0.99, (vendor ? vendor.confidence : 0) + (category ? 0.2 : 0) + (gender ? 0.12 : 0) + (product ? 0.18 : 0));
  return { vendorIntent: vendor?.vendor ?? null, categoryIntent: category, genderIntent: gender, productIntent: product, isVendorOnlyQuery, confidence: Number(confidence.toFixed(2)) };
}

function detectVendorIntent(query: string): { vendor: string; confidence: number; matchedAliases: string[] } | null {
  let best: { vendor: string; confidence: number; matchedAliases: string[]; score: number } | null = null;
  for (const vendor of VENDOR_ALIASES) {
    const matches = vendor.aliases.map(normalizeQueryText).filter((alias) => query === alias || query.includes(alias));
    if (!matches.length) continue;
    const exact = matches.some((alias) => alias === query);
    const longest = Math.max(...matches.map((alias) => alias.length));
    const score = (exact ? 1000 : 900) + longest;
    if (!best || score > best.score) best = { vendor: vendor.vendor, confidence: exact ? 0.95 : 0.9, matchedAliases: matches, score };
  }
  return best;
}

function detectCategoryIntent(query: string): CommerceCategoryIntent | null {
  let best: { category: CommerceCategoryIntent; score: number } | null = null;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as Array<[CommerceCategoryIntent, string[]]>) {
    for (const keyword of keywords.map(normalizeQueryText)) {
      if (!keyword) continue;
      const pattern = new RegExp(`(^|\\s)${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`);
      if (pattern.test(query) || query.includes(keyword)) {
        const score = keyword.length + (query === keyword ? 100 : 0);
        if (!best || score > best.score) best = { category, score };
      }
    }
  }
  return best?.category ?? null;
}

function detectGenderIntent(query: string): CommerceGenderIntent | null {
  if (/(^|\s)unisex(\s|$)/.test(query)) return "unisex";
  if (MALE_KEYWORDS.test(query)) return "uomo";
  if (FEMALE_KEYWORDS.test(query)) return "donna";
  return null;
}

function detectProductIntent(query: string): string | null {
  if (/\b(globe|jeans globe)\b/.test(query)) return "jeans_globe_devid_label";
  if (/\b(mosca|t shirt mosca|tshirt mosca)\b/.test(query)) return "tshirt_mosca_devid_label";
  if (/\b(courma|courmayeur)\b/.test(query)) return "cargo_courmayeur_devid_label";
  if (/\bmonterosso\b/.test(query)) return "monterosso_devid_label";
  return null;
}

function candidateIntentFromNormalized(normalized: NormalizedQuery): CandidateIntent | null {
  const commerceIntent = analyzeCommerceQueryV2(normalized.rawQuery);
  if (commerceIntent.productIntent && INTENT_CANDIDATES[commerceIntent.productIntent as ProductIntent]) return { intent: commerceIntent.productIntent, ...INTENT_CANDIDATES[commerceIntent.productIntent as ProductIntent]!, commerceIntent };
  if (!commerceIntent.vendorIntent && commerceIntent.categoryIntent && (commerceIntent.collectionTargets?.length ?? 0) > 0) return { intent: `category:${commerceIntent.categoryIntent}:${commerceIntent.genderIntent ?? "any"}`, vendor: "", queryTerms: [commerceIntent.categoryIntent], productTerms: [], categories: [commerceIntent.categoryIntent], gender: commerceIntent.genderIntent ?? undefined, commerceIntent };
  if (normalized.matchedIntent && INTENT_CANDIDATES[normalized.matchedIntent]) {
    const base = INTENT_CANDIDATES[normalized.matchedIntent]!;
    const shouldUseBaseCategory = !commerceIntent.vendorIntent && !commerceIntent.isVendorOnlyQuery;
    return { intent: normalized.matchedIntent, ...base, commerceIntent: { ...commerceIntent, vendorIntent: commerceIntent.vendorIntent ?? base.vendor, categoryIntent: commerceIntent.categoryIntent ?? (shouldUseBaseCategory ? base.categories[0] ?? null : null), genderIntent: commerceIntent.genderIntent ?? base.gender ?? null } };
  }
  if (!commerceIntent.vendorIntent) {
    if (commerceIntent.categoryIntent === "costumi_mare") {
      return { intent: `category:${commerceIntent.categoryIntent}:${commerceIntent.genderIntent ?? "any"}`, vendor: "", queryTerms: [commerceIntent.categoryIntent ?? ""], productTerms: [], categories: commerceIntent.categoryIntent ? [commerceIntent.categoryIntent] : [], gender: commerceIntent.genderIntent ?? undefined, commerceIntent };
    }
    if (commerceIntent.categoryIntent && (commerceIntent.collectionTargets?.length ?? 0) > 0) return { intent: `category:${commerceIntent.categoryIntent}:${commerceIntent.genderIntent ?? "any"}`, vendor: "", queryTerms: [commerceIntent.categoryIntent], productTerms: [], categories: [commerceIntent.categoryIntent], gender: commerceIntent.genderIntent ?? undefined, commerceIntent };
    return null;
  }
  return { intent: `vendor:${commerceIntent.vendorIntent}:${commerceIntent.categoryIntent ?? "any"}:${commerceIntent.genderIntent ?? "any"}`, vendor: commerceIntent.vendorIntent, queryTerms: [commerceIntent.vendorIntent], productTerms: commerceIntent.productIntent ? [commerceIntent.productIntent] : [], categories: commerceIntent.categoryIntent ? [commerceIntent.categoryIntent] : [], gender: commerceIntent.genderIntent ?? undefined, commerceIntent };
}

async function getRecommendationSnapshot(env: Env, normalized: NormalizedQuery, candidate: CandidateIntent): Promise<RecommendationSnapshot> {
  const ttl = parsePositiveInt(env.SHOPIFY_RECOMMENDATION_CACHE_TTL_SECONDS, DEFAULT_RECOMMENDATION_CACHE_TTL_SECONDS);
  const key = `v2:${candidate.commerceIntent.candidateStrategy ?? "unknown"}:${candidate.intent}:${candidate.vendor}:${normalized.normalizedQuery}:${candidate.commerceIntent.categoryIntent ?? "any"}:${candidate.commerceIntent.genderIntent ?? "any"}:${(candidate.commerceIntent.collectionTargets ?? []).join(",")}`.toLowerCase();
  const cached = recommendationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached, guardrails: [...cached.guardrails, "shopify_recommendations_cache_hit"] };
  assertShopifyConfigured(env);
  let products: ProductCandidate[];
  try { products = await fetchCandidateProducts(env, candidate); } catch (error) { throw new Error(classifyShopifyGuardrail(error, "shopify_products_unavailable")); }
  let salesStats = new Map<string, SalesStats>();
  const guardrails: string[] = [];
  try { salesStats = await fetchSalesRankLast30Days(env, candidate); } catch (_error) { guardrails.push("shopify_orders_unavailable"); }
  const ranking = rankRecommendationsWithGuardrails(products, salesStats, candidate, normalized.normalizedQuery);
  const prioritized = candidate.commerceIntent.confidence < 0.85 ? [] : applyForcedProductIntentPriority(ranking.ranked, candidate, normalized.normalizedQuery);
  const strictProductIntent = filterProductIntentRecommendations(prioritized, candidate.commerceIntent.productIntent);
  const ranked = strictProductIntent.ranked.slice(0, 3);
  const strategy = salesStats.size ? (candidate.commerceIntent.isVendorOnlyQuery ? "vendor_only_semantic_sales_30d" : "vendor_category_gender_semantic_sales_30d") : "semantic_no_recent_sales_fallback";
  const forced = getForcedProductForIntent(ranking.ranked, candidate.commerceIntent.productIntent);
  const recommendationGuardrails = [...guardrails, ...ranking.guardrails, ...strictProductIntent.guardrails, ...(candidate.commerceIntent.guardrails ?? []), ...(candidate.commerceIntent.confidence < 0.85 ? ["recommendations_empty_due_to_low_confidence"] : []), ...(ranking.ranked.length < 1 ? ["no_safe_recommendations"] : []), ...(forced && ranked[0]?.productId === forced.productId ? ["forced_product_intent_applied"] : []), salesStats.size ? "shopify_recommendations_live" : "shopify_recommendations_no_recent_sales_fallback", ...(salesStats.size ? [] : ["no_recent_sales_semantic_fallback_applied"])];
  const snapshot: RecommendationSnapshot = { recommended_products: ranked.map(toAssistantSuggestion), devid_label_alternatives: ranked.length ? await buildDevidLabelAlternatives(env, normalized, candidate) : [], guardrails: recommendationGuardrails, expiresAt: Date.now() + ttl * 1000, ranking_strategy: strategy, commerce_intent: candidate.commerceIntent, debug: buildRecommendationDebug(products, ranking.ranked, salesStats) };
  recommendationCache.set(key, snapshot);
  return snapshot;
}


function buildRecommendationDebug(before: ProductCandidate[], after: RankedRecommendation[], salesStats: Map<string, SalesStats>): RecommendationDebugSummary {
  const included = new Set(after.map((product) => product.productId));
  const excludedReasonCounts: Record<string, number> = {};
  for (const product of before) {
    if (included.has(product.productId)) continue;
    const reason = !computeAvailabilityScore(product).isAvailableForRecommendation ? "availability" : isWinterProduct(product) ? "season" : isAccessoryProduct(product) ? "accessory_or_category" : "strict_relevance";
    excludedReasonCounts[reason] = (excludedReasonCounts[reason] ?? 0) + 1;
  }
  if (!Object.keys(excludedReasonCounts).length && before.length > after.length) excludedReasonCounts.filtered_out = before.length - after.length;
  return {
    candidateCountBeforeFilters: before.length,
    candidateCountAfterFilters: after.length,
    excludedReasonCounts,
    topCandidates: after.slice(0, 10).map((product) => ({ label: product.title, handle: product.handle, vendor: product.vendor, category: detectProductCategory(product), availability: product.availability.availabilityRatio, units_sold_30d: salesStats.get(product.productId)?.unitsSold30d ?? 0 })),
  };
}

async function handleRecommendationDebugRequest(request: Request, env: Env, corsHeaders: HeadersInit): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, source: "recommendation_debug", errors: [] }, 405, { ...corsHeaders, Allow: "POST, OPTIONS" });
  if (!env.ASSISTANT_ADMIN_TOKEN || request.headers.get("X-Assistant-Admin-Token") !== env.ASSISTANT_ADMIN_TOKEN) return json({ ok: false, source: "recommendation_debug", errors: [] }, 404, corsHeaders);
  let payload: { query?: unknown } = {};
  try { payload = await request.json() as { query?: unknown }; } catch (_error) { return json({ ok: false, source: "recommendation_debug", errors: ["invalid_json"] }, 400, corsHeaders); }
  const query = typeof payload.query === "string" ? payload.query.slice(0, 120) : "";
  const intent = analyzeCommerceQueryV2(query);
  const normalized = normalizeQuery(query);
  const candidate = candidateIntentFromNormalized(normalized);
  if (!candidate || intent.candidateStrategy === "faq") return json({ ok: true, source: "recommendation_debug", normalized_query: intent.normalized_query, commerce_intent: intent, candidate_strategy: intent.candidateStrategy, collection_targets: intent.collectionTargets, vendor_intent: intent.vendorIntent, category_intent: intent.categoryIntent, gender_intent: intent.genderIntent, candidate_count_before_filters: 0, candidate_count_after_filters: 0, top_candidates: [], excluded_reason_counts: {}, guardrails: intent.guardrails }, 200, corsHeaders);
  try {
    const snapshot = await getRecommendationSnapshot(env, normalized, candidate);
    return json({ ok: true, source: "recommendation_debug", normalized_query: intent.normalized_query, commerce_intent: intent, candidate_strategy: intent.candidateStrategy, collection_targets: intent.collectionTargets, vendor_intent: intent.vendorIntent, category_intent: intent.categoryIntent, gender_intent: intent.genderIntent, candidate_count_before_filters: snapshot.debug?.candidateCountBeforeFilters ?? 0, candidate_count_after_filters: snapshot.debug?.candidateCountAfterFilters ?? 0, top_candidates: snapshot.debug?.topCandidates ?? [], excluded_reason_counts: snapshot.debug?.excludedReasonCounts ?? {}, guardrails: snapshot.guardrails }, 200, corsHeaders);
  } catch (error) {
    return json({ ok: true, source: "recommendation_debug", normalized_query: intent.normalized_query, commerce_intent: intent, candidate_strategy: intent.candidateStrategy, collection_targets: intent.collectionTargets, vendor_intent: intent.vendorIntent, category_intent: intent.categoryIntent, gender_intent: intent.genderIntent, candidate_count_before_filters: 0, candidate_count_after_filters: 0, top_candidates: [], excluded_reason_counts: {}, guardrails: [...(intent.guardrails ?? []), classifyShopifyGuardrail(error)] }, 200, corsHeaders);
  }
}

function toResponseCommerceIntent(intent: CommerceQueryIntent): AssistantResponse["commerce_intent"] { return { vendor: intent.vendorIntent, category: intent.categoryIntent, gender: intent.genderIntent, product: intent.productIntent, confidence: intent.confidence, is_vendor_only_query: intent.isVendorOnlyQuery }; }

function normalizeShopifyShopDomain(env: Env): string {
  const domain = env.SHOPIFY_SHOP_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!domain) throw new Error("shopify_config_missing");
  return domain;
}

function maskShopDomain(domain: string): string {
  const normalized = domain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
  const match = normalized.match(/^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/);
  if (!match) return "configured_invalid_format";
  const prefix = match[1];
  return `${prefix.slice(0, Math.min(4, prefix.length))}****.myshopify.com`;
}

function sanitizeDebugError(error: unknown): { code: string; message: string } {
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const knownCode = classifyKnownShopifyError(rawMessage);
  if (!rawMessage) return { code: knownCode, message: "Errore Shopify non disponibile in forma sicura." };
  const redacted = rawMessage
    .replace(/(Authorization|X-Shopify-Access-Token)\s*[:=]\s*[^\s,;]+/gi, "$1:[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(access_token|client_secret|token|secret)\s*[:=]\s*['\"]?[^'\"\\s,;}]+/gi, "$1:[redacted]")
    .replace(/shpat_[A-Za-z0-9_]+/gi, "[redacted]")
    .replace(/shp[a-z]?_[A-Za-z0-9_]+/gi, "[redacted]");
  const safeMessage = redacted.length > 300 ? `${redacted.slice(0, 297)}...` : redacted;
  return { code: knownCode, message: safeMessage || "Errore Shopify non disponibile in forma sicura." };
}

function classifyKnownShopifyError(message: string): string {
  if (/shopify_auth|oauth|401|403/i.test(message)) return "shopify_auth_unavailable";
  if (/shopify_config|domain/i.test(message)) return "shopify_config_missing";
  if (/graphql|products|orders|inventory|status|timeout|abort/i.test(message)) return "shopify_graphql_unavailable";
  return "shopify_debug_unavailable";
}

function classifyShopifyGuardrail(error: unknown, fallback = "shopify_recommendations_unavailable"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/shopify_auth|oauth|401|403/i.test(message)) return "shopify_auth_unavailable";
  if (/shopify_products_unavailable/i.test(message)) return "shopify_products_unavailable";
  if (/shopify_orders_unavailable/i.test(message)) return "shopify_orders_unavailable";
  return fallback;
}

function assertShopifyConfigured(env: Env): void {
  if (!env.SHOPIFY_SHOP_DOMAIN) throw new Error("shopify_config_missing");
}

async function resolveShopifyAdminAccessToken(env: Env): Promise<{ accessToken: string; source: ShopifyAuthTokenSource }> {
  assertShopifyConfigured(env);
  const now = Date.now();
  const storedToken = await loadStoredShopifyOAuthToken(env);
  if (storedToken) {
    shopifyTokenCache = { accessToken: storedToken, expiresAt: now + SHOPIFY_TOKEN_FALLBACK_TTL_SECONDS * 1000, source: "oauth_kv" };
    return { accessToken: storedToken, source: "oauth_kv" };
  }

  if (env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    return { accessToken: env.SHOPIFY_ADMIN_ACCESS_TOKEN, source: "legacy_secret" };
  }

  throw new Error("shopify_admin_token_missing");
}

async function getShopifyAdminAccessToken(env: Env): Promise<string> {
  return (await resolveShopifyAdminAccessToken(env)).accessToken;
}

async function shopifyGraphQL<T>(env: Env, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  assertShopifyConfigured(env);
  const token = await getShopifyAdminAccessToken(env);
  const domain = normalizeShopifyShopDomain(env);
  const version = env.SHOPIFY_API_VERSION || DEFAULT_SHOPIFY_API_VERSION;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, { method: "POST", headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }), signal: controller.signal });
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
  return fetchRecommendationCandidates(env, candidateIntent);
}

async function fetchRecommendationCandidates(env: Env, candidateIntent: CandidateIntent): Promise<ProductCandidate[]> {
  const strategy = candidateIntent.commerceIntent.candidateStrategy ?? "fallback_search";
  const collections = candidateIntent.commerceIntent.collectionTargets ?? [];
  const seen = new Map<string, ProductCandidate>();
  if ((strategy === "collection_category" || strategy === "vendor_collection_category") && collections.length) {
    for (const handle of collections) for (const product of await fetchProductsByCollection(env, handle)) seen.set(product.productId, product);
  } else {
    const terms = candidateIntent.vendor ? `vendor:'${candidateIntent.vendor.replace(/'/g, "")}'` : candidateIntent.queryTerms.join(" ");
    for (const product of await fetchProductsByQuery(env, terms)) seen.set(product.productId, product);
  }
  let products = [...seen.values()];
  if (strategy === "vendor_collection_category" || strategy === "vendor_only" || strategy === "product_intent") {
    products = products.filter((product) => !candidateIntent.vendor || normalizeQueryText(product.vendor) === normalizeQueryText(candidateIntent.vendor));
  }
  if (strategy === "product_intent") products = products.filter((product) => matchesCandidateProduct(product, candidateIntent));
  return products;
}

async function fetchProductsByQuery(env: Env, terms: string): Promise<ProductCandidate[]> {
  const data = await shopifyGraphQL<ShopifyProductsData>(env, `query Products($query: String!) { products(first: 50, query: $query) { edges { node { id title handle vendor productType tags onlineStoreUrl status publishedAt updatedAt featuredImage { url } collections(first: 10) { edges { node { handle title } } } variants(first: 50) { edges { node { id title selectedOptions { name value } inventoryQuantity availableForSale } } } } } } }`, { query: terms });
  return mapShopifyProducts(data.products.edges);
}

async function fetchProductsByCollection(env: Env, handle: string): Promise<ProductCandidate[]> {
  const data = await shopifyGraphQL<ShopifyCollectionProductsData>(env, `query CollectionProducts($handle: String!) { collectionByHandle(handle: $handle) { products(first: 50) { edges { node { id title handle vendor productType tags onlineStoreUrl status publishedAt updatedAt featuredImage { url } collections(first: 10) { edges { node { handle title } } } variants(first: 50) { edges { node { id title selectedOptions { name value } inventoryQuantity availableForSale } } } } } } } }`, { handle });
  return mapShopifyProducts(data.collectionByHandle?.products.edges ?? []);
}

function mapShopifyProducts(edges: ShopifyProductsData["products"]["edges"]): ProductCandidate[] {
  return edges.map(({ node }) => ({ productId: node.id, title: node.title, handle: node.handle, vendor: node.vendor, productType: node.productType, tags: node.tags ?? [], collections: node.collections?.edges.map(({ node: collection }) => ({ handle: collection.handle, title: collection.title })) ?? [], image: node.featuredImage?.url, onlineStoreUrl: node.onlineStoreUrl, status: node.status, publishedAt: node.publishedAt, updatedAt: node.updatedAt, variants: node.variants.edges.map(({ node: variant }) => ({ variantId: variant.id, title: variant.title, selectedOptions: variant.selectedOptions ?? [], inventoryQuantity: variant.inventoryQuantity, availableForSale: variant.availableForSale })) }));
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
  return rankRecommendationsWithGuardrails(products, salesStats, candidateIntent).ranked;
}

function rankRecommendationsWithGuardrails(products: ProductCandidate[], salesStats: Map<string, SalesStats>, candidateIntent: CandidateIntent, normalizedQuery = ""): RecommendationRankingResult {
  const guardrails: string[] = [];
  const scored = products
    .map((product, shopifyPosition) => {
      const scoredProduct = scoreProductCandidate(product, candidateIntent, salesStats.get(product.productId));
      return { ...product, salesStats: salesStats.get(product.productId), availability: computeAvailabilityScore(product), coherenceScore: scoredProduct.score - shopifyPosition / 1000, categoryMatch: scoredProduct.categoryMatch };
    })
    .filter((product) => product.availability.isAvailableForRecommendation);
  if (scored.length !== products.length) guardrails.push("availability_filter_applied");

  let compatible = scored;
  const commerce = candidateIntent.commerceIntent;
  if (commerce.vendorIntent) {
    const before = compatible.length;
    compatible = compatible.filter((product) => normalizeQueryText(product.vendor) === normalizeQueryText(commerce.vendorIntent!));
    if (compatible.length < before) guardrails.push("vendor_filter_applied");
  }
  if (commerce.genderIntent && commerce.genderIntent !== "unisex") {
    const before = compatible.length;
    compatible = compatible.filter((product) => isGenderCompatible(product, commerce.genderIntent!));
    if (compatible.length < before) guardrails.push("hard_gender_filter_applied");
  }

  if (commerce.isVendorOnlyQuery) {
    guardrails.push("vendor_only_seasonal_ranking_applied", "seasonal_filter_applied");
    const summer = compatible.filter((product) => getSeasonSignal(product) === "summer" && !isWinterProduct(product));
    if (summer.length) compatible = summer;
    else guardrails.push("vendor_only_seasonal_fallback_unavailable");
  }

  const category = commerce.categoryIntent;
  if (category && !commerce.isVendorOnlyQuery) {
    guardrails.push("hard_category_filter_applied");
    if (category === "costumi_mare") guardrails.push("strict_swimwear_filter_applied", "strict_swimwear_vendor_filter_applied");
    if (commerce.productIntent) guardrails.push("strict_product_intent_filter_applied");
    const before = compatible.length;
    compatible = compatible.filter((product) => isProductCommerciallyCompatible(product, commerce, normalizedQuery, "strong"));
    if (compatible.length < before) guardrails.push("incompatible_category_excluded");
    if (!compatible.length) {
      const allowMedium = !commerce.productIntent && category !== "costumi_mare";
      const medium = allowMedium ? scored.filter((product) => isProductCommerciallyCompatible(product, commerce, normalizedQuery, "medium") && (!commerce.genderIntent || commerce.genderIntent === "unisex" || isGenderCompatible(product, commerce.genderIntent))) : [];
      if (medium.length) { compatible = medium; guardrails.push("medium_category_fallback_used"); }
      else { guardrails.push(category === "costumi_mare" ? "no_strong_mare_uomo_products_found" : "no_compatible_products_found", ...(category === "costumi_mare" ? ["no_strong_swimwear_products_found"] : []), "recommendations_not_filled_due_to_strict_filter"); compatible = []; }
    }
  }

  const beforeFinal = compatible.length;
  compatible = compatible.filter((product) => isFinalRecommendationAllowed(product, commerce, normalizedQuery));
  guardrails.push("final_strict_recommendation_filter_applied");
  if (compatible.length < beforeFinal) guardrails.push("final_incoherent_products_excluded");

  return { ranked: compatible.sort((a, b) => b.coherenceScore - a.coherenceScore || (b.salesStats?.unitsSold30d ?? 0) - (a.salesStats?.unitsSold30d ?? 0) || b.availability.availabilityRatio - a.availability.availabilityRatio || Number(Boolean(b.publishedAt || b.status === "ACTIVE")) - Number(Boolean(a.publishedAt || a.status === "ACTIVE"))), guardrails };
}

function isFinalRecommendationAllowed(product: RankedRecommendation, commerceIntent: CommerceQueryIntent, normalizedQuery = ""): boolean {
  if (!product.availability.isAvailableForRecommendation) return false;
  if (commerceIntent.vendorIntent && normalizeQueryText(product.vendor) !== normalizeQueryText(commerceIntent.vendorIntent)) return false;
  if (commerceIntent.genderIntent && commerceIntent.genderIntent !== "unisex" && !isGenderCompatible(product, commerceIntent.genderIntent)) return false;
  if (commerceIntent.categoryIntent && !commerceIntent.isVendorOnlyQuery && !isProductCommerciallyCompatible(product, commerceIntent, normalizedQuery, "strong")) return false;
  if (commerceIntent.productIntent && !isStrongProductIntentMatch(product, commerceIntent.productIntent)) return false;
  if (requiresSummerContext(commerceIntent, normalizedQuery) && isWinterProduct(product)) return false;
  if (commerceIntent.categoryIntent === "costumi_mare" && isExplicitlyDeniedSwimwearFallback(product)) return false;
  return true;
}

function isStrongProductIntentMatch(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }, productIntent: string | null): boolean {
  if (!productIntent) return true;
  if (normalizeQueryText(product.vendor ?? "") !== "devid label") return false;
  if (isAccessoryProduct(product)) return false;
  const text = productSearchText(product);
  const category = detectProductCategory(product);
  const rules: Record<string, { model: RegExp; categories: CommerceCategoryIntent[]; denied: RegExp }> = {
    jeans_globe_devid_label: { model: /(^|\s)(globe|jeans\s+globe)(\s|$)/, categories: ["jeans"], denied: /(^|\s)(shopper|ecopelle|borsa|borse|accessori|pochette|vanity|clutch|zaino|backpack|t\s?shirt|t-shirt|tshirt|maglia|cargo|bermuda)(\s|$)/ },
    tshirt_mosca_devid_label: { model: /(^|\s)(mosca|t\s?shirt\s+mosca|t-shirt\s+mosca|tshirt\s+mosca)(\s|$)/, categories: ["tshirt"], denied: /(^|\s)(monterosso|corniglia|globe|shopper|ecopelle|borsa|borse|accessori|pochette|vanity|clutch|zaino|backpack|jeans|denim|cargo|bermuda)(\s|$)/ },
    cargo_courmayeur_devid_label: { model: /(^|\s)(courmayeur|courma|courmayer|cargo\s+courmayeur|cargo\s+courma|cargo\s+courmayer)(\s|$)/, categories: ["cargo"], denied: /(^|\s)(globe|jeans|denim|bermuda|shopper|ecopelle|borsa|borse|accessori|pochette|vanity|clutch|zaino|backpack|t\s?shirt|t-shirt|tshirt|maglia)(\s|$)/ },
    monterosso_devid_label: { model: /(^|\s)monterosso(\s|$)/, categories: ["maglieria", "tshirt"], denied: /(^|\s)(mosca|corniglia|shopper|ecopelle|borsa|borse|accessori|pochette|vanity|clutch|zaino|backpack|globe|jeans|denim|cargo|bermuda)(\s|$)/ },
  };
  const rule = rules[productIntent];
  if (!rule) return true;
  if (rule.denied.test(text)) return false;
  if (!rule.model.test(text)) return false;
  return Boolean(category && rule.categories.includes(category));
}

function filterProductIntentRecommendations(products: RankedRecommendation[], productIntent: string | null): RecommendationRankingResult {
  if (!productIntent) return { ranked: products, guardrails: [] };
  const ranked = products.filter((product) => isStrongProductIntentMatch(product, productIntent));
  const guardrails = ["product_intent_strict_filter_applied"];
  if (ranked.length < products.length) guardrails.push("product_intent_incoherent_fill_excluded");
  if (ranked.length <= 1) guardrails.push("product_intent_no_fill_applied");
  return { ranked, guardrails };
}

function isGenderCompatible(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }, gender: CommerceGenderIntent): boolean {
  if (gender === "unisex") return true;
  const text = productSearchText(product);
  const female = FEMALE_KEYWORDS.test(text) || /(^|\s)(girl|girls|lady|ladies|top\s+donna)(\s|$)/.test(text);
  const male = MALE_KEYWORDS.test(text) || /(^|\s)(boy|boys)(\s|$)/.test(text);
  if (gender === "uomo") return !female;
  if (gender === "donna") return !male;
  return true;
}

function getSeasonSignal(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }): SeasonSignal {
  const text = productSearchText(product);
  if (WINTER_KEYWORDS.test(text)) return "winter";
  if (SUMMER_KEYWORDS.test(text)) return "summer";
  return "neutral";
}

function isWinterProduct(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }): boolean { return getSeasonSignal(product) === "winter"; }
function requiresSummerContext(commerceIntent: CommerceQueryIntent, normalizedQuery = ""): boolean { return commerceIntent.isVendorOnlyQuery || commerceIntent.categoryIntent === "costumi_mare" || /(^|\s)(mare|costume|costumi|boxer|swim|beach)(\s|$)/.test(normalizedQuery); }

function isProductCommerciallyCompatible(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }, commerceIntent: CommerceQueryIntent, normalizedQuery = "", mode: "strong" | "medium" = "strong"): boolean {
  if (!commerceIntent.categoryIntent || commerceIntent.isVendorOnlyQuery) return true;
  if (commerceIntent.genderIntent && commerceIntent.genderIntent !== "unisex" && !isGenderCompatible(product, commerceIntent.genderIntent)) return false;
  const productCategory = detectProductCategory(product);
  const categoryMatch = classifyCategoryCompatibility(productCategory, commerceIntent.categoryIntent);
  if (categoryMatch === "denied" || isDeniedAccessoryForCategory(product, commerceIntent.categoryIntent)) return false;
  if (commerceIntent.categoryIntent === "costumi_mare") {
    if (isExplicitlyDeniedSwimwearFallback(product)) return false;
    if (categoryMatch === "strong") return hasStrongSwimwearSignal(product);
    if (mode === "medium" && categoryMatch === "medium") return hasMediumSwimwearSignal(product);
    return false;
  }
  if (commerceIntent.categoryIntent === "tshirt" && /(^|\s)(costume|costumi|boxer|swim|telo|teli|towel|foutas|cuffia|cappello|beanie|borsa|pochette)(\s|$)/.test(productSearchText(product))) return false;
  if (commerceIntent.productIntent) return categoryMatch === "strong";
  if (categoryMatch === "strong") return true;
  if (mode === "medium" && categoryMatch === "medium") return true;
  return mode === "medium" && categoryMatch === "unknown" && !isAccessoryProduct(product);
}

function hasStrongSwimwearSignal(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }): boolean {
  return /(^|\s)(costume|costumi|boxer\s+mare|swim\s+shorts|swimwear|beachwear)(\s|$)/.test(productSearchText(product));
}

function hasMediumSwimwearSignal(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }): boolean {
  const text = productSearchText(product);
  return /(^|\s)(bermuda|shorts|short)(\s|$)/.test(text) && /(^|\s)(mare|beach|swim|costume|costumi|boxer|beachwear|swimwear)(\s|$)/.test(text);
}

function isExplicitlyDeniedSwimwearFallback(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }): boolean {
  return /(^|\s)(maglia|maglieria|t\s?shirt|t-shirt|tshirt|polo|felpa|cardigan|outerwear|jeans|borsa|borse|accessori|cuffia|cappello|cap|hat|shopper|pochette|vanity|clutch|telo|teli|towel|foutas)(\s|$)/.test(productSearchText(product));
}

function isDeniedAccessoryForCategory(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }, queryCategory: CommerceCategoryIntent): boolean {
  const productCategory = detectProductCategory(product);
  if (["tshirt", "polo", "maglieria", "outerwear"].includes(queryCategory) && isAccessoryProduct(product)) return true;
  if (queryCategory === "costumi_mare" && ["borse_accessori", "zaini"].includes(productCategory ?? "")) return true;
  if (queryCategory === "jeans" && isAccessoryProduct(product)) return true;
  return false;
}

function isAccessoryProduct(product: ProductCandidate | Pick<ProductCandidate, "title" | "productType" | "tags">): boolean {
  return /(^|\s)(cuffia|cappello|cap|hat|beanie|shopper|borsa|borse|pochette|vanity|clutch|marsupio|wallet|portafoglio|zaino|backpack|telo|towel|foutas)(\s|$)/.test(productSearchText(product));
}

function getForcedProductForIntent(products: RankedRecommendation[], productIntent: string | null): RankedRecommendation | null {
  if (!productIntent) return null;
  const matchers: Record<string, RegExp> = {
    jeans_globe_devid_label: /(^|\s)(jeans\s+globe|globe)(\s|$)/,
    tshirt_mosca_devid_label: /(^|\s)(t\s?shirt\s+mosca|t-shirt\s+mosca|mosca)(\s|$)/,
    cargo_courmayeur_devid_label: /(^|\s)(cargo\s+courmayeur|courmayeur|courma)(\s|$)/,
    monterosso_devid_label: /(^|\s)monterosso(\s|$)/,
  };
  const matcher = matchers[productIntent];
  if (!matcher) return null;
  return products.find((product) => normalizeQueryText(product.vendor) === "devid label" && matcher.test(productSearchText(product))) ?? null;
}

function applyForcedProductIntentPriority(products: RankedRecommendation[], candidateIntent: CandidateIntent, normalizedQuery = ""): RankedRecommendation[] {
  const forced = getForcedProductForIntent(products, candidateIntent.commerceIntent.productIntent);
  if (!forced || !isProductCommerciallyCompatible(forced, candidateIntent.commerceIntent, normalizedQuery, "medium")) return products;
  return [forced, ...products.filter((product) => product.productId !== forced.productId)];
}

function scoreProductCandidate(product: ProductCandidate, candidate: CandidateIntent, sales?: SalesStats): { score: number; categoryMatch: RankedRecommendation["categoryMatch"] } {
  const commerce = candidate.commerceIntent;
  const text = productSearchText(product);
  let score = 0;
  if (normalizeQueryText(product.vendor) === normalizeQueryText(candidate.vendor)) score += 100;
  else if (commerce.vendorIntent) score -= 60;
  const categoryMatch = commerce.categoryIntent ? classifyCategoryCompatibility(detectProductCategory(product), commerce.categoryIntent) : "unknown";
  if (categoryMatch === "strong") score += 80;
  if (categoryMatch === "medium") score += 45;
  if (categoryMatch === "denied") score -= 120;
  if (commerce.categoryIntent && isApparelCategory(commerce.categoryIntent) && ["teli_mare", "zaini", "borse_accessori"].includes(detectProductCategory(product) ?? "")) score -= 100;
  if (commerce.genderIntent && commerce.genderIntent !== "unisex") {
    const productGender = detectGenderIntent(text);
    if (productGender === commerce.genderIntent || productGender === "unisex") score += 40;
    else if (productGender && productGender !== commerce.genderIntent) score -= 80;
  }
  if (commerce.productIntent && text.includes(normalizeQueryText(commerce.productIntent.replace(/_/g, " ")))) score += 30;
  const season = getSeasonSignal(product);
  if (requiresSummerContext(commerce, "") && season === "summer") score += 35;
  if (requiresSummerContext(commerce, "") && season === "winter") score -= 160;
  if (commerce.isVendorOnlyQuery && isAccessoryProduct(product)) score -= 25;
  const availability = computeAvailabilityScore(product); score += Math.round(availability.availabilityRatio * 20);
  score += Math.min(25, sales?.unitsSold30d ?? 0);
  return { score, categoryMatch };
}

function detectProductCategory(product: ProductCandidate | Pick<ProductCandidate, "title" | "productType" | "tags">): CommerceCategoryIntent | null {
  const preciseText = normalizeQueryText([(product as ProductCandidate).title, (product as ProductCandidate).productType, ...((product as ProductCandidate).tags ?? [])].filter(Boolean).join(" "));
  if (/(^|\s)(telo|teli|towel|foutas)(\s|$)/.test(preciseText)) return "teli_mare";
  const collections = "collections" in product ? product.collections ?? [] : [];
  for (const collection of collections) {
    const taxonomy = COLLECTION_TAXONOMY[collection.handle as keyof typeof COLLECTION_TAXONOMY];
    if (taxonomy) return TAXONOMY_CATEGORY_TO_COMMERCE[taxonomy.category];
  }
  const productTypeCategory = detectCategoryIntent(normalizeQueryText((product as ProductCandidate).productType || ""));
  if (productTypeCategory) return productTypeCategory;
  const tagsCategory = detectCategoryIntent(normalizeQueryText(((product as ProductCandidate).tags ?? []).join(" ")));
  if (tagsCategory) return tagsCategory;
  return detectCategoryIntent(productSearchText(product));
}
function productSearchText(product: Pick<ProductCandidate, "title" | "productType" | "tags"> & { handle?: string; vendor?: string; collections?: ProductCollectionCandidate[] }): string { return normalizeQueryText([product.title, product.handle, product.vendor, product.productType, ...(product.tags ?? []), ...((product.collections ?? []).flatMap((c) => [c.handle, c.title]))].filter(Boolean).join(" ")); }
function classifyCategoryCompatibility(productCategory: CommerceCategoryIntent | null, queryCategory: CommerceCategoryIntent): RankedRecommendation["categoryMatch"] { const map = CATEGORY_COMPATIBILITY[queryCategory]; if (!productCategory) return "unknown"; if (map.strong.includes(productCategory)) return "strong"; if (map.medium.includes(productCategory)) return "medium"; if (map.deny.includes(productCategory)) return "denied"; return "unknown"; }
function isApparelCategory(category: CommerceCategoryIntent): boolean { return ["tshirt", "polo", "jeans", "outerwear", "felpe", "camicie", "top_donna", "cargo", "maglieria", "bermuda_shorts"].includes(category); }

async function buildDevidLabelAlternatives(env: Env, normalizedIntent: NormalizedQuery, mainIntent: CandidateIntent): Promise<AssistantSuggestion[]> {
  if (mainIntent.forceNoDevidAlternatives) return [];
  const intents = mainIntent.alternativeIntents ?? [];
  const out: AssistantSuggestion[] = [];
  for (const intent of intents) {
    const config = INTENT_CANDIDATES[intent]; if (!config) continue;
    const commerceIntent: CommerceQueryIntent = { vendorIntent: config.vendor, categoryIntent: config.categories[0] ?? null, genderIntent: config.gender ?? null, productIntent: intent, isVendorOnlyQuery: false, confidence: 0.9 };
    const alternativeCandidate: CandidateIntent = { intent, ...config, commerceIntent };
    const products = await fetchCandidateProducts(env, alternativeCandidate);
    const ranked = rankRecommendations(products, new Map(), alternativeCandidate);
    if (ranked[0]) out.push(toAssistantSuggestion(ranked[0]));
    if (out.length >= 2) break;
  }
  return out;
}

function isVariantAvailable(variant: ProductVariantCandidate): boolean { return (typeof variant.inventoryQuantity === "number" && variant.inventoryQuantity > 0) || variant.availableForSale === true; }
function matchesCandidateProduct(product: Pick<ProductCandidate, "vendor" | "title" | "productType" | "tags">, candidate: CandidateIntent): boolean { const vendorMatches = normalizeQueryText(product.vendor) === normalizeQueryText(candidate.vendor); if (!vendorMatches) return false; if (candidate.commerceIntent.isVendorOnlyQuery) return true; const pseudo = { ...product, collections: [] as ProductCollectionCandidate[] }; const category = candidate.commerceIntent.categoryIntent; if (category && !isProductCommerciallyCompatible(pseudo, candidate.commerceIntent, "", "medium")) return false; return true; }
function toAssistantSuggestion(product: ProductCandidate): AssistantSuggestion { return { label: product.title, message: product.vendor || product.productType || "Prodotto consigliato", url: product.handle.startsWith("/products/") ? product.handle : `/products/${product.handle}`, image: product.image, type: "product" }; }
function parsePositiveInt(value: string | undefined, fallback: number): number { const parsed = Number.parseInt(value ?? "", 10); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback; }

export { handleShopifyInstallRequest, handleShopifyAuthCallbackRequest, handleShopifyDebugRequest, persistShopifyOAuthToken, encryptShopifyToken, decryptShopifyToken, resolveShopifyAdminAccessToken, analyzeCommerceQuery, detectVendorIntent, detectCategoryIntent, detectGenderIntent, isProductCommerciallyCompatible, isAccessoryProduct, getForcedProductForIntent, scoreProductCandidate, getShopifyAdminAccessToken, shopifyGraphQL, fetchSalesRankLast30Days, fetchCandidateProducts, computeAvailabilityScore, rankRecommendations, buildDevidLabelAlternatives, maskShopDomain, sanitizeDebugError, verifyShopifyHmac, exchangeShopifyOAuthCode, normalizeOrderNumber, isMarketplaceOrder, buildSafeOrderLookup, normalizeTrackingUrl, handleOrderLookupRequest };
