import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonOfferOnlyPreflight } from "./mare-business-amazon-offer-preflight.js";

/** Provider validation only. This module has no listing publication, inventory
 * update, feed, log, cache or journal path. A VALID response can contain issues
 * and is never a sellability proof, publication permit or Channable handoff. */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
export type AmazonOfferPreviewInput = Readonly<{
  marketplace: Market;
  sku: string;
  ean: string;
  asin: string;
}>;
export type AmazonOfferPreviewEnv = AmazonCredentials & {
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_PREVIEW_ENABLED?: string;
  [key: string]: unknown;
};
export type AmazonOfferPreviewDependencies = {
  preflightReader?: typeof readAmazonOfferOnlyPreflight;
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
};
export type AmazonOfferPreviewIssue = {
  code: string;
  severity: "ERROR" | "WARNING" | "INFO";
  attribute_names: string[];
};
export type AmazonOfferPreviewResult = Row & {
  ok: boolean;
  status: "BLOCKED_PREVIEW" | "PREVIEW_REVIEW_REQUIRED";
  preview_only: true;
  offer_created: false;
  listing_write_enabled: false;
  can_publish: false;
  provider_mutations: 0;
  provider_validation_performed: boolean;
  full_schema_validated: false;
  gpsr_compliance_proven: false;
};

const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const CHECKSUM_RE = /^[A-Za-z0-9+/]{20,28}={0,2}$/;
const SCHEMA_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}={0,2}$/;
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/;
const ISSUE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,89}$/;
const ATTRIBUTE_RE = /^[a-z][a-z0-9_]{0,119}$/;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ISSUES = 100;
const MAX_ATTRIBUTES_PER_ISSUE = 20;
const TIMEOUT_MS = 20_000;
const HTTP_FAILURE_STATUSES = new Set([400, 401, 403, 404, 413, 415, 429, 500, 502, 503, 504]);
const REVIEW_REQUIRED = [
  "seller_identity_and_listing_known_positive_control",
  "seller_asin_independent_absence_and_channable_writer_proof",
  "catalog_color_size_model_and_child_asin",
  "offer_attributes_gpsr_product_type_schema",
  "live_order_stock_budget",
  "channable_writer_ownership"
] as const;
const PREFLIGHT_BLOCKERS: Readonly<Record<string, readonly string[]>> = {
  BLOCKED_CONFIG: ["amazon_seller_id_not_configured"],
  BLOCKED_SHOPIFY_IDENTITY: ["sku_missing_or_duplicated", "ean_missing_or_duplicated"],
  BLOCKED_SHOPIFY_ELIGIBILITY: ["status_stock_price_inventory_or_ean_invalid"],
  BLOCKED_CATALOG_MATCH: ["ean_not_univocally_matched_to_asin"],
  BLOCKED_CATALOG_ATTRIBUTES: ["brand_asin_or_product_type_mismatch",
    "amazon_product_type_incompatible_with_shopify_category", "parent_asin_not_sellable_variant",
    "variant_attributes_mismatch"],
  BLOCKED_EXISTING_OFFER: ["seller_sku_already_exists", "seller_has_asin_under_other_sku"],
  BLOCKED_LISTING_STATUS_UNKNOWN: ["seller_sku_absence_not_verified",
    "seller_asin_search_incomplete_or_unverified", "seller_asin_absence_not_supported_by_search"],
  BLOCKED_RESTRICTIONS_UNKNOWN: ["amazon_restrictions_unverified"],
  BLOCKED_LISTING_RESTRICTIONS: ["amazon_restrictions_present"],
  BLOCKED_PRODUCT_TYPE: ["offer_only_definition_unverified"]
};
const PREFLIGHT_ERRORS = new Set([
  "amazon_credentials_missing", "amazon_access_token_missing",
  "amazon_offer_preflight_invalid_request", "amazon_offer_preflight_shopify_variants_missing",
  "amazon_offer_preflight_shopify_incomplete", "amazon_offer_preflight_invalid_json",
  "amazon_offer_preflight_transport_timeout", "amazon_offer_preflight_transport_type_error",
  "amazon_offer_preflight_transport_other",
  ...[400, 401, 403, 404, 413, 415, 429, 500, 502, 503, 504]
    .flatMap(status => ["amazon_offer_preflight_http_" + status, "amazon_lwa_failed_" + status])
]);
const FLAGS = {
  preview_only: true,
  offer_created: false,
  listing_write_enabled: false,
  can_publish: false,
  provider_mutations: 0,
  full_schema_validated: false,
  gpsr_compliance_proven: false,
  channable_handoff_performed: false
} as const;

class PreviewFailure extends Error {
  constructor(code: string) { super("amazon_offer_preview_" + code); }
}
function fail(code: string): never { throw new PreviewFailure(code); }
function dict(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function validEAN(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === Number(value[12]);
}

/** Also used by MCP before persisting a plan. Reject hidden fields, symbols,
 * getters and coercion; return an immutable copy before any asynchronous read. */
export function validateAmazonOfferPreviewRequest(input: unknown): AmazonOfferPreviewInput {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) fail("invalid_input");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) fail("invalid_input");
    const keys = Reflect.ownKeys(input);
    const names = ["marketplace", "sku", "ean", "asin"];
    if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key)))
      fail("invalid_input");
    const values: Row = {};
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string")
        fail("invalid_input");
      values[key] = descriptor.value;
    }
    const { marketplace, sku, ean, asin } = values as Record<string, string>;
    if (!Object.hasOwn(AMAZON_EU_MARKETPLACES, marketplace) ||
        !SKU_RE.test(sku) || sku !== sku.trim() || !validEAN(ean) || !ASIN_RE.test(asin))
      fail("invalid_input");
    return Object.freeze({ marketplace: marketplace as Market, sku, ean, asin });
  } catch {
    throw new Error("amazon_offer_preview_invalid_input");
  }
}

function block(reason: string, diagnostics: Row = {}): AmazonOfferPreviewResult {
  return { ok: false, status: "BLOCKED_PREVIEW", reason, ...diagnostics,
    provider_validation_performed: false, ...FLAGS };
}
function verifiedPreflight(pre: Row, input: AmazonOfferPreviewInput): boolean {
  return pre.ok === true && pre.status === "REVIEW_REQUIRED" &&
    pre.marketplace === input.marketplace && pre.sku === input.sku &&
    pre.asin === input.asin && pre.ean === input.ean && pre.exact_ean_asin === true &&
    pre.seller_listing_absence_result === "NOT_FOUND_VERIFIED_BY_LISTINGS_API" &&
    pre.seller_asin_search_result === "NO_SELLER_ASIN_IN_BOUNDED_SEARCH" &&
    pre.seller_asin_search_is_not_final_absence_proof === true &&
    typeof pre.listing_request_id === "string" && REFERENCE_RE.test(pre.listing_request_id) &&
    pre.restriction_count === 0 && pre.schema_product_type === "PRODUCT" &&
    pre.schema_requirements === "LISTING_OFFER_ONLY" &&
    typeof pre.schema_version === "string" && SCHEMA_VERSION_RE.test(pre.schema_version) &&
    typeof pre.schema_checksum === "string" && CHECKSUM_RE.test(pre.schema_checksum) &&
    pre.shopify_currency === "EUR" && typeof pre.shopify_price_minor === "number" &&
    Number.isSafeInteger(pre.shopify_price_minor) && pre.shopify_price_minor >= 1 &&
    pre.shopify_price_minor <= 100_000_000 &&
    typeof pre.shopify_stock_observed === "number" && Number.isSafeInteger(pre.shopify_stock_observed) &&
    (pre.shopify_stock_observed > 0 ||
     (pre.shopify_stock_observed === 0 && input.sku.startsWith("RFR_") &&
      pre.amazon_brand_expected === "Refrigiwear")) &&
    typeof pre.product_variant_id === "string" &&
    /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(pre.product_variant_id) &&
    pre.read_only === true && pre.has_created_offer === false && pre.live_listing_write_enabled === false &&
    Array.isArray(pre.review_required) && pre.review_required.length === REVIEW_REQUIRED.length &&
    REVIEW_REQUIRED.every(value => (pre.review_required as unknown[]).includes(value));
}
function preflightDiagnostics(pre: Row, input: AmazonOfferPreviewInput): Row {
  if (pre.ok !== false || pre.marketplace !== input.marketplace || pre.sku !== input.sku ||
      pre.asin !== input.asin || pre.read_only !== true || pre.has_created_offer !== false ||
      pre.live_listing_write_enabled !== false || typeof pre.status !== "string" ||
      !Object.hasOwn(PREFLIGHT_BLOCKERS, pre.status) || typeof pre.blocker !== "string" ||
      !PREFLIGHT_BLOCKERS[pre.status].includes(pre.blocker)) return {};
  return { preflight_status: pre.status, preflight_blocker: pre.blocker };
}
function observedAt(clock: () => number): string {
  const time = clock();
  if (!Number.isSafeInteger(time) || time < 0 || !Number.isFinite(new Date(time).getTime())) fail("invalid_clock");
  return new Date(time).toISOString();
}

async function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new PreviewFailure("transport_timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

/** The same deadline covers headers and every body chunk. Content-Length is
 * only an early check; the byte limit applies even when the header is absent. */
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    fail("response_too_large");
  }
  if (!response.body) fail("invalid_json");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, text = "";
  try {
    while (true) {
      if (signal.aborted) fail("transport_timeout");
      const chunk = await withinDeadline(reader.read(), signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) fail("response_read_failed");
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail("response_too_large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof PreviewFailure) throw error;
    if (signal.aborted) fail("transport_timeout");
    fail("response_read_failed");
  } finally { reader.releaseLock(); }
  try { return JSON.parse(text); }
  catch { fail("invalid_json"); }
}

function issuesFrom(data: Row): AmazonOfferPreviewIssue[] {
  if (data.issues === undefined) return [];
  if (!Array.isArray(data.issues) || data.issues.length > MAX_ISSUES) fail("unexpected_issues");
  return data.issues.map(value => {
    const issue = dict(value);
    if (typeof issue.code !== "string" || !ISSUE_CODE_RE.test(issue.code) ||
        (issue.severity !== "ERROR" && issue.severity !== "WARNING" && issue.severity !== "INFO"))
      fail("unexpected_issues");
    const attributes = issue.attributeNames;
    if (attributes !== undefined && (!Array.isArray(attributes) || attributes.length > MAX_ATTRIBUTES_PER_ISSUE ||
        attributes.some(attribute => typeof attribute !== "string" || !ATTRIBUTE_RE.test(attribute))))
      fail("unexpected_issues");
    // Provider message, categories, URLs, identifiers and extra fields are not
    // returned. A missing attributeNames does not erase the issue or severity.
    return { code: issue.code, severity: issue.severity,
      attribute_names: attributes === undefined ? [] : [...new Set(attributes as string[])] };
  });
}

/** The third function argument remains compatible with the original prototype.
 * Dependencies are internal test/server hooks, never accepted in a request. */
export async function previewAmazonOfferOnlyZeroQuantity(
  rawInput: unknown, env: AmazonOfferPreviewEnv,
  preflightOrDependencies: typeof readAmazonOfferOnlyPreflight | AmazonOfferPreviewDependencies = {}
): Promise<AmazonOfferPreviewResult> {
  const input = validateAmazonOfferPreviewRequest(rawInput);
  try {
    if (env.AMAZON_OFFER_PREVIEW_ENABLED !== "true") return block("amazon_validation_preview_disabled");
    const sellerId = env.AMAZON_SP_API_SELLER_ID;
    if (typeof sellerId !== "string" || !SELLER_RE.test(sellerId)) return block("amazon_seller_id_missing");
    const dependencies = typeof preflightOrDependencies === "function"
      ? { preflightReader: preflightOrDependencies } : preflightOrDependencies;
    const clock = dependencies.clock ?? Date.now;
    observedAt(clock); // Invalid observation context must fail before reads.
    let pre: Row;
    try { pre = dict(await (dependencies.preflightReader ?? readAmazonOfferOnlyPreflight)(input, env)); }
    catch (error) {
      const code = error instanceof Error && PREFLIGHT_ERRORS.has(error.message)
        ? error.message : "preflight_read_failed";
      return block("preflight_read_failed", { preflight_error_code: code });
    }
    if (!verifiedPreflight(pre, input))
      return block("preflight_or_schema_evidence_unverified", preflightDiagnostics(pre, input));

    const { marketplace, sku, ean, asin } = input;
    const marketId = AMAZON_EU_MARKETPLACES[marketplace];
    const body = { productType: "PRODUCT", requirements: "LISTING_OFFER_ONLY", attributes: {
      merchant_suggested_asin: [{ value: asin, marketplace_id: marketId }],
      condition_type: [{ value: "new_new", marketplace_id: marketId }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 0, marketplace_id: marketId }],
      purchasable_offer: [{ currency: "EUR", our_price: [{ schedule: [{
        value_with_tax: (pre.shopify_price_minor as number) / 100
      }] }], marketplace_id: marketId }]
    } };
    // No caller-supplied endpoint, payload, price, inventory, mode or headers.
    const url = new URL(HOST + "/listings/2021-08-01/items/" +
      encodeURIComponent(sellerId) + "/" + encodeURIComponent(sku));
    url.searchParams.set("marketplaceIds", marketId);
    url.searchParams.set("mode", "VALIDATION_PREVIEW");
    let token: string;
    try { token = await (dependencies.getAccessToken ?? getAmazonAccessToken)(env); }
    catch { fail("authentication_failed"); }
    if (typeof token !== "string" || !token.trim() || token.length > 16_384 || /[\u0000-\u0020\u007f]/.test(token))
      fail("authentication_failed");
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
      response = await withinDeadline((dependencies.fetch ?? fetch)(url.toString(), {
        method: "PUT",
        headers: { "x-amz-access-token": token, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body), signal, redirect: "manual"
      }), signal);
    } catch (error) {
      if (signal.aborted || error instanceof PreviewFailure) fail("transport_timeout");
      fail("network_error");
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      fail(HTTP_FAILURE_STATUSES.has(response.status) ? "http_" + response.status : "unexpected_http_status");
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => {});
      fail("unexpected_content_type");
    }
    const data = dict(await boundedJson(response, signal));
    if (data.sku !== sku || (data.status !== "VALID" && data.status !== "INVALID") ||
        typeof data.submissionId !== "string" || !REFERENCE_RE.test(data.submissionId))
      fail("unexpected_response");
    const issues = issuesFrom(data);
    return {
      ok: true, marketplace, sku, ean, asin, status: "PREVIEW_REVIEW_REQUIRED",
      observed_at: observedAt(clock), amazon_preview_status: data.status,
      preview_issues: issues, issue_count: issues.length, issues_returned: data.issues !== undefined,
      validation_mode: "VALIDATION_PREVIEW", offer_quantity_submitted: 0,
      schema_product_type: "PRODUCT", schema_version: pre.schema_version,
      submission_reference: data.submissionId, provider_validation_performed: true,
      ...FLAGS,
      next_step: "REVIEW_SCHEMA_ISSUES_ATTRIBUTES_GPSR_AND_PROVE_CHANNABLE_ORDER_AND_STOCK_CUTOVER"
    };
  } catch (error) {
    // Never forward a resolver, provider, stream or injected dependency message.
    if (error instanceof PreviewFailure) throw new Error(error.message);
    throw new Error("amazon_offer_preview_failed");
  }
}
