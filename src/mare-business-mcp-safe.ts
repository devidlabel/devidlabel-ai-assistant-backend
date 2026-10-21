import { readMarketplaceShadowStatus } from "./marketplace-shadow.js";
import { readAmazonMerchantSkuStatuses } from "./mare-business-amazon-sku-status.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import { readAmazonCatalogASINDetails } from "./mare-business-amazon-details.js";
import { prepareAmazonExistingOfferStockSync, executeAmazonExistingOfferStockSync, reconcileAmazonExistingOfferStockSync, observeHistoricalAmazonStockPlan } from "./mare-business-amazon-stock-sync.js";
import { handleMareBusinessMcpRequest } from "./mare-business-mcp.js";
import { buildMareBusinessCapabilities, type MareBusinessCapability } from "./mare-business-capabilities.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import { updateExistingShopifyMetafields } from "./mare-business-shopify-metafields.js";
import { assignMissingShopifyProductSeasons } from "./mare-business-shopify-season.js";
import {
  generateMarketplaceFeedComplete,
  generateMatrixifyCatalogComplete,
} from "./mare-business-marketplace-complete.js";
import {
  createTikTokAuthorizationUrl,
  createTikTokCampaignSafe,
  readTikTokCampaignsSafe,
  tiktokSafeAuthorizationStatus,
  updateTikTokCampaignSafe,
  type MareBusinessTikTokSafeEnv,
} from "./mare-business-tiktok-safe.js";
import { tiktokPilotCapabilities, assertTikTokPilotPlan, readTikTokPilot, executeTikTokPilot } from "./mare-business-tiktok-pilot.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;
type KVNamespaceLike = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};

type SafeBusinessEnv = MareBusinessTikTokSafeEnv & MareBusinessShopifyEnv & {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  SHOPIFY_TOKENS_KV?: KVNamespaceLike;
  [key: string]: unknown;
};

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
};

type PlanStatus = "prepared" | "executing" | "completed" | "failed" | "reconciliation_required" | "cancelled";
type StoredPlan = {
  plan_id: string;
  capability_id: string;
  request: JsonObject;
  risk: MareBusinessCapability["risk"];
  approval: MareBusinessCapability["approval"];
  status: PlanStatus;
  created_at: string;
  expires_at: string;
  executed_at?: string;
  result_summary?: JsonObject;
  error?: string;
  reconciliation?: JsonObject;
};

const PLAN_TTL_SECONDS = 24 * 60 * 60;
const SHOPIFY_METAFIELD_CAPABILITY_ID = "shopify.metafields.update_existing";
const SHOPIFY_SEASON_CAPABILITY_ID = "shopify.product.season.assign_missing";
const AMAZON_STOCK_CAPABILITY_ID = "amazon.inventory.sync.pilot";
const TIKTOK_PILOT_WRITE = new Set(["tiktok.adgroup.create", "tiktok.adgroup.update", "tiktok.ad.create", "tiktok.ad.update"]);
const TIKTOK_PILOT_READ = new Set(["tiktok.adgroup.read", "tiktok.ad.read", "tiktok.creative.video.read", "tiktok.creative.image.read", "tiktok.reporting.read"]);
const TIKTOK_CAPABILITIES = new Set([
  "tiktok.authorization.status",
  "tiktok.authorization.start",
  "tiktok.campaign.read",
  "tiktok.campaign.create",
  "tiktok.campaign.update",
]);

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function isAuthorized(request: Request, env: SafeBusinessEnv): boolean {
  const expected = normalize(env.MARE_BUSINESS_ACCESS_TOKEN);
  const authorization = request.headers.get("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : normalize(request.headers.get("X-MARE-BUSINESS-Key"));
  return Boolean(expected) && timingSafeEqualText(expected, supplied);
}

function protocolVersion(request: Request): string {
  return normalize(request.headers.get("MCP-Protocol-Version")) || "2025-06-18";
}

function responseHeaders(request: Request): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "MCP-Protocol-Version": protocolVersion(request),
  };
}

function textToolResult(payload: unknown): JsonObject {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: false,
  };
}

function toolFailure(message: string, detail?: unknown): JsonObject {
  return {
    content: [{ type: "text", text: detail === undefined ? message : `${message}: ${JSON.stringify(detail)}` }],
    structuredContent: { error: message, detail: detail ?? null },
    isError: true,
  };
}

function rpcToolResponse(request: Request, id: RpcRequest["id"], result: JsonObject): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    status: 200,
    headers: responseHeaders(request),
  });
}

function planKey(planId: string): string {
  return `mare-business:plan:${planId}`;
}

async function storePlan(plan: StoredPlan, env: SafeBusinessEnv): Promise<void> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_plan_store_not_configured");
  await env.SHOPIFY_TOKENS_KV.put(planKey(plan.plan_id), JSON.stringify(plan), { expirationTtl: PLAN_TTL_SECONDS });
}

async function loadPlan(planId: string, env: SafeBusinessEnv): Promise<StoredPlan> {
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("business_plan_store_not_configured");
  if (!/^mbp_[A-Za-z0-9-]{20,80}$/.test(planId)) throw new Error("invalid_plan_id");
  const raw = await env.SHOPIFY_TOKENS_KV.get(planKey(planId));
  if (!raw) throw new Error("plan_not_found_or_expired");
  const plan = JSON.parse(raw) as StoredPlan;
  if (plan.plan_id !== planId) throw new Error("plan_record_invalid");
  return plan;
}

function startCapability(status: JsonObject): MareBusinessCapability {
  const configured = status.app_configured === true && status.authorization_url_configured === true && status.kv_store_configured === true;
  const missing = [
    ...(status.app_configured === true ? [] : ["TIKTOK_APP_ID and TIKTOK_APP_SECRET"]),
    ...(status.authorization_url_configured === true ? [] : ["TIKTOK_AUTHORIZATION_URL"]),
    ...(status.kv_store_configured === true ? [] : ["SHOPIFY_TOKENS_KV"]),
  ];
  return {
    id: "tiktok.authorization.start",
    provider: "tiktok",
    domain: "advertising",
    operation: "prepare",
    risk: "artifact_only",
    implemented: true,
    configured,
    available: configured,
    approval: "none",
    description: "Create a short-lived TikTok advertiser authorization URL through an authenticated MARE request.",
    request_schema: { type: "object", properties: {}, additionalProperties: false },
    missing,
  };
}

function shopifyMetafieldCapability(env: SafeBusinessEnv): MareBusinessCapability {
  const configured = Boolean(normalize(env.SHOPIFY_SHOP_DOMAIN) && env.SHOPIFY_TOKENS_KV);
  return {
    id: SHOPIFY_METAFIELD_CAPABILITY_ID,
    provider: "shopify",
    domain: "catalog",
    operation: "execute",
    risk: "reversible_write",
    implemented: true,
    configured,
    available: configured,
    approval: "explicit",
    description: "Update 1-25 already-existing custom metafields on Shopify products or variants using compareDigest CAS, atomic write and mandatory readback. Creation and deletion are not allowed.",
    request_schema: {
      type: "object",
      properties: {
        metafields: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: {
            type: "object",
            properties: {
              owner_id: { type: "string", pattern: "^gid://shopify/(Product|ProductVariant)/[0-9]+$" },
              namespace: { type: "string", enum: ["custom"] },
              key: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
              value: { type: "string" },
            },
            required: ["owner_id", "namespace", "key", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["metafields"],
      additionalProperties: false,
    },
    missing: configured ? [] : ["Shopify OAuth/KV"],
  };
}

function shopifySeasonCapability(env: SafeBusinessEnv): MareBusinessCapability {
  const configured = Boolean(normalize(env.SHOPIFY_SHOP_DOMAIN) && env.SHOPIFY_TOKENS_KV);
  return {
    id: SHOPIFY_SEASON_CAPABILITY_ID,
    provider: "shopify",
    domain: "catalog",
    operation: "execute",
    risk: "reversible_write",
    implemented: true,
    configured,
    available: configured,
    approval: "explicit",
    description: "Assign the Shopify Product features.season metaobject_reference only when it is currently missing. The referenced product_feature_season handle must resolve before an atomic compareDigest-null create-if-absent write; existing seasons are never overwritten.",
    request_schema: {
      type: "object",
      properties: {
        assignments: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: {
            type: "object",
            properties: {
              product_id: { type: "string", pattern: "^gid://shopify/Product/[0-9]+$" },
              season_reference: { type: "string", pattern: "^product_feature_season\\.[a-z0-9][a-z0-9-]{0,99}$" },
            },
            required: ["product_id", "season_reference"],
            additionalProperties: false,
          },
        },
      },
      required: ["assignments"],
      additionalProperties: false,
    },
    missing: configured ? [] : ["Shopify OAuth/KV with read_metaobjects and write_products"],
  };
}


function amazonStockCapability(env: SafeBusinessEnv): MareBusinessCapability {
  const configured = Boolean(
    normalize(env.AMAZON_SP_API_CLIENT_ID) &&
    normalize(env.AMAZON_SP_API_CLIENT_SECRET) &&
    normalize(env.AMAZON_SP_API_REFRESH_TOKEN) &&
    normalize(env.AMAZON_SP_API_SELLER_ID) &&
    normalize(env.SHOPIFY_SHOP_DOMAIN) &&
    env.SHOPIFY_TOKENS_KV
  );
  return {
    id: AMAZON_STOCK_CAPABILITY_ID,
    provider: "amazon",
    domain: "marketplace",
    operation: "execute",
    risk: "live_write",
    implemented: true,
    configured,
    available: configured,
    approval: "explicit",
    description: "Pilot-only update of current FBM quantity on one existing Amazon seller offer. Target quantity is derived server-side from Shopify available inventory. Execute requires fresh server-side proof that all competing EU inventory writers are disabled; the caller writer_isolation string is only an attestation and is never sufficient by itself. At most one PATCH is allowed, followed by provider readback or deferred reconciliation. No product creation, price change, feed upload or automatic scheduler.",
    request_schema: {
      type: "object",
      properties: {
        marketplace: { type: "string", enum: ["IT", "DE", "FR", "ES"] },
        sku: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$" },
        asin: { type: "string", pattern: "^[A-Z0-9]{10}$" },
        writer_isolation: { type: "string", enum: ["CHANNABLE_DISABLED_FOR_SKU"] },
      },
      required: ["marketplace", "sku", "asin", "writer_isolation"],
      additionalProperties: false,
    },
    missing: configured ? [] : ["Amazon SP-API seller credentials and Shopify OAuth/KV"],
  };
}

async function resolvedCapabilities(env: SafeBusinessEnv): Promise<MareBusinessCapability[]> {
  const status = await tiktokSafeAuthorizationStatus(env);
  const authorized = status.authorized === true;
  const capabilities = buildMareBusinessCapabilities(env).map((capability) => {
    if (!["tiktok.campaign.read", "tiktok.campaign.create", "tiktok.campaign.update"].includes(capability.id)) return capability;
    return {
      ...capability,
      configured: authorized,
      available: capability.implemented && authorized,
      missing: authorized ? [] : ["TikTok long-term access token and advertiser authorization"],
    };
  });
  capabilities.push(...tiktokPilotCapabilities(authorized) as MareBusinessCapability[]);
  const existingStart = capabilities.findIndex((item) => item.id === "tiktok.authorization.start");
  const start = startCapability(status);
  if (existingStart >= 0) capabilities[existingStart] = start;
  else capabilities.push(start);

  const shopifyMetafield = shopifyMetafieldCapability(env);
  const existingShopifyMetafield = capabilities.findIndex((item) => item.id === SHOPIFY_METAFIELD_CAPABILITY_ID);
  if (existingShopifyMetafield >= 0) capabilities[existingShopifyMetafield] = shopifyMetafield;
  else capabilities.push(shopifyMetafield);

  const shopifySeason = shopifySeasonCapability(env);
  const existingShopifySeason = capabilities.findIndex((item) => item.id === SHOPIFY_SEASON_CAPABILITY_ID);
  if (existingShopifySeason >= 0) capabilities[existingShopifySeason] = shopifySeason;
  else capabilities.push(shopifySeason);

  const amazonStock = amazonStockCapability(env);
  const existingAmazonStock = capabilities.findIndex((item) => item.id === AMAZON_STOCK_CAPABILITY_ID);
  if (existingAmazonStock >= 0) capabilities[existingAmazonStock] = amazonStock;
  else capabilities.push(amazonStock);

  const amazonStockReconcile: MareBusinessCapability = {
    id: "amazon.inventory.sync.reconcile",
    provider: "amazon",
    domain: "marketplace",
    operation: "read",
    risk: "read_only",
    implemented: true,
    configured: amazonStock.configured,
    available: amazonStock.available,
    approval: "none",
    description: "Read-only deferred reconciliation for one previously executed Amazon stock pilot plan. It never issues PATCH, never replays the mutation, and only closes a plan when the stored accepted-mutation receipt is matched by live Amazon readback. Historical plans without a stored submission reference remain observation-only.",
    request_schema: {
      type: "object",
      properties: { plan_id: { type: "string", pattern: "^mbp_[A-Za-z0-9-]{20,80}$" } },
      required: ["plan_id"],
      additionalProperties: false,
    },
    missing: amazonStock.missing,
  };
  const existingAmazonStockReconcile = capabilities.findIndex((item) => item.id === amazonStockReconcile.id);
  if (existingAmazonStockReconcile >= 0) capabilities[existingAmazonStockReconcile] = amazonStockReconcile;
  else capabilities.push(amazonStockReconcile);

  return capabilities;
}

async function resolveCapability(id: string, env: SafeBusinessEnv): Promise<MareBusinessCapability | null> {
  return (await resolvedCapabilities(env)).find((item) => item.id === id) || null;
}

function filterCapabilityList(capabilities: MareBusinessCapability[], args: JsonObject): MareBusinessCapability[] {
  const provider = normalize(args.provider);
  const domain = normalize(args.domain);
  return capabilities.filter((item) => {
    if (provider && item.provider !== provider) return false;
    if (domain && item.domain !== domain) return false;
    if (args.available_only === true && !item.available) return false;
    if (args.implemented_only === true && !item.implemented) return false;
    return true;
  });
}

function createPlan(capability: MareBusinessCapability, request: JsonObject): StoredPlan {
  const now = new Date();
  return {
    plan_id: `mbp_${crypto.randomUUID()}`,
    capability_id: capability.id,
    request,
    risk: capability.risk,
    approval: capability.approval,
    status: "prepared",
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PLAN_TTL_SECONDS * 1000).toISOString(),
  };
}

async function completeArtifactPlan(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const plan = createPlan(capability, requestPayload);
  let result: JsonObject;
  if (capability.id === "marketplace.feed.generate") {
    result = await generateMarketplaceFeedComplete(requestPayload, env);
  } else if (capability.id === "matrixify.catalog.generate") {
    result = await generateMatrixifyCatalogComplete(requestPayload, env);
  } else if (capability.id === "tiktok.authorization.start") {
    result = await createTikTokAuthorizationUrl(env);
  } else {
    throw new Error("safe_artifact_router_not_implemented");
  }
  plan.status = "completed";
  plan.executed_at = new Date().toISOString();
  plan.result_summary = result;
  await storePlan(plan, env);
  return textToolResult({ plan, result });
}


async function prepareAmazonStockWrite(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const prepared = await prepareAmazonExistingOfferStockSync(requestPayload, env as any);
  const plan = createPlan(capability, prepared.prepared_request as unknown as JsonObject);
  await storePlan(plan, env);
  return textToolResult({
    ok: true,
    status: "prepared",
    plan,
    preview: prepared.summary,
    required_confirmation: "EXECUTE MARE LIVE PLAN",
    immutable_request: true,
    external_write_performed: false,
    guardrails: {
      one_existing_offer_only: true,
      target_quantity_server_derived_from_shopify_available: true,
      committed_inventory_accounted: true,
      channable_writer_isolation_attested: true,
      caller_attestation_is_not_isolation_proof: true,
      server_side_eu_writer_isolation_proof_required: true,
      production_execute_fail_closed_until_verifier_is_wired: true,
      amazon_read_before_write: true,
      at_most_one_provider_patch: true,
      amazon_read_after_write_required: true,
      listing_creation_allowed: false,
      price_change_allowed: false,
      automatic_scheduler_enabled: false,
    },
  });
}

async function prepareTikTokWrite(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const plan = createPlan(capability, requestPayload);
  await storePlan(plan, env);
  return textToolResult({
    ok: true,
    status: "prepared",
    plan,
    required_confirmation: "EXECUTE MARE LIVE PLAN",
    immutable_request: true,
    external_write_performed: false,
  });
}

async function prepareShopifyMetafieldWrite(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const plan = createPlan(capability, requestPayload);
  await storePlan(plan, env);
  return textToolResult({
    ok: true,
    status: "prepared",
    plan,
    required_confirmation: "EXECUTE MARE PLAN",
    immutable_request: true,
    external_write_performed: false,
    guardrails: {
      existing_metafields_only: true,
      compare_digest_cas: true,
      read_before_write: true,
      read_after_write: true,
      create_allowed: false,
      delete_allowed: false,
    },
  });
}

async function prepareShopifySeasonWrite(
  capability: MareBusinessCapability,
  requestPayload: JsonObject,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  const plan = createPlan(capability, requestPayload);
  await storePlan(plan, env);
  return textToolResult({
    ok: true,
    status: "prepared",
    plan,
    required_confirmation: "EXECUTE MARE PLAN",
    immutable_request: true,
    external_write_performed: false,
    guardrails: {
      missing_only: true,
      owner_type: "Product",
      namespace: "features",
      key: "season",
      type: "metaobject_reference",
      metaobject_type: "product_feature_season",
      compare_digest_null_create_if_absent: true,
      overwrite_existing_allowed: false,
      arbitrary_metafield_creation_allowed: false,
      delete_allowed: false,
      read_before_write: true,
      read_after_write: true,
    },
  });
}


async function executeAmazonStockPlan(
  plan: StoredPlan,
  confirmation: string,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  if (confirmation !== "EXECUTE MARE LIVE PLAN") throw new Error("approval_confirmation_required:EXECUTE MARE LIVE PLAN");
  if (plan.status === "completed") return textToolResult({ ok: true, status: "completed", idempotent_replay: true, plan });
  if (plan.status === "failed" || plan.status === "reconciliation_required") throw new Error("plan_reconciliation_required");
  if (plan.status === "cancelled") throw new Error("plan_cancelled");
  if (plan.status === "executing") throw new Error("plan_already_executing");
  if (Date.parse(plan.expires_at) <= Date.now()) throw new Error("plan_expired");
  const capability = await resolveCapability(plan.capability_id, env);
  if (!capability?.available) throw new Error(`capability_no_longer_available:${capability?.missing.join(",") || "unknown"}`);

  plan.status = "executing";
  await storePlan(plan, env);
  try {
    let acceptedReceipt: JsonObject | null = null;
    const result = await executeAmazonExistingOfferStockSync(plan.request, env as any, {
      onMutationAccepted: async (receipt) => {
        acceptedReceipt = receipt as unknown as JsonObject;
        plan.reconciliation = {
          phase: "mutation_accepted",
          receipt: acceptedReceipt,
          readback_verified: false,
          retry_patch_allowed: false,
        };
        await storePlan(plan, env);
      },
    });
    if (result.status === "MUTATION_ACCEPTED_PENDING_READBACK") {
      plan.status = "reconciliation_required";
      plan.result_summary = result;
      plan.error = "amazon_stock_write_readback_unconfirmed";
      plan.reconciliation = {
        phase: "pending_readback",
        receipt: acceptedReceipt ?? object(result.mutation_receipt),
        readback_verified: false,
        retry_patch_allowed: false,
        last_readback: result,
      };
      await storePlan(plan, env);
      return textToolResult({ plan_id: plan.plan_id, status: plan.status, result });
    }
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = result;
    if (acceptedReceipt) {
      plan.reconciliation = {
        phase: "verified",
        receipt: acceptedReceipt,
        readback_verified: true,
        retry_patch_allowed: false,
        last_readback: result,
      };
    }
    await storePlan(plan, env);
    return textToolResult({ plan_id: plan.plan_id, status: plan.status, result });
  } catch (error) {
    plan.status = "reconciliation_required";
    plan.error = error instanceof Error ? error.message : "amazon_stock_plan_execution_failed";
    if (!plan.reconciliation) {
      plan.reconciliation = {
        phase: "mutation_outcome_unknown",
        readback_verified: false,
        retry_patch_allowed: false,
      };
    }
    await storePlan(plan, env);
    throw error;
  }
}

async function executeTikTokPlan(
  plan: StoredPlan,
  confirmation: string,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  if (confirmation !== "EXECUTE MARE LIVE PLAN") throw new Error("approval_confirmation_required:EXECUTE MARE LIVE PLAN");
  if (plan.status === "completed") return textToolResult({ ok: true, status: "completed", idempotent_replay: true, plan });
  if (plan.status === "failed" || plan.status === "reconciliation_required") throw new Error("plan_reconciliation_required");
  if (plan.status === "cancelled") throw new Error("plan_cancelled");
  if (plan.status === "executing") throw new Error("plan_already_executing");
  if (Date.parse(plan.expires_at) <= Date.now()) throw new Error("plan_expired");
  const capability = await resolveCapability(plan.capability_id, env);
  if (!capability?.available) throw new Error(`capability_no_longer_available:${capability?.missing.join(",") || "unknown"}`);

  plan.status = "executing";
  await storePlan(plan, env);
  try {
    let result: JsonObject;
    if (TIKTOK_PILOT_WRITE.has(plan.capability_id)) {
      assertTikTokPilotPlan(plan.capability_id, plan.request);
      result = await executeTikTokPilot(plan.capability_id, plan.request, env);
    } else if (plan.capability_id === "tiktok.campaign.create") {
      result = await createTikTokCampaignSafe({
        ...plan.request,
        approval_confirmation: "CREATE TIKTOK CAMPAIGN PAUSED",
        idempotency_key: plan.plan_id,
      }, env);
    } else if (plan.capability_id === "tiktok.campaign.update") {
      const payload = object(plan.request.payload);
      const operationStatus = normalize(payload.operation_status).toUpperCase();
      const providerConfirmation = operationStatus === "ENABLE"
        ? "ENABLE TIKTOK CAMPAIGN"
        : operationStatus === "DISABLE"
          ? "PAUSE TIKTOK CAMPAIGN"
          : "UPDATE TIKTOK CAMPAIGN";
      result = await updateTikTokCampaignSafe({
        ...plan.request,
        approval_confirmation: providerConfirmation,
      }, env);
    } else {
      throw new Error("safe_tiktok_execute_router_not_implemented");
    }
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = result;
    await storePlan(plan, env);
    return textToolResult({ plan_id: plan.plan_id, status: plan.status, result });
  } catch (error) {
    plan.status = "reconciliation_required";
    plan.error = error instanceof Error ? error.message : "tiktok_plan_execution_failed";
    await storePlan(plan, env);
    throw error;
  }
}

async function executeShopifyMetafieldPlan(
  plan: StoredPlan,
  confirmation: string,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  if (confirmation !== "EXECUTE MARE PLAN") throw new Error("approval_confirmation_required:EXECUTE MARE PLAN");
  if (plan.status === "completed") return textToolResult({ ok: true, status: "completed", idempotent_replay: true, plan });
  if (plan.status === "failed" || plan.status === "reconciliation_required") throw new Error("plan_reconciliation_required");
  if (plan.status === "cancelled") throw new Error("plan_cancelled");
  if (plan.status === "executing") throw new Error("plan_already_executing");
  if (Date.parse(plan.expires_at) <= Date.now()) throw new Error("plan_expired");
  const capability = await resolveCapability(plan.capability_id, env);
  if (!capability?.available) throw new Error(`capability_no_longer_available:${capability?.missing.join(",") || "unknown"}`);

  plan.status = "executing";
  await storePlan(plan, env);
  try {
    const result = await updateExistingShopifyMetafields(plan.request, env);
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = result;
    await storePlan(plan, env);
    return textToolResult({ plan_id: plan.plan_id, status: plan.status, result });
  } catch (error) {
    plan.status = "reconciliation_required";
    plan.error = error instanceof Error ? error.message : "shopify_metafield_plan_execution_failed";
    await storePlan(plan, env);
    throw error;
  }
}

async function executeShopifySeasonPlan(
  plan: StoredPlan,
  confirmation: string,
  env: SafeBusinessEnv,
): Promise<JsonObject> {
  if (confirmation !== "EXECUTE MARE PLAN") throw new Error("approval_confirmation_required:EXECUTE MARE PLAN");
  if (plan.status === "completed") return textToolResult({ ok: true, status: "completed", idempotent_replay: true, plan });
  if (plan.status === "failed" || plan.status === "reconciliation_required") throw new Error("plan_reconciliation_required");
  if (plan.status === "cancelled") throw new Error("plan_cancelled");
  if (plan.status === "executing") throw new Error("plan_already_executing");
  if (Date.parse(plan.expires_at) <= Date.now()) throw new Error("plan_expired");
  const capability = await resolveCapability(plan.capability_id, env);
  if (!capability?.available) throw new Error(`capability_no_longer_available:${capability?.missing.join(",") || "unknown"}`);

  plan.status = "executing";
  await storePlan(plan, env);
  try {
    const result = await assignMissingShopifyProductSeasons(plan.request, env);
    plan.status = "completed";
    plan.executed_at = new Date().toISOString();
    plan.result_summary = result;
    await storePlan(plan, env);
    return textToolResult({ plan_id: plan.plan_id, status: plan.status, result });
  } catch (error) {
    plan.status = "reconciliation_required";
    plan.error = error instanceof Error ? error.message : "shopify_season_plan_execution_failed";
    await storePlan(plan, env);
    throw error;
  }
}

async function delegateAndReadJson(request: Request, env: SafeBusinessEnv): Promise<{ response: Response; body: JsonObject }> {
  const response = await handleMareBusinessMcpRequest(request, env as any);
  if (!response) throw new Error("business_mcp_handler_not_found");
  let body: JsonObject = {};
  try { body = await response.clone().json() as JsonObject; } catch { body = {}; }
  return { response, body };
}

export async function handleMareBusinessMcpSafeRequest(
  request: Request,
  env: SafeBusinessEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp-business" && url.pathname !== "/mcp-business/health") return null;
  if (url.pathname === "/mcp-business/health" || request.method !== "POST") {
    return handleMareBusinessMcpRequest(request, env as any);
  }

  let rpc: RpcRequest;
  try { rpc = await request.clone().json() as RpcRequest; } catch { return handleMareBusinessMcpRequest(request, env as any); }
  if (rpc.method !== "tools/call") return handleMareBusinessMcpRequest(request, env as any);
  if (!isAuthorized(request, env)) return handleMareBusinessMcpRequest(request, env as any);

  const params = object(rpc.params);
  const toolName = normalize(params.name);
  const args = object(params.arguments);

  try {
    if (toolName === "mare_capabilities") {
      const capabilities = filterCapabilityList(await resolvedCapabilities(env), args);
      return rpcToolResponse(request, rpc.id, textToolResult({ ok: true, generated_at: new Date().toISOString(), capabilities }));
    }

    if (toolName === "mare_describe") {
      const capability = await resolveCapability(normalize(args.capability_id), env);
      return rpcToolResponse(request, rpc.id, capability ? textToolResult({ ok: true, capability }) : toolFailure("capability_not_found"));
    }

    if (toolName === "mare_system_status") {
      const delegated = await delegateAndReadJson(request, env);
      const result = object(delegated.body.result);
      const structured = object(result.structuredContent);
      const providers = object(structured.providers);
      const tiktok = await tiktokSafeAuthorizationStatus(env);
      const capabilities = await resolvedCapabilities(env);
      const permissionsAudit = object(structured.permissions_audit);
      const auditProviders = object(permissionsAudit.providers);
      const legacyTikTokAudit = object(auditProviders.tiktok_ads);
      const reconciledAudit = {
        ...permissionsAudit,
        providers: {
          ...auditProviders,
          tiktok_ads: {
            ...legacyTikTokAudit,
            configured: tiktok.authorized === true,
            status: tiktok.authorized === true ? "marketing_api_bridge_configured" : "awaiting_or_missing_marketing_api_authorization",
            authorization_source: "business_os_kv_authorization_status",
          },
        },
      };
      const payload = {
        ...structured,
        permissions_audit: reconciledAudit,
        capability_counts: {
          total: capabilities.length,
          implemented: capabilities.filter((item) => item.implemented).length,
          configured: capabilities.filter((item) => item.configured).length,
          available: capabilities.filter((item) => item.available).length,
        },
        providers: { ...providers, tiktok },
        hardening: {
          secure_tiktok_oauth_start: true,
          failed_live_plan_replay_blocked: true,
          complete_variant_pagination: true,
          correct_regular_and_sale_price_mapping: true,
          shopify_existing_metafields_first_class: true,
          shopify_missing_season_first_class: true,
          amazon_stock_deferred_readback_reconciliation: true,
          amazon_stock_patch_retry_after_acceptance: false,
        },
      };
      return rpcToolResponse(request, rpc.id, textToolResult(payload));
    }

    if (toolName === "mare_read") {
      const capabilityId = normalize(args.capability_id);
      const requestPayload = object(args.request);
      if (capabilityId === "amazon.catalog.asin.details") {
        const capability=await resolveCapability(capabilityId,env);
        if(!capability?.available) return rpcToolResponse(request,rpc.id,
          toolFailure("capability_not_available",capability));
        return rpcToolResponse(request,rpc.id,
          textToolResult(await readAmazonCatalogASINDetails(requestPayload,env as any)));
      }
      if (capabilityId === "amazon.catalog.exact.match") {
        const capability = await resolveCapability(capabilityId, env);
        if (!capability?.available) return rpcToolResponse(request, rpc.id,
          toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id,
          textToolResult(await readAmazonExactMatchCandidates(requestPayload, env as any)));
      }
      if (capabilityId === "amazon.seller.sku.status") {
        const cap=await resolveCapability(capabilityId,env);
        if(!cap?.available)return rpcToolResponse(request,rpc.id,
          toolFailure("capability_not_available",cap));
        return rpcToolResponse(request,rpc.id,
          textToolResult(await readAmazonMerchantSkuStatuses(requestPayload,env as any)));
      }
      if (capabilityId === "marketplace.shadow.status") {
        return rpcToolResponse(request, rpc.id, textToolResult(await readMarketplaceShadowStatus(env)));
      }
      if (capabilityId === "shopify.catalog.read" || capabilityId === "shopify.catalog.export") {
        return rpcToolResponse(request, rpc.id, textToolResult(await readShopifyCatalogComplete(requestPayload, env)));
      }
      if (capabilityId === "tiktok.authorization.status") {
        return rpcToolResponse(request, rpc.id, textToolResult(await tiktokSafeAuthorizationStatus(env)));
      }
      if (TIKTOK_PILOT_READ.has(capabilityId)) {
        const capability = await resolveCapability(capabilityId, env);
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, textToolResult(await readTikTokPilot(capabilityId, requestPayload, env)));
      }
      if (capabilityId === "tiktok.campaign.read") {
        const capability = await resolveCapability(capabilityId, env);
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, textToolResult(await readTikTokCampaignsSafe(requestPayload, env)));
      }
      if (capabilityId === "amazon.inventory.sync.reconcile") {
        const planId = normalize(requestPayload.plan_id);
        const plan = await loadPlan(planId, env);
        if (plan.capability_id !== AMAZON_STOCK_CAPABILITY_ID) {
          return rpcToolResponse(request, rpc.id, toolFailure("plan_capability_mismatch", plan));
        }
        if (plan.status !== "reconciliation_required") {
          return rpcToolResponse(request, rpc.id, textToolResult({
            ok: true,
            plan_id: plan.plan_id,
            status: plan.status,
            reconciliation_required: false,
            read_only: true,
          }));
        }
        const receipt = object(plan.reconciliation?.receipt);
        if (Object.keys(receipt).length === 0) {
          const observation = await observeHistoricalAmazonStockPlan(plan.request, env as any);
          plan.reconciliation = {
            ...(plan.reconciliation || {}),
            phase: "historical_observation_only",
            historical_submission_reference_available: false,
            retry_patch_allowed: false,
            last_readback: observation,
          };
          await storePlan(plan, env);
          return rpcToolResponse(request, rpc.id, textToolResult({
            plan_id: plan.plan_id,
            plan_status: plan.status,
            reconciliation_closed: false,
            result: observation,
          }));
        }
        const reconciliation = await reconcileAmazonExistingOfferStockSync(receipt, env as any);
        plan.result_summary = reconciliation;
        plan.reconciliation = {
          ...(plan.reconciliation || {}),
          phase: reconciliation.status === "RECONCILED_AND_VERIFIED" ? "verified" : "pending_readback",
          readback_verified: reconciliation.readback_verified === true,
          retry_patch_allowed: false,
          last_readback: reconciliation,
        };
        if (reconciliation.status === "RECONCILED_AND_VERIFIED" && reconciliation.closure_allowed === true) {
          plan.status = "completed";
          plan.executed_at = plan.executed_at || new Date().toISOString();
          plan.error = undefined;
        }
        await storePlan(plan, env);
        return rpcToolResponse(request, rpc.id, textToolResult({
          plan_id: plan.plan_id,
          plan_status: plan.status,
          reconciliation_closed: plan.status === "completed",
          result: reconciliation,
        }));
      }
    }

    if (toolName === "mare_prepare") {
      const capabilityId = normalize(args.capability_id);
      const requestPayload = object(args.request);
      const capability = await resolveCapability(capabilityId, env);
      if (["marketplace.feed.generate", "matrixify.catalog.generate", "tiktok.authorization.start"].includes(capabilityId)) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await completeArtifactPlan(capability, requestPayload, env));
      }
      if (TIKTOK_PILOT_WRITE.has(capabilityId)) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        assertTikTokPilotPlan(capabilityId, requestPayload);
        return rpcToolResponse(request, rpc.id, await prepareTikTokWrite(capability, requestPayload, env));
      }
      if (["tiktok.campaign.create", "tiktok.campaign.update"].includes(capabilityId)) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await prepareTikTokWrite(capability, requestPayload, env));
      }
      if (capabilityId === SHOPIFY_METAFIELD_CAPABILITY_ID) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await prepareShopifyMetafieldWrite(capability, requestPayload, env));
      }
      if (capabilityId === SHOPIFY_SEASON_CAPABILITY_ID) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await prepareShopifySeasonWrite(capability, requestPayload, env));
      }
      if (capabilityId === AMAZON_STOCK_CAPABILITY_ID) {
        if (!capability?.available) return rpcToolResponse(request, rpc.id, toolFailure("capability_not_available", capability));
        return rpcToolResponse(request, rpc.id, await prepareAmazonStockWrite(capability, requestPayload, env));
      }
    }

    if (toolName === "mare_validate") {
      const plan = await loadPlan(normalize(args.plan_id), env);
      if ((TIKTOK_CAPABILITIES.has(plan.capability_id) || TIKTOK_PILOT_WRITE.has(plan.capability_id)) || [SHOPIFY_METAFIELD_CAPABILITY_ID, SHOPIFY_SEASON_CAPABILITY_ID, AMAZON_STOCK_CAPABILITY_ID].includes(plan.capability_id)) {
        const capability = await resolveCapability(plan.capability_id, env);
        return rpcToolResponse(request, rpc.id, textToolResult({
          ok: true,
          plan,
          valid: plan.status === "prepared" && Date.parse(plan.expires_at) > Date.now() && Boolean(capability?.available),
          capability,
          required_confirmation: plan.risk === "live_write" ? "EXECUTE MARE LIVE PLAN" : "EXECUTE MARE PLAN",
          replay_blocked_after_failure: true,
        }));
      }
    }

    if (toolName === "mare_execute") {
      const plan = await loadPlan(normalize(args.plan_id), env);
      if (plan.status === "failed" || plan.status === "reconciliation_required") {
        return rpcToolResponse(request, rpc.id, toolFailure("plan_reconciliation_required", plan));
      }
      if (TIKTOK_PILOT_WRITE.has(plan.capability_id) || ["tiktok.campaign.create", "tiktok.campaign.update"].includes(plan.capability_id)) {
        return rpcToolResponse(request, rpc.id, await executeTikTokPlan(plan, normalize(args.approval_confirmation), env));
      }
      if (plan.capability_id === SHOPIFY_METAFIELD_CAPABILITY_ID) {
        return rpcToolResponse(request, rpc.id, await executeShopifyMetafieldPlan(plan, normalize(args.approval_confirmation), env));
      }
      if (plan.capability_id === SHOPIFY_SEASON_CAPABILITY_ID) {
        return rpcToolResponse(request, rpc.id, await executeShopifySeasonPlan(plan, normalize(args.approval_confirmation), env));
      }
      if (plan.capability_id === AMAZON_STOCK_CAPABILITY_ID) {
        return rpcToolResponse(request, rpc.id, await executeAmazonStockPlan(plan, normalize(args.approval_confirmation), env));
      }
    }
  } catch (error) {
    return rpcToolResponse(request, rpc.id, toolFailure(error instanceof Error ? error.message : "safe_business_runtime_failed"));
  }

  return handleMareBusinessMcpRequest(request, env as any);
}

