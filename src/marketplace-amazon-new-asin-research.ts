import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Merchant-private, zero-mutation first stage of the NEW-ASIN pipeline.
 *
 * There is deliberately NO Listings Items PUT, feed POST, inventory update,
 * product creation or user-supplied URL. PTD discovery is not publication
 * eligibility, approved brand ownership, GTIN exemption or GPSR proof.
 */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Input = Readonly<{ marketplace: Market; sku: string; product_type?: string }>;
type Env = AmazonCredentials & MareBusinessShopifyEnv & { AMAZON_SP_API_SELLER_ID?: string };
export type AmazonNewAsinResearchDependencies = {
  readShopify?: typeof readShopifyCatalogComplete;
  readListing?: typeof readAmazonSellerListingsDirect;
  readCatalogMatch?: typeof readAmazonExactMatchCandidates;
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
};

const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const TYPE_RE = /^[A-Z][A-Z0-9_]{1,79}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const EAN_RE = /^\d{13}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,119}$/;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_PRODUCT_TYPES = 100;
const MAX_OUTPUT_TYPES = 15;
const MAX_ATTRIBUTES = 250;
const TIMEOUT_MS = 20_000;
const FLAGS = Object.freeze({
  read_only: true, provider_mutations: 0,
  has_created_listing: false, can_publish: false,
  can_transfer_writer_ownership: false,
  product_creation_writer_implemented: false,
  full_schema_validated: false,
  brand_authorization_proven: false, gpsr_compliance_proven: false,
  gtin_exemption_proven: false,
});

function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function now(clock: () => number): string {
  const t = clock();
  if (!Number.isSafeInteger(t) || t < 0 || !Number.isFinite(new Date(t).getTime()))
    throw new Error("amazon_new_asin_invalid_clock");
  return new Date(t).toISOString();
}
function validEAN(s: string): boolean {
  if (!EAN_RE.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === Number(s[12]);
}
function validate(raw: unknown): Input {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("amazon_new_asin_invalid_request");
  const values = raw as Row;
  if (Object.keys(values).length < 2 || Object.keys(values).length > 3 ||
      Object.keys(values).some(k => !["marketplace", "sku", "product_type"].includes(k)) ||
      typeof values.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, values.marketplace) ||
      typeof values.sku !== "string" || !SKU_RE.test(values.sku) || values.sku !== values.sku.trim() ||
      (values.product_type !== undefined && (typeof values.product_type !== "string" || !TYPE_RE.test(values.product_type))))
    throw new Error("amazon_new_asin_invalid_request");
  return Object.freeze({
    marketplace: values.marketplace as Market, sku: values.sku,
    ...(typeof values.product_type === "string" ? { product_type: values.product_type } : {}),
  });
}
function blocked(input: Input, at: string, status: string, reason: string, extra: Row = {}): Row {
  return { ok: false, marketplace: input.marketplace, sku: input.sku, observed_at: at,
    status, blocker: reason, ...extra, ...FLAGS };
}
function entries(catalogRaw: unknown, sku: string): {product: Row; variant: Row} | null {
  const catalog = obj(catalogRaw);
  if (catalog.ok !== true || catalog.truncated !== false ||
      catalog.complete_variant_pagination !== true ||
      !Array.isArray(catalog.products) ||
      !Number.isSafeInteger(catalog.product_count) ||
      catalog.product_count !== catalog.products.length ||
      catalog.inline_product_count !== catalog.product_count ||
      catalog.product_count > 50) return null;
  const matches: Array<{product: Row; variant: Row}> = [];
  for (const rawProduct of catalog.products) {
    const product = obj(rawProduct);
    if (!Array.isArray(product.variants)) return null;
    for (const rawVariant of product.variants) {
      const variant = obj(rawVariant);
      if (variant.sku === sku) matches.push({product, variant});
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function eanUniqueInShopify(catalogRaw: unknown, ean: string, expectedVariantId: unknown): boolean {
  const catalog = obj(catalogRaw);
  if (catalog.ok !== true || catalog.truncated !== false ||
      catalog.complete_variant_pagination !== true ||
      !Array.isArray(catalog.products) ||
      !Number.isSafeInteger(catalog.product_count) ||
      catalog.product_count !== catalog.products.length ||
      catalog.inline_product_count !== catalog.product_count ||
      catalog.product_count > 50 ||
      typeof expectedVariantId !== "string" ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(expectedVariantId)) return false;
  let matches = 0;
  for (const rawProduct of catalog.products) {
    const product = obj(rawProduct);
    if (!Array.isArray(product.variants)) return false;
    for (const rawVariant of product.variants) {
      const variant = obj(rawVariant);
      if (variant.barcode !== ean) continue;
      matches++;
      if (variant.id !== expectedVariantId) return false;
    }
  }
  return matches === 1;
}

async function readJson(url: string, token: string | null, fetcher: typeof fetch, schemaDocument = false): Promise<Row> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET", headers: token
        ? { "x-amz-access-token": token, Accept: "application/json" }
        : { Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new Error("provider_transport_unverified"); }
  if (response.status !== 200) throw new Error("provider_http_" + response.status);
  const mime = (response.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  const accepted = mime === "application/json" ||
    (schemaDocument && (mime === "application/octet-stream" || mime === "text/plain" || mime === ""));
  // Amazon PTD returns a short-lived signed S3 schema document. S3 object
  // metadata may label the JSON bytes as octet-stream or text/plain.
  // This relaxed MIME policy applies ONLY to the URL from the verified PTD
  // response and after strict Amazon-host allowlisting, bounded streaming and
  // JSON parsing. Authenticated SP-API calls still require application/json.
  if (!accepted) throw new Error("provider_content_type_unverified");
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES)
    throw new Error("provider_payload_too_large");
  if (!response.body) throw new Error("provider_body_missing");
  let bytes = 0;
  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("provider_payload_too_large");
      parts.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) { raw.set(part, offset); offset += part.length; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("provider_invalid_json");
    return parsed as Row;
  } catch { throw new Error("provider_invalid_json"); }
}
function approvedSchemaUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !(/(^|\.)amazonaws\.com$/.test(url.hostname) ||
        /(^|\.)amazon\.com$/.test(url.hostname))) return null;
  return url.toString();
}
function safeName(value: unknown): string | null {
  return typeof value === "string" && FIELD_RE.test(value) ? value : null;
}
function requiredAttributes(schema: Row): {required: string[]; visible: string[]; complex: boolean} | null {
  const rootProperties = obj(schema.properties), attributes = obj(rootProperties.attributes);
  const properties = obj(attributes.properties);
  if (schema.type !== "object" || attributes.type !== "object" ||
      !Array.isArray(attributes.required)) return null;
  const required = attributes.required;
  if (required.length > MAX_ATTRIBUTES || Object.keys(properties).length > MAX_ATTRIBUTES ||
      !required.every(x => safeName(x) !== null)) return null;
  const visible = Object.keys(properties).filter(name => safeName(name) !== null);
  const structure = JSON.stringify(schema);
  return {
    required: [...new Set(required as string[])].sort(),
    visible: visible.sort(),
    // Conditional requirements and references must be resolved by full JSON Schema
    // validation before any real listing creation.
    complex: /"(?:allOf|anyOf|oneOf|if|then|else|\$ref|dependentSchemas)"/.test(structure),
  };
}

/** One request, one marketplace, one SKU, optional explicitly selected PTD product type.
 * No request URL, image URL, compliance assertion or product attribute injection. */
export async function researchAmazonNewAsinProductType(
  rawInput: unknown, env: Env, dependencies: AmazonNewAsinResearchDependencies = {},
): Promise<Row> {
  const input = validate(rawInput);
  const at = now(dependencies.clock ?? Date.now);
  if (!SELLER_RE.test(env.AMAZON_SP_API_SELLER_ID || ""))
    return blocked(input, at, "BLOCKED_CONFIG", "seller_identity_not_configured");

  let selected: {product: Row; variant: Row} | null;
  try {
    const catalog = await (dependencies.readShopify ?? readShopifyCatalogComplete)({
      query: 'sku:"' + input.sku + '" status:active,draft,archived,unlisted',
      max_products: 50, inline_limit: 50, include_csv: false,
      stable_order: true, persist_artifacts: false,
    }, env);
    selected = entries(catalog, input.sku);
  } catch { return blocked(input, at, "BLOCKED_SHOPIFY", "shopify_source_unverified"); }
  if (!selected) return blocked(input, at, "BLOCKED_SHOPIFY", "sku_missing_duplicated_or_incomplete");
  const {product, variant} = selected;
  const brand = typeof product.vendor === "string" ? product.vendor : "";
  const title = typeof product.title === "string" ? product.title : "";
  const code = typeof variant.barcode === "string" ? variant.barcode : "";
  const quantity = variant.inventory_quantity;
  if (product.status !== "ACTIVE" || brand.toLowerCase() === "p448" ||
      !title || title.length > 200 || !brand || brand.length > 100 ||
      !validEAN(code) || !Number.isSafeInteger(quantity) || (quantity as number) <= 0 ||
      variant.inventory_tracked !== true || variant.inventory_levels_complete !== true)
    return blocked(input, at, "BLOCKED_SHOPIFY", "active_gtin_stock_or_inventory_unverified");
  const source = {
    product_title: title, brand, shopify_product_type: product.product_type || null,
    ean: code, shopify_available: quantity, has_media: (product.media_count as number) > 0,
    variant_id: variant.id, shopify_price: variant.price ?? null,
  };
  try {
    const barcodeCatalog = await (dependencies.readShopify ?? readShopifyCatalogComplete)({
      query: 'barcode:"' + code + '" status:active,draft,archived,unlisted',
      max_products: 50, inline_limit: 50, include_csv: false,
      stable_order: true, persist_artifacts: false,
    }, env);
    if (!eanUniqueInShopify(barcodeCatalog, code, variant.id))
      return blocked(input, at, "BLOCKED_SHOPIFY", "ean_missing_or_duplicated_in_shopify", {shopify: source});
  } catch {
    return blocked(input, at, "BLOCKED_SHOPIFY", "ean_identity_read_unverified", {shopify: source});
  }
  let listing: Row;
  try {
    const result = obj(await (dependencies.readListing ?? readAmazonSellerListingsDirect)({
      marketplace: input.marketplace, skus: [input.sku],
    }, env));
    if (result.ok !== true || result.marketplace !== input.marketplace ||
        result.provider_mutations !== 0 || result.can_change_stock !== false ||
        !Array.isArray(result.results)) throw new Error("invalid_listing_observation");
    const matches = result.results.map(obj).filter(row => row.sku === input.sku);
    if (matches.length !== 1) throw new Error("ambiguous_listing_observation");
    listing = matches[0];
  } catch { return blocked(input, at, "BLOCKED_AMAZON", "seller_listing_unverified", { shopify: source }); }
  if (listing.state !== "VERIFIED_ABSENT")
    return blocked(input, at, "BLOCKED_AMAZON", "seller_listing_not_proven_absent", {
      shopify: source, seller_listing_state: listing.state,
    });

  let matched: Row;
  try {
    matched = obj(await (dependencies.readCatalogMatch ?? readAmazonExactMatchCandidates)({
      marketplace: input.marketplace, identifier_type: "EAN", identifiers: [code],
    }, env));
  } catch { return blocked(input, at, "BLOCKED_AMAZON", "ean_catalog_lookup_unverified", {shopify: source}); }
  const results = obj(matched.result);
  const identities = Array.isArray(results.identifiers) ? results.identifiers.map(obj) : [];
  if (matched.ok !== true || results.complete !== true ||
      results.marketplace !== input.marketplace || identities.length !== 1 || identities[0].ean !== code)
    return blocked(input, at, "BLOCKED_AMAZON", "ean_catalog_lookup_incomplete", {shopify: source});
  const identity = identities[0];
  if (identity.state !== "NO_EXACT_MATCH" || identity.exact_match_count !== 0 ||
      !Array.isArray(identity.asins) || identity.asins.length !== 0)
    return blocked(input, at, "BLOCKED_MATCHING", "existing_or_ambiguous_catalog_candidate", {
      shopify: source, ean_match_state: identity.state,
    });
  const base = {
    marketplace: input.marketplace, sku: input.sku, observed_at: at,
    shopify: source, seller_listing_state: "VERIFIED_ABSENT",
    ean_match_state: "NO_EXACT_MATCH", ean_absence_not_catalog_absence_proof: true,
    ...FLAGS,
  };

  let token: string;
  try { token = await (dependencies.getAccessToken ?? getAmazonAccessToken)(env); }
  catch { return {ok: false, status: "BLOCKED_AUTH", blocker: "amazon_token_unverified", ...base}; }
  const fetcher = dependencies.fetch ?? fetch;
  const marketId = AMAZON_EU_MARKETPLACES[input.marketplace];
  const searchUrl = new URL(HOST + "/definitions/2020-09-01/productTypes");
  searchUrl.searchParams.set("marketplaceIds", marketId);
  searchUrl.searchParams.set("itemName", title);
  let found: Row;
  try { found = await readJson(searchUrl.toString(), token, fetcher); }
  catch { return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_search_unverified", ...base}; }
  if (!Array.isArray(found.productTypes) || found.productTypes.length > MAX_PRODUCT_TYPES)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_search_invalid", ...base};
  const candidates: Array<{name:string; display_name: string}> = [];
  for (const raw of found.productTypes) {
    const candidate = obj(raw), name = candidate.name;
    if (typeof name !== "string" || !TYPE_RE.test(name) ||
        !Array.isArray(candidate.marketplaceIds) || !candidate.marketplaceIds.includes(marketId))
      continue;
    candidates.push({name, display_name:
      typeof candidate.displayName === "string" ? candidate.displayName.slice(0,120) : name});
  }
  const unique = [...new Map(candidates.map(c => [c.name, c])).values()];
  if (!input.product_type) return {
    ok: true, status: "PRODUCT_TYPE_SELECTION_REQUIRED",
    product_type_candidates: unique.slice(0, MAX_OUTPUT_TYPES),
    candidates_truncated: unique.length > MAX_OUTPUT_TYPES,
    candidate_count: unique.length,
    next_step: "REVIEW_PRODUCT_TYPE_AND_REQUEST_FULL_LISTING_SCHEMA",
    ...base,
  };
  if (!unique.some(c => c.name === input.product_type))
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_not_in_marketplace_recommendations",
      product_type_candidates: unique.slice(0, MAX_OUTPUT_TYPES), ...base};

  const url = new URL(HOST + "/definitions/2020-09-01/productTypes/" + input.product_type);
  url.searchParams.set("marketplaceIds", marketId);
  url.searchParams.set("requirements", "LISTING");
  url.searchParams.set("requirementsEnforced", "ENFORCED");
  url.searchParams.set("productTypeVersion", "LATEST");
  url.searchParams.set("parentageLevel", "NONE");
  url.searchParams.set("sellerId", env.AMAZON_SP_API_SELLER_ID!);
  let definition: Row;
  try { definition = await readJson(url.toString(), token, fetcher); }
  catch { return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_definition_unverified", ...base}; }
  const link = obj(obj(definition.schema).link), version = obj(definition.productTypeVersion);
  const schemaUrl = approvedSchemaUrl(link.resource);
  if (definition.productType !== input.product_type ||
      definition.requirements !== "LISTING" ||
      definition.requirementsEnforced !== "ENFORCED" ||
      !Array.isArray(definition.marketplaceIds) ||
      definition.marketplaceIds.length !== 1 || definition.marketplaceIds[0] !== marketId ||
      link.verb !== "GET" || version.latest !== true ||
      typeof version.version !== "string" || !version.version ||
      typeof obj(definition.schema).checksum !== "string" || !schemaUrl)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_schema_metadata_unverified", ...base};

  let rawSchema: Row;
  try { rawSchema = await readJson(schemaUrl, null, fetcher, true); }
  catch (error) {
    const kind = error instanceof Error && /^provider_(?:transport_unverified|http_[0-9]{3}|content_type_unverified|payload_too_large|body_missing|invalid_json)$/.test(error.message)
      ? error.message : "provider_unknown";
    return {ok: false, status: "BLOCKED_DEFINITIONS",
      blocker: "product_type_schema_unavailable",
      schema_download_diagnostic: kind,
      ...base};
  }
  const fields = requiredAttributes(rawSchema);
  if (!fields)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_schema_structure_unverified", ...base};
  return {
    ok: true, status: "REQUIREMENTS_REVIEW_REQUIRED",
    product_type: input.product_type, parentage_level: "NONE",
    schema_requirements: "LISTING", schema_enforced: true,
    schema_version: version.version, schema_checksum_reported: true,
    schema_checksum_verified: false,
    required_attribute_names: fields.required,
    available_schema_attribute_names: fields.visible,
    conditional_requirements_detected: fields.complex,
    static_requirements_not_full_validation: true,
    supported_shopify_evidence_fields: [
      "item_name", "brand", "externally_assigned_product_identifier",
      "purchasable_offer", "fulfillment_availability",
    ],
    product_payload_constructed: false, validation_preview_sent: false,
    next_step: "MAP_REQUIRED_ATTRIBUTES_AND_VALIDATE_GPSR_BRAND_AND_GTIN_BEFORE_VALIDATION_PREVIEW",
    ...base,
  };
}
