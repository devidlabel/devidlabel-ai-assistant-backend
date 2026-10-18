import { readAmazonOrdersPilot } from "./marketplace-amazon-orders-readonly.js";
import { prepareAmazonOrderObservations } from "./marketplace-order-shadow-intake.js";
import { readShopifyChannableAmazonAdoptionIndex } from "./marketplace-shopify-channable-amazon-adoption.js";
import { reconcileAmazonShopifyOrderAdoption } from "./marketplace-amazon-channable-adoption-reconcile.js";
import { readShopifyChannableAmazonOrderLines, compareAmazonOrderWithChannableShopifyLines } from "./marketplace-shopify-channable-amazon-lines.js";
import {
  prepareMarketplaceOrderEvidence, verifyMarketplaceOrderEvidenceProof,
  type OrderEvidenceEnv,
} from "./marketplace-order-evidence.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type Row = Record<string, unknown>;
type JournalNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};
export type OrderEvidenceClientEnv = OrderEvidenceEnv &
  Parameters<typeof readAmazonOrdersPilot>[1] & MareBusinessShopifyEnv & {
    MARE_ORDER_JOURNAL?: JournalNamespace;
    MARE_ORDER_JOURNAL_ENABLED?: string;
    MARE_BUSINESS_ACCESS_TOKEN?: string;
  };
type Readers = {
  amazon: typeof readAmazonOrdersPilot;
  shopifyIndex: typeof readShopifyChannableAmazonAdoptionIndex;
  shopifyLines: typeof readShopifyChannableAmazonOrderLines;
};
const LIVE_READERS: Readers = {
  amazon: readAmazonOrdersPilot,
  shopifyIndex: readShopifyChannableAmazonAdoptionIndex,
  shopifyLines: readShopifyChannableAmazonOrderLines,
};
const REQUEST_KEYS = [
  "marketplaces", "amazon_order_id", "last_updated_after", "last_updated_before",
  "shopify_created_after", "shopify_created_before", "amazon_max_pages", "shopify_max_pages",
];
const REQUIRED_KEYS = REQUEST_KEYS.slice(0, 6);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_BODY_BYTES = 1_000_000;

async function providerRead(call: () => Promise<Row>): Promise<Row> {
  try { return await call(); }
  catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (/^(?:amazon_orders|shopify_adoption|shopify_channable_lines)_[a-z_]{1,100}$/.test(code))
      throw new Error(code);
    throw new Error("marketplace_order_evidence_provider_read_failed");
  }
}

function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("marketplace_order_evidence_invalid_request");
  return value as Row;
}
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !ISO_RE.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error("marketplace_order_evidence_invalid_request");
  return new Date(value).toISOString();
}
function pages(value: unknown, limit: number): number {
  if (value === undefined) return limit;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > limit)
    throw new Error("marketplace_order_evidence_invalid_request");
  return value;
}

/** Public callers choose a bounded window and one order identity, never the
 * observations, Shopify GID, provider account, tenant, URL, or store domain.
 */
export function validateOrderEvidenceCaptureRequest(raw: unknown): Row {
  const input = object(raw);
  if (Object.keys(input).some(key => !REQUEST_KEYS.includes(key)) ||
      REQUIRED_KEYS.some(key => !Object.hasOwn(input, key)) ||
      typeof input.amazon_order_id !== "string" || !/^\d{3}-\d{7}-\d{7}$/.test(input.amazon_order_id) ||
      !Array.isArray(input.marketplaces) || input.marketplaces.length < 1 || input.marketplaces.length > 4 ||
      input.marketplaces.some(market => !["IT", "DE", "FR", "ES"].includes(market)) ||
      new Set(input.marketplaces).size !== input.marketplaces.length)
    throw new Error("marketplace_order_evidence_invalid_request");
  const after = timestamp(input.last_updated_after), before = timestamp(input.last_updated_before);
  const shopAfter = timestamp(input.shopify_created_after), shopBefore = timestamp(input.shopify_created_before);
  const amazonDuration = Date.parse(before) - Date.parse(after);
  const shopifyDuration = Date.parse(shopBefore) - Date.parse(shopAfter);
  if (amazonDuration <= 0 || amazonDuration > 7 * 86_400_000 ||
      shopifyDuration <= 0 || shopifyDuration > 14 * 86_400_000 ||
      Date.parse(before) > Date.now() - 180_000)
    throw new Error("marketplace_order_evidence_invalid_window");
  return {
    marketplaces: [...input.marketplaces].sort(), amazon_order_id: input.amazon_order_id,
    last_updated_after: after, last_updated_before: before,
    shopify_created_after: shopAfter, shopify_created_before: shopBefore,
    amazon_max_pages: pages(input.amazon_max_pages, 5),
    shopify_max_pages: pages(input.shopify_max_pages, 10),
  };
}

function journal(env: OrderEvidenceClientEnv) {
  if (env.MARE_ORDER_JOURNAL_ENABLED !== "true" || !env.MARE_ORDER_JOURNAL ||
      typeof env.MARE_ORDER_JOURNAL.idFromName !== "function" ||
      typeof env.MARE_ORDER_JOURNAL.get !== "function" ||
      typeof env.MARE_BUSINESS_ACCESS_TOKEN !== "string" || env.MARE_BUSINESS_ACCESS_TOKEN.length < 16 ||
      typeof env.COMMERCE_TENANT_ID !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(env.COMMERCE_TENANT_ID) ||
      typeof env.AMAZON_SP_API_SELLER_ID !== "string" || !/^[A-Z0-9]{8,30}$/.test(env.AMAZON_SP_API_SELLER_ID) ||
      typeof env.SHOPIFY_SHOP_DOMAIN !== "string" ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(env.SHOPIFY_SHOP_DOMAIN.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()))
    throw new Error("marketplace_order_evidence_not_configured");
  try {
    const id = env.MARE_ORDER_JOURNAL.idFromName(JSON.stringify([
      "orders-v1", env.COMMERCE_TENANT_ID, env.AMAZON_SP_API_SELLER_ID,
    ]));
    return env.MARE_ORDER_JOURNAL.get(id);
  } catch { throw new Error("marketplace_order_evidence_not_configured"); }
}

async function invokeJournal(path: "/evidence/capture" | "/evidence/read", payload: Row, env: OrderEvidenceClientEnv): Promise<unknown> {
  const actor = journal(env);
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES)
    throw new Error("marketplace_order_evidence_body_limit");
  let response: Response;
  try {
    response = await actor.fetch(new Request("https://order-journal.internal" + path, {
      method: "POST", headers: {
        "Content-Type": "application/json", "Authorization": "Bearer " + env.MARE_BUSINESS_ACCESS_TOKEN,
      }, body,
    }));
  } catch { throw new Error("marketplace_order_evidence_persistence_unverified"); }
  if (!response.ok) throw new Error("marketplace_order_evidence_persistence_unverified");
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES)
      throw new Error("marketplace_order_evidence_response_invalid");
    return JSON.parse(text);
  } catch { throw new Error("marketplace_order_evidence_response_invalid"); }
}

/** Explicit local-audit preparation. Both provider sources and the Shopify
 * line reader are called here on the server. No provider mutation, order
 * adoption transition, stock reservation, cursor, scheduler, or live writer.
 * Reader injection is an internal test seam and is never exposed through MCP.
 */
export async function captureLiveMarketplaceOrderEvidence(
  raw: unknown, env: OrderEvidenceClientEnv, readers: Readers = LIVE_READERS,
): Promise<Row> {
  const input = validateOrderEvidenceCaptureRequest(raw);
  journal(env);
  const [amazon, shopifyIndex] = await Promise.all([
    providerRead(() => readers.amazon({
      marketplaces: input.marketplaces, last_updated_after: input.last_updated_after,
      last_updated_before: input.last_updated_before, max_pages: input.amazon_max_pages,
    }, env)),
    providerRead(() => readers.shopifyIndex({
      created_after: input.shopify_created_after, created_before: input.shopify_created_before,
      max_pages: input.shopify_max_pages,
    }, env)),
  ]);
  const batch = prepareAmazonOrderObservations(amazon, env.AMAZON_SP_API_SELLER_ID!);
  if (batch.length > 20) throw new Error("marketplace_order_evidence_batch_limit");
  const reconciliation = reconcileAmazonShopifyOrderAdoption(amazon, shopifyIndex);
  const matches = (reconciliation.matched as Row[]).filter(row => row.amazon_order_id === input.amazon_order_id);
  if (matches.length !== 1 || reconciliation.channable_shopify_index_unverified_count !== 0)
    throw new Error("marketplace_order_evidence_existing_order_unverified");
  const shopifyLines = await providerRead(() => readers.shopifyLines({
    amazon_order_id: input.amazon_order_id, shopify_order_gid: matches[0].shopify_order_gid,
  }, env));
  const envelope = {
    amazon, shopify_index: shopifyIndex, shopify_lines: shopifyLines,
    amazon_order_id: input.amazon_order_id as string,
  };
  const prepared = await prepareMarketplaceOrderEvidence(envelope, env, compareAmazonOrderWithChannableShopifyLines);
  const captured = await invokeJournal("/evidence/capture", envelope, env);
  const verified = await verifyMarketplaceOrderEvidenceProof(captured, env, {
    receipt_id: prepared.receipt.receipt_id as string, expected_manifest: prepared.manifest,
    allowed_statuses: ["CAPTURED", "ALREADY_CAPTURED"],
  });
  const reread = await invokeJournal("/evidence/read", {receipt_id: prepared.receipt.receipt_id}, env);
  await verifyMarketplaceOrderEvidenceProof(reread, env, {
    receipt_id: prepared.receipt.receipt_id as string, expected_manifest: prepared.manifest,
    allowed_statuses: ["STORED_VERIFIED"],
  });
  return {...verified, independent_readback_verified: true};
}

/** Independent read of a stored proof: no Amazon/Shopify request or write. */
export async function readStoredMarketplaceOrderEvidence(raw: unknown, env: OrderEvidenceClientEnv): Promise<Row> {
  const input = object(raw);
  if (Object.keys(input).length !== 1 || typeof input.receipt_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.receipt_id))
    throw new Error("marketplace_order_evidence_invalid_request");
  const proof = await invokeJournal("/evidence/read", {receipt_id: input.receipt_id}, env);
  return verifyMarketplaceOrderEvidenceProof(proof, env, {
    receipt_id: input.receipt_id, allowed_statuses: ["STORED_VERIFIED"],
  });
}
