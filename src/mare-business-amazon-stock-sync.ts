import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type StockSyncEnv = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  [key: string]: unknown;
};

export type AmazonStockSyncRequest = Readonly<{
  marketplace: Market;
  sku: string;
  asin: string;
  writer_isolation: "CHANNABLE_DISABLED_FOR_SKU";
}>;

export type AmazonStockSyncPreparedRequest = AmazonStockSyncRequest & Readonly<{
  shopify_variant_id: string;
  shopify_available_quantity: number;
  shopify_committed_quantity: number;
  shopify_on_hand_quantity: number;
  amazon_current_quantity: number;
  amazon_product_type: string;
  prepared_at: string;
}>;

export type AmazonStockMutationReceipt = Readonly<{
  marketplace: Market;
  sku: string;
  asin: string;
  writer_isolation: "CHANNABLE_DISABLED_FOR_SKU";
  shopify_variant_id: string;
  shopify_available_quantity_at_write: number;
  shopify_committed_quantity_at_write: number;
  shopify_on_hand_quantity_at_write: number;
  amazon_product_type: string;
  target_quantity: number;
  previous_quantity: number;
  prepared_at: string;
  provider_status: "ACCEPTED";
  submission_reference: string;
  accepted_at: string;
  provider_issues: Array<{ code: string; severity: string; attribute_names: string[] }>;
  provider_mutations: 1;
}>;

export type AmazonStockSyncDependencies = {
  readShopifyCatalog?: typeof readShopifyCatalogComplete;
  readAmazonListing?: typeof readAmazonSellerListingsDirect;
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onMutationAccepted?: (receipt: AmazonStockMutationReceipt) => Promise<void>;
};

const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const PRODUCT_TYPE_RE = /^[A-Z0-9_]{1,80}$/;
const REFERENCE_RE = /^[A-Za-z0-9_-]{6,180}$/;
const MAX_RESPONSE_BYTES = 1_000_000;
const TIMEOUT_MS = 20_000;
const MAX_TARGET_QUANTITY = 100_000;
const POLL_ATTEMPTS = 5;
const POLL_DELAY_MS = 750;

class StockSyncFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function fail(code: string): never { throw new StockSyncFailure(code); }
function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function now(clock: () => number): string {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) fail("amazon_stock_sync_invalid_clock");
  return new Date(value).toISOString();
}
function validateInput(raw: unknown): AmazonStockSyncRequest {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_request");
    const keys = Object.keys(raw as Row).sort();
    if (keys.join(",") !== "asin,marketplace,sku,writer_isolation") fail("invalid_request");
    const row = raw as Row;
    if (typeof row.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, row.marketplace) ||
        typeof row.sku !== "string" || !SKU_RE.test(row.sku) || row.sku !== row.sku.trim() ||
        typeof row.asin !== "string" || !ASIN_RE.test(row.asin) ||
        row.writer_isolation !== "CHANNABLE_DISABLED_FOR_SKU") fail("invalid_request");
    return Object.freeze({
      marketplace: row.marketplace as Market,
      sku: row.sku,
      asin: row.asin,
      writer_isolation: "CHANNABLE_DISABLED_FOR_SKU",
    });
  } catch {
    throw new Error("amazon_stock_sync_invalid_request");
  }
}

function extractShopifyVariant(catalogRaw: unknown, sku: string): {
  variant_id: string;
  available: number;
  committed: number;
  on_hand: number;
} {
  const catalog = object(catalogRaw);
  if (catalog.ok !== true || catalog.truncated === true || catalog.complete_variant_pagination !== true)
    fail("shopify_catalog_incomplete");
  const products = Array.isArray(catalog.products) ? catalog.products.map(object) : [];
  const matches: Array<{ product: Row; variant: Row }> = [];
  for (const product of products) {
    const variants = Array.isArray(product.variants) ? product.variants.map(object) : [];
    for (const variant of variants) if (variant.sku === sku) matches.push({ product, variant });
  }
  if (matches.length !== 1) fail("shopify_sku_missing_or_duplicated");
  const { product, variant } = matches[0];
  if (product.status !== "ACTIVE" || variant.inventory_tracked !== true || variant.inventory_levels_complete !== true)
    fail("shopify_variant_not_sync_eligible");
  const variantId = typeof variant.id === "string" ? variant.id : "";
  if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(variantId)) fail("shopify_variant_id_invalid");
  const levels = Array.isArray(variant.inventory_levels) ? variant.inventory_levels.map(object) : [];
  if (levels.length < 1 || levels.length > 100) fail("shopify_inventory_levels_invalid");
  let available = 0, committed = 0, onHand = 0;
  for (const level of levels) {
    const quantities = Array.isArray(level.quantities) ? level.quantities.map(object) : [];
    const byName = new Map<string, number>();
    for (const quantity of quantities) {
      if (typeof quantity.name !== "string") continue;
      const value = integer(quantity.quantity);
      if (value === null) fail("shopify_inventory_quantity_invalid");
      byName.set(quantity.name, value);
    }
    const a = byName.get("available"), c = byName.get("committed"), o = byName.get("on_hand");
    if (a === undefined || c === undefined || o === undefined) fail("shopify_inventory_quantity_missing");
    available += a; committed += c; onHand += o;
  }
  const scalar = integer(variant.inventory_quantity);
  if (scalar === null || scalar !== available || available > MAX_TARGET_QUANTITY)
    fail("shopify_inventory_aggregate_mismatch");
  return { variant_id: variantId, available, committed, on_hand: onHand };
}

function extractAmazonState(raw: unknown, request: Pick<AmazonStockSyncRequest, "marketplace" | "sku" | "asin">): {
  quantity: number;
  product_type: string;
} {
  const result = object(raw);
  if (result.ok !== true || result.marketplace !== request.marketplace || result.observation_complete !== true ||
      result.provider_mutations !== 0 || result.can_change_stock !== false) fail("amazon_listing_observation_unverified");
  const rows = Array.isArray(result.results) ? result.results.map(object) : [];
  if (rows.length !== 1) fail("amazon_listing_observation_ambiguous");
  const row = rows[0];
  if (row.sku !== request.sku || row.state !== "PRESENT" || row.identity_state !== "VERIFIED" ||
      row.asin !== request.asin || row.fulfillment_state !== "VERIFIED") fail("amazon_listing_identity_or_quantity_unverified");
  const quantity = integer(row.current_fbm_quantity);
  const productType = typeof row.product_type === "string" ? row.product_type : "";
  if (quantity === null || !PRODUCT_TYPE_RE.test(productType)) fail("amazon_listing_quantity_or_product_type_invalid");
  return { quantity, product_type: productType };
}

async function readFreshState(
  request: AmazonStockSyncRequest,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies,
): Promise<{
  shopify: ReturnType<typeof extractShopifyVariant>;
  amazon: ReturnType<typeof extractAmazonState>;
}> {
  const catalog = await (dependencies.readShopifyCatalog ?? readShopifyCatalogComplete)({
    query: "sku:" + request.sku,
    max_products: 10,
    inline_limit: 10,
    include_csv: false,
  }, env);
  const shopify = extractShopifyVariant(catalog, request.sku);
  const amazonRaw = await (dependencies.readAmazonListing ?? readAmazonSellerListingsDirect)({
    marketplace: request.marketplace,
    skus: [request.sku],
  }, env);
  return { shopify, amazon: extractAmazonState(amazonRaw, request) };
}

export async function prepareAmazonExistingOfferStockSync(
  raw: unknown,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies = {},
): Promise<{ prepared_request: AmazonStockSyncPreparedRequest; summary: Row }> {
  const request = validateInput(raw);
  const clock = dependencies.clock ?? Date.now;
  const state = await readFreshState(request, env, dependencies);
  const prepared: AmazonStockSyncPreparedRequest = Object.freeze({
    ...request,
    shopify_variant_id: state.shopify.variant_id,
    shopify_available_quantity: state.shopify.available,
    shopify_committed_quantity: state.shopify.committed,
    shopify_on_hand_quantity: state.shopify.on_hand,
    amazon_current_quantity: state.amazon.quantity,
    amazon_product_type: state.amazon.product_type,
    prepared_at: now(clock),
  });
  return {
    prepared_request: prepared,
    summary: {
      marketplace: request.marketplace,
      sku: request.sku,
      asin: request.asin,
      target_quantity: state.shopify.available,
      amazon_current_quantity: state.amazon.quantity,
      committed_quantity: state.shopify.committed,
      on_hand_quantity: state.shopify.on_hand,
      delta: state.shopify.available - state.amazon.quantity,
      no_change_required: state.shopify.available === state.amazon.quantity,
      writer_isolation_required: true,
      writer_isolation: request.writer_isolation,
      provider_mutations: 0,
      source_of_truth: "shopify_available_inventory",
      reservations_accounted_by: "shopify_committed_quantity",
    },
  };
}

function validatePrepared(raw: unknown): AmazonStockSyncPreparedRequest {
  const row = object(raw);
  const request = validateInput({
    marketplace: row.marketplace,
    sku: row.sku,
    asin: row.asin,
    writer_isolation: row.writer_isolation,
  });
  const variantId = typeof row.shopify_variant_id === "string" ? row.shopify_variant_id : "";
  const available = integer(row.shopify_available_quantity);
  const committed = integer(row.shopify_committed_quantity);
  const onHand = integer(row.shopify_on_hand_quantity);
  const amazonCurrent = integer(row.amazon_current_quantity);
  const productType = typeof row.amazon_product_type === "string" ? row.amazon_product_type : "";
  const preparedAt = typeof row.prepared_at === "string" ? row.prepared_at : "";
  if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(variantId) ||
      available === null || committed === null || onHand === null || amazonCurrent === null ||
      available > MAX_TARGET_QUANTITY || !PRODUCT_TYPE_RE.test(productType) ||
      !preparedAt || !Number.isFinite(Date.parse(preparedAt))) fail("prepared_request_invalid");
  return Object.freeze({
    ...request,
    shopify_variant_id: variantId,
    shopify_available_quantity: available,
    shopify_committed_quantity: committed,
    shopify_on_hand_quantity: onHand,
    amazon_current_quantity: amazonCurrent,
    amazon_product_type: productType,
    prepared_at: preparedAt,
  });
}

async function boundedJson(response: Response): Promise<Row> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) fail("amazon_stock_write_response_too_large");
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) fail("amazon_stock_write_response_too_large");
  try { return object(JSON.parse(text)); } catch { fail("amazon_stock_write_response_invalid_json"); }
}

function safeIssues(raw: unknown): Array<{ code: string; severity: string; attribute_names: string[] }> {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 32).map(value => {
    const issue = object(value);
    const code = typeof issue.code === "string" && /^[A-Za-z0-9_-]{1,90}$/.test(issue.code) ? issue.code : "UNVERIFIED";
    const severity = typeof issue.severity === "string" && ["ERROR", "WARNING", "INFO"].includes(issue.severity)
      ? issue.severity : "UNVERIFIED";
    const attrs = Array.isArray(issue.attributeNames)
      ? issue.attributeNames.filter(x => typeof x === "string" && /^[a-z][a-z0-9_]{0,119}$/.test(x)).slice(0, 20) as string[]
      : [];
    return { code, severity, attribute_names: attrs };
  });
}

function classifyReadFailure(error: unknown): "READ_TIMEOUT" | "READ_ERROR" {
  const message = error instanceof Error ? error.message : "";
  return /timeout|timed.?out|abort/i.test(message) ? "READ_TIMEOUT" : "READ_ERROR";
}

async function readShopifyStateOnly(
  request: Pick<AmazonStockSyncRequest, "sku">,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies,
): Promise<ReturnType<typeof extractShopifyVariant>> {
  const catalog = await (dependencies.readShopifyCatalog ?? readShopifyCatalogComplete)({
    query: "sku:" + request.sku,
    max_products: 10,
    inline_limit: 10,
    include_csv: false,
  }, env);
  return extractShopifyVariant(catalog, request.sku);
}

async function readAmazonStateOnly(
  request: Pick<AmazonStockSyncRequest, "marketplace" | "sku" | "asin">,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies,
): Promise<ReturnType<typeof extractAmazonState>> {
  const amazonRaw = await (dependencies.readAmazonListing ?? readAmazonSellerListingsDirect)({
    marketplace: request.marketplace,
    skus: [request.sku],
  }, env);
  return extractAmazonState(amazonRaw, request);
}

function validateMutationReceipt(raw: unknown): AmazonStockMutationReceipt {
  const row = object(raw);
  const request = validateInput({
    marketplace: row.marketplace,
    sku: row.sku,
    asin: row.asin,
    writer_isolation: row.writer_isolation,
  });
  const variantId = typeof row.shopify_variant_id === "string" ? row.shopify_variant_id : "";
  const available = integer(row.shopify_available_quantity_at_write);
  const committed = integer(row.shopify_committed_quantity_at_write);
  const onHand = integer(row.shopify_on_hand_quantity_at_write);
  const target = integer(row.target_quantity);
  const previous = integer(row.previous_quantity);
  const productType = typeof row.amazon_product_type === "string" ? row.amazon_product_type : "";
  const preparedAt = typeof row.prepared_at === "string" ? row.prepared_at : "";
  const acceptedAt = typeof row.accepted_at === "string" ? row.accepted_at : "";
  const submissionReference = typeof row.submission_reference === "string" && REFERENCE_RE.test(row.submission_reference)
    ? row.submission_reference : "";
  const issues = Array.isArray(row.provider_issues)
    ? row.provider_issues.slice(0, 32).map(value => {
      const issue = object(value);
      return {
        code: typeof issue.code === "string" && /^[A-Za-z0-9_-]{1,90}$/.test(issue.code) ? issue.code : "UNVERIFIED",
        severity: typeof issue.severity === "string" && ["ERROR", "WARNING", "INFO", "UNVERIFIED"].includes(issue.severity)
          ? issue.severity : "UNVERIFIED",
        attribute_names: Array.isArray(issue.attribute_names)
          ? issue.attribute_names.filter(x => typeof x === "string" && /^[a-z][a-z0-9_]{0,119}$/.test(x)).slice(0, 20) as string[]
          : [],
      };
    })
    : [];
  if (!/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(variantId) ||
      available === null || committed === null || onHand === null || target === null || previous === null ||
      target > MAX_TARGET_QUANTITY || target !== available || !PRODUCT_TYPE_RE.test(productType) ||
      !preparedAt || !Number.isFinite(Date.parse(preparedAt)) ||
      row.provider_status !== "ACCEPTED" || !submissionReference ||
      !acceptedAt || !Number.isFinite(Date.parse(acceptedAt)) || row.provider_mutations !== 1)
    fail("amazon_stock_mutation_receipt_invalid");
  return Object.freeze({
    ...request,
    shopify_variant_id: variantId,
    shopify_available_quantity_at_write: available,
    shopify_committed_quantity_at_write: committed,
    shopify_on_hand_quantity_at_write: onHand,
    amazon_product_type: productType,
    target_quantity: target,
    previous_quantity: previous,
    prepared_at: preparedAt,
    provider_status: "ACCEPTED",
    submission_reference: submissionReference,
    accepted_at: acceptedAt,
    provider_issues: issues,
    provider_mutations: 1,
  });
}

function shopifyChangedSinceMutation(
  current: ReturnType<typeof extractShopifyVariant>,
  receipt: AmazonStockMutationReceipt,
): boolean {
  return current.variant_id !== receipt.shopify_variant_id ||
    current.available !== receipt.shopify_available_quantity_at_write ||
    current.committed !== receipt.shopify_committed_quantity_at_write ||
    current.on_hand !== receipt.shopify_on_hand_quantity_at_write;
}

export async function executeAmazonExistingOfferStockSync(
  rawPrepared: unknown,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies = {},
): Promise<Row> {
  const prepared = validatePrepared(rawPrepared);
  const fresh = await readFreshState(prepared, env, dependencies);
  if (fresh.shopify.variant_id !== prepared.shopify_variant_id ||
      fresh.shopify.available !== prepared.shopify_available_quantity ||
      fresh.shopify.committed !== prepared.shopify_committed_quantity ||
      fresh.shopify.on_hand !== prepared.shopify_on_hand_quantity)
    fail("shopify_inventory_changed_since_prepare");
  if (fresh.amazon.product_type !== prepared.amazon_product_type ||
      fresh.amazon.quantity !== prepared.amazon_current_quantity)
    fail("amazon_listing_changed_since_prepare");

  const target = fresh.shopify.available;
  if (target === fresh.amazon.quantity) {
    return {
      ok: true,
      status: "NO_CHANGE_REQUIRED",
      marketplace: prepared.marketplace,
      sku: prepared.sku,
      asin: prepared.asin,
      target_quantity: target,
      verified_quantity: fresh.amazon.quantity,
      provider_mutations: 0,
      readback_verified: true,
      writer_isolation: prepared.writer_isolation,
    };
  }

  const sellerId = env.AMAZON_SP_API_SELLER_ID;
  if (typeof sellerId !== "string" || !SELLER_RE.test(sellerId)) fail("amazon_seller_id_missing");
  let token: string;
  try { token = await (dependencies.getAccessToken ?? getAmazonAccessToken)(env); }
  catch { fail("amazon_stock_write_authentication_failed"); }
  if (!token || /[\u0000-\u0020\u007f]/.test(token)) fail("amazon_stock_write_authentication_failed");

  const marketId = AMAZON_EU_MARKETPLACES[prepared.marketplace];
  const url = new URL(HOST + "/listings/2021-08-01/items/" + encodeURIComponent(sellerId) + "/" + encodeURIComponent(prepared.sku));
  url.searchParams.set("marketplaceIds", marketId);
  const body = {
    productType: prepared.amazon_product_type,
    patches: [{
      op: "replace",
      path: "/attributes/fulfillment_availability",
      value: [{
        fulfillment_channel_code: "DEFAULT",
        quantity: target,
        marketplace_id: marketId,
      }],
    }],
  };

  let response: Response;
  try {
    response = await (dependencies.fetch ?? fetch)(url.toString(), {
      method: "PATCH",
      headers: {
        "x-amz-access-token": token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
  } catch { fail("amazon_stock_write_transport_failed"); }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => {});
    fail("amazon_stock_write_http_" + response.status);
  }
  const provider = await boundedJson(response);
  const submissionId = typeof provider.submissionId === "string" && REFERENCE_RE.test(provider.submissionId)
    ? provider.submissionId : null;
  const providerStatus = provider.status === "ACCEPTED" ? "ACCEPTED" : provider.status === "INVALID" ? "INVALID" : "UNKNOWN";
  const issues = safeIssues(provider.issues);
  if (!submissionId || provider.sku !== prepared.sku || providerStatus !== "ACCEPTED")
    fail("amazon_stock_write_not_accepted");

  const receipt: AmazonStockMutationReceipt = Object.freeze({
    marketplace: prepared.marketplace,
    sku: prepared.sku,
    asin: prepared.asin,
    writer_isolation: prepared.writer_isolation,
    shopify_variant_id: prepared.shopify_variant_id,
    shopify_available_quantity_at_write: prepared.shopify_available_quantity,
    shopify_committed_quantity_at_write: prepared.shopify_committed_quantity,
    shopify_on_hand_quantity_at_write: prepared.shopify_on_hand_quantity,
    amazon_product_type: prepared.amazon_product_type,
    target_quantity: target,
    previous_quantity: prepared.amazon_current_quantity,
    prepared_at: prepared.prepared_at,
    provider_status: "ACCEPTED",
    submission_reference: submissionId,
    accepted_at: now(dependencies.clock ?? Date.now),
    provider_issues: issues,
    provider_mutations: 1,
  });
  if (dependencies.onMutationAccepted) {
    try { await dependencies.onMutationAccepted(receipt); }
    catch { fail("amazon_stock_write_receipt_persistence_failed"); }
  }

  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  let successfulReadbacks = 0;
  let lastReadFailure: "READ_TIMEOUT" | "READ_ERROR" = "READ_ERROR";
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(POLL_DELAY_MS);
    try {
      const observed = await readAmazonStateOnly(prepared, env, dependencies);
      successfulReadbacks++;
      if (observed.product_type === prepared.amazon_product_type && observed.quantity === target) {
        return {
          ok: true,
          status: "UPDATED_AND_VERIFIED",
          marketplace: prepared.marketplace,
          sku: prepared.sku,
          asin: prepared.asin,
          target_quantity: target,
          previous_quantity: prepared.amazon_current_quantity,
          verified_quantity: observed.quantity,
          provider_status: providerStatus,
          submission_reference: submissionId,
          provider_issues: issues,
          provider_mutations: 1,
          readback_verified: true,
          readback_attempt: attempt,
          writer_isolation: prepared.writer_isolation,
          mutation_receipt: receipt,
        };
      }
    } catch (error) {
      lastReadFailure = classifyReadFailure(error);
    }
  }
  return {
    ok: false,
    status: "MUTATION_ACCEPTED_PENDING_READBACK",
    marketplace: prepared.marketplace,
    sku: prepared.sku,
    asin: prepared.asin,
    target_quantity: target,
    previous_quantity: prepared.amazon_current_quantity,
    provider_status: providerStatus,
    submission_reference: submissionId,
    provider_issues: issues,
    provider_mutations: 1,
    readback_verified: false,
    readback_attempts: POLL_ATTEMPTS,
    readback_outcome: successfulReadbacks > 0 ? "QUANTITY_NOT_CONFIRMED" : lastReadFailure,
    writer_isolation: prepared.writer_isolation,
    mutation_receipt: receipt,
    retry_patch_allowed: false,
  };
}

export async function reconcileAmazonExistingOfferStockSync(
  rawReceipt: unknown,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies = {},
): Promise<Row> {
  const receipt = validateMutationReceipt(rawReceipt);
  let shopify: ReturnType<typeof extractShopifyVariant> | null = null;
  let shopifyReadOutcome: "VERIFIED" | "READ_TIMEOUT" | "READ_ERROR" = "VERIFIED";
  try {
    shopify = await readShopifyStateOnly(receipt, env, dependencies);
  } catch (error) {
    shopifyReadOutcome = classifyReadFailure(error);
  }

  let amazon: ReturnType<typeof extractAmazonState> | null = null;
  let amazonReadOutcome: "VERIFIED" | "READ_TIMEOUT" | "READ_ERROR" = "VERIFIED";
  try {
    amazon = await readAmazonStateOnly(receipt, env, dependencies);
  } catch (error) {
    amazonReadOutcome = classifyReadFailure(error);
  }

  const shopifyChanged = shopify ? shopifyChangedSinceMutation(shopify, receipt) : null;
  const common = {
    marketplace: receipt.marketplace,
    sku: receipt.sku,
    asin: receipt.asin,
    target_quantity: receipt.target_quantity,
    previous_quantity: receipt.previous_quantity,
    provider_status: receipt.provider_status,
    submission_reference: receipt.submission_reference,
    accepted_at: receipt.accepted_at,
    provider_mutations: 0,
    read_only: true,
    retry_patch_allowed: false,
    shopify_state_verified: Boolean(shopify),
    shopify_read_outcome: shopifyReadOutcome,
    shopify_current_available_quantity: shopify?.available ?? null,
    shopify_current_committed_quantity: shopify?.committed ?? null,
    shopify_current_on_hand_quantity: shopify?.on_hand ?? null,
    shopify_changed_since_mutation: shopifyChanged,
  };

  if (!amazon) {
    return {
      ...common,
      ok: false,
      status: "RECONCILIATION_PENDING",
      closure_allowed: false,
      readback_verified: false,
      readback_outcome: amazonReadOutcome,
      verified_quantity: null,
      follow_up_required: true,
    };
  }

  if (amazon.product_type === receipt.amazon_product_type && amazon.quantity === receipt.target_quantity) {
    return {
      ...common,
      ok: true,
      status: "RECONCILED_AND_VERIFIED",
      closure_allowed: true,
      readback_verified: true,
      readback_outcome: "VERIFIED",
      verified_quantity: amazon.quantity,
      follow_up_required: shopifyChanged !== false,
    };
  }

  return {
    ...common,
    ok: false,
    status: "RECONCILIATION_PENDING",
    closure_allowed: false,
    readback_verified: false,
    readback_outcome: "QUANTITY_NOT_CONFIRMED",
    verified_quantity: amazon.quantity,
    follow_up_required: true,
  };
}

export async function observeHistoricalAmazonStockPlan(
  rawPrepared: unknown,
  env: StockSyncEnv,
  dependencies: AmazonStockSyncDependencies = {},
): Promise<Row> {
  const prepared = validatePrepared(rawPrepared);
  let shopify: ReturnType<typeof extractShopifyVariant> | null = null;
  let shopifyReadOutcome: "VERIFIED" | "READ_TIMEOUT" | "READ_ERROR" = "VERIFIED";
  try {
    shopify = await readShopifyStateOnly(prepared, env, dependencies);
  } catch (error) {
    shopifyReadOutcome = classifyReadFailure(error);
  }

  let amazon: ReturnType<typeof extractAmazonState> | null = null;
  let amazonReadOutcome: "VERIFIED" | "READ_TIMEOUT" | "READ_ERROR" = "VERIFIED";
  try {
    amazon = await readAmazonStateOnly(prepared, env, dependencies);
  } catch (error) {
    amazonReadOutcome = classifyReadFailure(error);
  }

  return {
    ok: true,
    status: "HISTORICAL_OBSERVATION_ONLY",
    marketplace: prepared.marketplace,
    sku: prepared.sku,
    asin: prepared.asin,
    target_quantity: prepared.shopify_available_quantity,
    previous_quantity: prepared.amazon_current_quantity,
    provider_mutations: 0,
    read_only: true,
    retry_patch_allowed: false,
    closure_allowed: false,
    historical_submission_reference_available: false,
    attribution_to_historical_mutation_proven: false,
    shopify_state_verified: Boolean(shopify),
    shopify_read_outcome: shopifyReadOutcome,
    shopify_current_available_quantity: shopify?.available ?? null,
    shopify_changed_since_prepare: shopify
      ? shopify.variant_id !== prepared.shopify_variant_id ||
        shopify.available !== prepared.shopify_available_quantity ||
        shopify.committed !== prepared.shopify_committed_quantity ||
        shopify.on_hand !== prepared.shopify_on_hand_quantity
      : null,
    amazon_state_verified: Boolean(amazon),
    amazon_read_outcome: amazonReadOutcome,
    amazon_current_quantity: amazon?.quantity ?? null,
    amazon_quantity_matches_historical_target: amazon?.quantity === prepared.shopify_available_quantity,
    reason: "historical_mutation_reference_unavailable",
  };
}
