import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

/** Read-only Listings Items GET. Presence is separate from verified current
 * FBM quantity and B2C ALL price. No result proves writer ownership, available
 * cross-channel budget or permission to publish/change inventory. */
type Row = Record<string, unknown>;
type Env = AmazonCredentials & { AMAZON_SP_API_SELLER_ID?: string };
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Input = Readonly<{ marketplace: Market; skus: readonly string[] }>;
export type AmazonSellerListingsDirectDependencies = {
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
};
export type AmazonCurrentOffer = {
  marketplace_id: string;
  offer_type: "B2C" | "B2B";
  audience: string | null;
  amount: string;
  currency_code: string;
};
type Observation = {
  observed_at: string;
  identity_state: "VERIFIED" | "UNKNOWN";
  identity_reason: string;
  fulfillment_state: "VERIFIED" | "UNKNOWN";
  fulfillment_reason: string;
  current_fbm_quantity: number | null;
  price_state: "VERIFIED" | "UNKNOWN";
  price_reason: string;
  current_b2c_price: { amount: string; currency_code: string } | null;
  current_offers: AmazonCurrentOffer[];
  observation_complete: boolean;
};
export type AmazonSellerListingEntry = Observation & {
  sku: string;
  state: "PRESENT" | "PRESENT_ATTRIBUTES_UNKNOWN" | "VERIFIED_ABSENT" | "UNKNOWN";
  reason: string;
  request_id: string | null;
  asin?: string | null;
  product_type?: string | null;
  statuses?: string[];
  reported_offer_count?: number;
  listing_issues_count?: number;
  issue_signals?: Array<{ code: string; severity: string; categories: string[]; attribute_names: string[] }>;
  issue_signals_truncated?: boolean;
};
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const ATOM_RE = /^[A-Za-z0-9_-]+$/;
const DECIMAL_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_SKUS = 8;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_OFFERS = 32;
const MAX_CHANNELS = 32;
const TIMEOUT_MS = 20_000;
const HTTP_CODES = new Set([400, 401, 403, 404, 413, 415, 429, 500, 502, 503, 504]);
const FLAGS = {
  read_only: true,
  has_created_or_updated_offer: false,
  can_publish: false,
  can_change_stock: false,
  provider_mutations: 0,
  must_verify_channable_writer_ownership: true
} as const;

class ReadFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new ReadFailure(code); }
function dict(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function atom(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max && ATOM_RE.test(value);
}
function requestId(response: Response): string | null {
  const raw = response.headers.get("x-amzn-requestid") || response.headers.get("x-amzn-request-id") || "";
  return /^[A-Za-z0-9-]{6,128}$/.test(raw) ? raw : null;
}
function now(clock: () => number): string {
  const time = clock();
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isFinite(new Date(time).getTime()))
    fail("amazon_seller_listings_direct_invalid_clock");
  return new Date(time).toISOString();
}
function validateInput(raw: unknown): Input {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_request");
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_request");
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2 || keys.some(key => key !== "marketplace" && key !== "skus")) fail("invalid_request");
    const marketProperty = Object.getOwnPropertyDescriptor(raw, "marketplace");
    const skuProperty = Object.getOwnPropertyDescriptor(raw, "skus");
    if (!marketProperty || !skuProperty || !("value" in marketProperty) || !("value" in skuProperty) ||
        !marketProperty.enumerable || !skuProperty.enumerable) fail("invalid_request");
    const market: unknown = marketProperty.value, values: unknown = skuProperty.value;
    if (typeof market !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, market) ||
        !Array.isArray(values) || values.length < 1 || values.length > MAX_SKUS) fail("invalid_request");
    // A sparse array, custom property, symbol or getter must not survive a
    // later serialization differently from the validated request.
    const arrayKeys = Reflect.ownKeys(values);
    if (arrayKeys.length !== values.length + 1 ||
        arrayKeys.some(key => key !== "length" &&
          (typeof key !== "string" || !/^[0-7]$/.test(key) || Number(key) >= values.length)))
      fail("invalid_request");
    const skus: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const property = Object.getOwnPropertyDescriptor(values, String(i));
      if (!property || !property.enumerable || !("value" in property) || typeof property.value !== "string" ||
          !SKU_RE.test(property.value) || property.value !== property.value.trim()) fail("invalid_request");
      skus.push(property.value);
    }
    if (new Set(skus).size !== skus.length) fail("invalid_request");
    return Object.freeze({ marketplace: market as Market, skus: Object.freeze(skus) });
  } catch { throw new Error("amazon_seller_listings_direct_invalid_request"); }
}
function unknownObservation(observedAt: string, identityReason: string): Observation {
  return {
    observed_at: observedAt,
    identity_state: "UNKNOWN", identity_reason: identityReason,
    fulfillment_state: "UNKNOWN", fulfillment_reason: "listing_identity_unverified",
    current_fbm_quantity: null,
    price_state: "UNKNOWN", price_reason: "listing_identity_unverified",
    current_b2c_price: null, current_offers: [], observation_complete: false
  };
}
function unknownEntry(sku: string, reason: string, reqId: string | null, observedAt: string): AmazonSellerListingEntry {
  return { sku, state: "UNKNOWN", reason, request_id: reqId, ...unknownObservation(observedAt, reason) };
}

/** No provider messages, localized audience labels, URLs or arbitrary fields. */
function safeIssues(raw: unknown, marketplaceId: string): {
  issues: Array<{ code: string; severity: string; categories: string[]; attribute_names: string[] }>;
  count: number; truncated: boolean;
} {
  if (!Array.isArray(raw)) return { issues: [], count: 0, truncated: false };
  const issues = raw.map(dict).filter(issue => !issue.marketplaceId || issue.marketplaceId === marketplaceId);
  const safe = (value: unknown, max: number): string => atom(value, max) ? value : "UNVERIFIED";
  const many = (value: unknown, max: number): string[] =>
    Array.isArray(value) ? value.slice(0, 8).map(item => safe(item, max)) : [];
  return {
    issues: issues.slice(0, 32).map(issue => ({
      code: safe(issue.code, 72),
      severity: typeof issue.severity === "string" && ["ERROR", "WARNING", "INFO"].includes(issue.severity)
        ? issue.severity : "UNVERIFIED",
      categories: many(issue.categories, 72),
      attribute_names: many(issue.attributeNames, 120)
    })),
    count: issues.length, truncated: issues.length > 32
  };
}
function fulfillment(raw: unknown): Pick<Observation, "fulfillment_state" | "fulfillment_reason" | "current_fbm_quantity"> {
  const unknown = (reason: string) => ({
    fulfillment_state: "UNKNOWN" as const, fulfillment_reason: reason, current_fbm_quantity: null
  });
  if (raw === undefined || raw === null) return unknown("fulfillment_availability_missing");
  if (!Array.isArray(raw) || raw.length > MAX_CHANNELS) return unknown("fulfillment_availability_invalid");
  const rows = raw.map(dict);
  if (rows.some(row => !atom(row.fulfillmentChannelCode, 64))) return unknown("fulfillment_availability_invalid");
  const defaults = rows.filter(row => row.fulfillmentChannelCode === "DEFAULT");
  if (defaults.length === 0) return unknown("default_channel_missing");
  if (defaults.length !== 1) return unknown("default_channel_ambiguous");
  const quantity = defaults[0].quantity;
  if (quantity === undefined || quantity === null) return unknown("default_quantity_missing");
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0)
    return unknown("default_quantity_invalid");
  return { fulfillment_state: "VERIFIED", fulfillment_reason: "default_quantity_observed", current_fbm_quantity: quantity };
}
function currentOffers(raw: unknown, marketplaceId: string): Pick<Observation,
  "price_state" | "price_reason" | "current_b2c_price" | "current_offers"> {
  const unknown = (reason: string, offers: AmazonCurrentOffer[] = []) => ({
    price_state: "UNKNOWN" as const, price_reason: reason, current_b2c_price: null, current_offers: offers
  });
  if (raw === undefined || raw === null) return unknown("offers_missing");
  if (!Array.isArray(raw) || raw.length > MAX_OFFERS) return unknown("offers_invalid");
  const rows = raw.map(dict);
  if (rows.some(row => typeof row.marketplaceId !== "string" || !/^[A-Z0-9]{8,20}$/.test(row.marketplaceId)))
    return unknown("offers_invalid");
  const selected = rows.filter(row => row.marketplaceId === marketplaceId);
  if (selected.length === 0) return unknown("marketplace_offers_missing");
  const offers: AmazonCurrentOffer[] = [];
  for (const row of selected) {
    const price = dict(row.price);
    let audience: string | null = null;
    if (row.audience !== undefined) {
      const value = dict(row.audience).value;
      if (!atom(value, 64)) return unknown("offers_invalid");
      audience = value;
    }
    if ((row.offerType !== "B2C" && row.offerType !== "B2B") ||
        // Decimal is a string in the Amazon model. Preserve it exactly, with
        // bounded RFC JSON decimal syntax and no floating point conversion.
        typeof price.amount !== "string" || price.amount.length > 80 || !DECIMAL_RE.test(price.amount) ||
        typeof price.currencyCode !== "string" || !/^[A-Z]{3}$/.test(price.currencyCode))
      return unknown("offers_invalid");
    offers.push({
      marketplace_id: marketplaceId, offer_type: row.offerType, audience,
      amount: price.amount, currency_code: price.currencyCode
    });
  }
  const candidates = offers.filter(offer => offer.offer_type === "B2C" && offer.audience === "ALL");
  if (candidates.length === 0) return unknown("b2c_all_offer_missing", offers);
  if (candidates.length !== 1) return unknown("b2c_all_offer_ambiguous", offers);
  const candidate = candidates[0];
  // All four supported stores use EUR. Retain other observed currencies in
  // the projection, but do not treat them as a verified pilot price.
  if (candidate.currency_code !== "EUR") return unknown("b2c_all_currency_mismatch", offers);
  return {
    price_state: "VERIFIED", price_reason: "b2c_all_price_observed",
    current_b2c_price: { amount: candidate.amount, currency_code: candidate.currency_code },
    current_offers: offers
  };
}
function classify(sku: string, marketplaceId: string, status: number,
  body: Row | null, reqId: string | null, jsonValid: boolean, observedAt: string): AmazonSellerListingEntry {
  if (status === 404) {
    const errors = body?.errors;
    if (jsonValid && reqId && Array.isArray(errors) && errors.length === 1 &&
        (dict(errors[0]).code === "NOT_FOUND" || dict(errors[0]).code === "NotFound"))
      return { sku, state: "VERIFIED_ABSENT", reason: "listings_item_404_with_verified_not_found", request_id: reqId,
        ...unknownObservation(observedAt, "listing_verified_absent") };
    return unknownEntry(sku, "ambiguous_404_not_absence_proof", reqId, observedAt);
  }
  if (status !== 200)
    return unknownEntry(sku, HTTP_CODES.has(status) ? "amazon_http_" + status : "amazon_http_unexpected_status", reqId, observedAt);
  if (!jsonValid || body?.sku !== sku)
    return unknownEntry(sku, "listing_response_sku_or_json_mismatch", reqId, observedAt);
  const summaries = Array.isArray(body.summaries) ? body.summaries : [];
  const relevant = summaries.map(dict).filter(summary => summary.marketplaceId === marketplaceId);
  if (relevant.length > 1)
    return unknownEntry(sku, "listing_has_multiple_market_summaries", reqId, observedAt);
  const summary = relevant[0] ?? null;
  const identityVerified = summary !== null && typeof summary.asin === "string" && ASIN_RE.test(summary.asin);
  const prices = Array.isArray(body.offers) ? body.offers.map(dict).filter(offer => offer.marketplaceId === marketplaceId) : [];
  const issueData = safeIssues(body.issues, marketplaceId);
  const observation = unknownObservation(observedAt, summary ? "listing_asin_invalid" : "listing_market_summary_missing");
  if (identityVerified) {
    observation.identity_state = "VERIFIED";
    observation.identity_reason = "seller_sku_market_asin_verified";
    Object.assign(observation, fulfillment(body.fulfillmentAvailability), currentOffers(body.offers, marketplaceId));
    observation.observation_complete = observation.fulfillment_state === "VERIFIED" && observation.price_state === "VERIFIED";
  }
  return {
    sku, state: summary ? "PRESENT" : "PRESENT_ATTRIBUTES_UNKNOWN",
    reason: summary ? "seller_listing_found" : "listing_exists_but_requested_market_summary_not_returned",
    request_id: reqId,
    asin: identityVerified ? summary!.asin as string : null,
    product_type: identityVerified && atom(summary!.productType, 80) ? summary!.productType as string : null,
    statuses: identityVerified && Array.isArray(summary!.status)
      ? summary!.status.filter(status => atom(status, 89)).slice(0, 16) as string[] : [],
    reported_offer_count: prices.length,
    listing_issues_count: issueData.count, issue_signals: issueData.issues, issue_signals_truncated: issueData.truncated,
    ...observation
  };
}
async function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ReadFailure("amazon_transport_timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    fail("amazon_response_too_large");
  }
  if (!response.body) fail("amazon_response_invalid_json");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, text = "";
  try {
    while (true) {
      if (signal.aborted) fail("amazon_transport_timeout");
      const chunk = await withinDeadline(reader.read(), signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail("amazon_response_read_failed");
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail("amazon_response_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ReadFailure) throw error;
    if (signal.aborted) fail("amazon_transport_timeout");
    fail("amazon_response_read_failed");
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); } catch { fail("amazon_response_invalid_json"); }
}

export async function readAmazonSellerListingsDirect(
  rawInput: unknown, env: Env, dependencies: AmazonSellerListingsDirectDependencies = {}
): Promise<Row> {
  const input = validateInput(rawInput);
  try {
    const clock = dependencies.clock ?? Date.now;
    const startedAt = now(clock);
    const market = input.marketplace, skus = input.skus;
    const sellerId = env.AMAZON_SP_API_SELLER_ID;
    if (typeof sellerId !== "string" || !SELLER_RE.test(sellerId))
      return { ok: false, status: "BLOCKED_SELLER_CONFIG", marketplace: market,
        observed_at: startedAt, observation_complete: false, results: [], seller_id_configured: false,
        blocker: "AMAZON_SP_API_SELLER_ID_missing_or_invalid", ...FLAGS };
    const marketplaceId = AMAZON_EU_MARKETPLACES[market];
    let token: string;
    try { token = await (dependencies.getAccessToken ?? getAmazonAccessToken)(env); }
    catch { fail("amazon_seller_listings_direct_authentication_failed"); }
    if (typeof token !== "string" || !token.trim() || token.length > 16_384 || /[\u0000-\u0020\u007f]/.test(token))
      fail("amazon_seller_listings_direct_authentication_failed");
    const results: AmazonSellerListingEntry[] = [];
    for (const sku of skus) {
      const url = new URL(HOST + "/listings/2021-08-01/items/" +
        encodeURIComponent(sellerId) + "/" + encodeURIComponent(sku));
      // FulfillmentAvailability has no marketplaceId. Request exactly one
      // marketplace and correlate only after matching its unique summary.
      url.searchParams.set("marketplaceIds", marketplaceId);
      url.searchParams.set("includedData", "summaries,offers,issues,fulfillmentAvailability");
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      let response: Response;
      try {
        response = await withinDeadline((dependencies.fetch ?? fetch)(url.toString(), {
          method: "GET", headers: { "x-amz-access-token": token, Accept: "application/json" },
          signal, redirect: "manual"
        }), signal);
      } catch (error) {
        const kind = error instanceof Error ? error.name : "Unknown";
        const reason = signal.aborted || error instanceof ReadFailure || kind === "TimeoutError" || kind === "AbortError"
          ? "amazon_transport_timeout" : kind === "TypeError" ? "amazon_transport_type_error" : "amazon_transport_other";
        results.push(unknownEntry(sku, reason, null, now(clock)));
        continue;
      }
      const reqId = requestId(response);
      // A typed, bounded 404 is the sole error body needed by the legacy
      // verified-absence contract. All other errors and redirects stay unread.
      if (response.status !== 200 && response.status !== 404) {
        void response.body?.cancel().catch(() => {});
        results.push(classify(sku, marketplaceId, response.status, null, reqId, false, now(clock)));
        continue;
      }
      let body: Row | null = null, jsonValid = false;
      if (/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
        try {
          const parsed = await boundedJson(response, signal);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            body = dict(parsed); jsonValid = true;
          }
        } catch (error) {
          results.push(unknownEntry(sku, error instanceof ReadFailure ? error.code : "amazon_response_read_failed", reqId, now(clock)));
          continue;
        }
      } else { void response.body?.cancel().catch(() => {}); }
      results.push(classify(sku, marketplaceId, response.status, body, reqId, jsonValid, now(clock)));
    }
    const present = results.filter(entry => entry.state === "PRESENT" || entry.state === "PRESENT_ATTRIBUTES_UNKNOWN").length;
    const absent = results.filter(entry => entry.state === "VERIFIED_ABSENT").length;
    const unknown = results.length - present - absent;
    return {
      ok: true, source: "amazon_sp_api_get_listings_item",
      marketplace: market, marketplace_id: marketplaceId,
      observed_at: now(clock), observation_complete: results.every(entry => entry.observation_complete),
      report_download_dependency: false, requested_skus: skus.length, present, verified_absent: absent, unknown,
      // Retained presence/absence semantics; never use this legacy flag as
      // proof that price, identity or live quantity has been verified.
      complete_evidence: unknown === 0,
      results, ...FLAGS
    };
  } catch (error) {
    if (error instanceof ReadFailure) throw new Error(error.code);
    throw new Error("amazon_seller_listings_direct_failed");
  }
}
