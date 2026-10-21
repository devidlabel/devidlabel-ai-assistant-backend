import { tiktokPilotApi, type MareBusinessTikTokSafeEnv } from "./mare-business-tiktok-safe.js";

type JsonObject = Record<string, unknown>;
const PILOT_ADVERTISER = "7502001151039258640";
const PILOT_CAMPAIGN = "1879657422391810";
const EXISTING_SHOPIFY_PIXEL = "D7SRMKRC77U8CRB30MM0";
const MIN_USD_ADGROUP_DAILY_BUDGET_EXCLUSIVE = 20;
const WRITE_ALLOWED = new Set(["tiktok.adgroup.create", "tiktok.adgroup.update", "tiktok.ad.create", "tiktok.ad.update"]);
const READ_PATHS: Record<string, string> = {
  "tiktok.adgroup.read": "/adgroup/get/",
  "tiktok.ad.read": "/ad/get/",
  "tiktok.creative.video.read": "/file/video/ad/info/",
  "tiktok.creative.image.read": "/file/image/ad/info/",
};
const LEVELS: Record<string, { level: string; dimension: string }> = {
  campaign: { level: "AUCTION_CAMPAIGN", dimension: "campaign_id" },
  adgroup: { level: "AUCTION_ADGROUP", dimension: "adgroup_id" },
  ad: { level: "AUCTION_AD", dimension: "ad_id" },
};
const METRICS = ["spend", "impressions", "clicks", "conversion", "complete_payment", "complete_payment_roas"];
function obj(v: unknown): JsonObject { return v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {}; }
function str(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function id(v: unknown): boolean { return /^\d{5,40}$/.test(str(v)); }
function positiveBudget(v: unknown): boolean { return typeof v === "number" && Number.isFinite(v) && v > MIN_USD_ADGROUP_DAILY_BUDGET_EXCLUSIVE; }
function assertAdvertiser(v: unknown): void { if (v !== PILOT_ADVERTISER) throw new Error("tiktok_pilot_advertiser_mismatch"); }
function list(v: JsonObject): JsonObject[] {
  const raw = obj(v.data).list;
  return Array.isArray(raw) ? raw.map(obj) : [];
}
async function verifyPilot(request: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<void> {
  assertAdvertiser(request.advertiser_id);
  const response = await tiktokPilotApi("GET", "/campaign/get/", {
    advertiser_id: PILOT_ADVERTISER, page: 1, page_size: 1000, filtering: { campaign_ids: [PILOT_CAMPAIGN] },
  }, env);
  const campaign = list(response).find(item => item.campaign_id === PILOT_CAMPAIGN);
  if (!campaign || campaign.operation_status !== "DISABLE") throw new Error("tiktok_pilot_campaign_not_verified_disabled");
}
async function verifyAdgroup(adgroupId: string, env: MareBusinessTikTokSafeEnv): Promise<void> {
  if (!id(adgroupId)) throw new Error("tiktok_pilot_adgroup_id_required");
  const response = await tiktokPilotApi("GET", "/adgroup/get/", {
    advertiser_id: PILOT_ADVERTISER, filtering: { adgroup_ids: [adgroupId] }, page: 1, page_size: 100,
  }, env);
  const group = list(response).find(row => row.adgroup_id === adgroupId);
  if (!group || group.campaign_id !== PILOT_CAMPAIGN || group.operation_status !== "DISABLE") {
    throw new Error("tiktok_pilot_adgroup_not_verified_disabled");
  }
}
export function tiktokPilotCapabilities(authorized: boolean): JsonObject[] {
  const entries: Array<[string, "read" | "execute", string]> = [
    ["tiktok.adgroup.read", "read", "Read the pilot's existing ad groups"],
    ["tiktok.adgroup.create", "execute", "Create one disabled ad group under the pilot"],
    ["tiktok.adgroup.update", "execute", "Update one disabled pilot ad group without enabling or raising budget"],
    ["tiktok.ad.read", "read", "Read existing pilot ads"],
    ["tiktok.ad.create", "execute", "Create one disabled ad with existing creative references"],
    ["tiktok.ad.update", "execute", "Update one disabled pilot ad without activation"],
    ["tiktok.pixel.existing.read", "read", "Verify existing Shopify Purchase Pixel under advertiser"],
    ["tiktok.pilot.reconcile", "read", "Read-only observation of a failed or uncertain pilot plan"],
    ["tiktok.creative.video.read", "read", "Inspect existing TikTok video assets"],
    ["tiktok.creative.image.read", "read", "Inspect existing TikTok image assets"],
    ["tiktok.reporting.read", "read", "Read performance across campaign, ad group and ad levels"],
  ];
  return entries.map(([capabilityId, operation, description]) => ({
    id: capabilityId, provider: "tiktok", domain: "advertising", operation,
    risk: operation === "execute" ? "live_write" : "read_only",
    implemented: true, configured: authorized, available: authorized,
    approval: operation === "execute" ? "explicit" : "none", description,
    request_schema: { type: "object", properties: {}, additionalProperties: true },
    missing: authorized ? [] : ["TikTok advertiser authorization"],
  }));
}
export function assertTikTokPilotPlan(capability: string, request: JsonObject): void {
  if (!WRITE_ALLOWED.has(capability)) throw new Error("tiktok_pilot_unsupported_write");
  assertAdvertiser(request.advertiser_id);
  const p = obj(request.payload);
  const keys = Object.keys(p);
  const create = capability.endsWith(".create");
  const adgroup = capability.includes(".adgroup.");
  const allowed = adgroup
    ? create
      ? ["campaign_id", "adgroup_name", "promotion_type", "placement_type", "placements", "location_ids", "gender", "age_groups", "budget_mode", "budget", "schedule_type", "schedule_start_time", "schedule_end_time", "billing_event", "optimization_goal", "bid_type", "bid_price", "operation_status", "pixel_id", "optimization_event", "identity_id", "identity_type"]
      : ["adgroup_id", "adgroup_name", "operation_status"]
    : create
      ? ["adgroup_id", "ad_name", "creative", "operation_status"]
      : ["ad_id", "ad_name", "creative", "operation_status"];
  if (!keys.length || keys.some(k => !allowed.includes(k))) throw new Error("tiktok_pilot_payload_field_not_allowed");
  if (p.operation_status !== "DISABLE") throw new Error("tiktok_pilot_disable_required");
  if (create && adgroup) {
    if (p.campaign_id !== PILOT_CAMPAIGN) throw new Error("tiktok_pilot_campaign_mismatch");
    if (!str(p.adgroup_name)) throw new Error("tiktok_pilot_adgroup_name_required");
    if (p.budget_mode !== "BUDGET_MODE_DAY" || !positiveBudget(p.budget)) throw new Error("tiktok_pilot_explicit_daily_budget_required");
    if (p.pixel_id !== EXISTING_SHOPIFY_PIXEL || p.optimization_event !== "COMPLETE_PAYMENT") throw new Error("tiktok_pilot_existing_purchase_pixel_required");
  }
  if (create && !adgroup && !id(p.adgroup_id)) throw new Error("tiktok_pilot_adgroup_id_required");
  if (!create && !id(adgroup ? p.adgroup_id : p.ad_id)) throw new Error("tiktok_pilot_entity_id_required");
  if (p.creative !== undefined) {
    const creative = obj(p.creative);
    if (Object.keys(creative).some(k => /upload|create|pixel|budget|identity|status/i.test(k))) throw new Error("tiktok_pilot_creative_mutation_forbidden");
    if (Object.keys(creative).some(k => !["video_id", "image_ids", "ad_text", "call_to_action", "landing_page_url"].includes(k))) throw new Error("tiktok_pilot_creative_mutation_forbidden");
  }
}
export async function readTikTokPilot(capability: string, request: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  assertAdvertiser(request.advertiser_id);
  if (capability === "tiktok.reporting.read") {
    const level = LEVELS[str(request.level)];
    if (!level) throw new Error("tiktok_pilot_reporting_level_invalid");
    const start = str(request.start_date), end = str(request.end_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error("tiktok_pilot_reporting_dates_invalid");
    if ((Date.parse(end) - Date.parse(start)) / 86400000 > 30) throw new Error("tiktok_pilot_reporting_range_exceeded");
    const result = await tiktokPilotApi("GET", "/report/integrated/get/", {
      advertiser_id: PILOT_ADVERTISER, report_type: "BASIC", service_type: "AUCTION",
      data_level: level.level, dimensions: [level.dimension], metrics: METRICS,
      start_date: start, end_date: end, page: 1, page_size: 1000,
      filtering: { campaign_ids: [PILOT_CAMPAIGN] },
    }, env);
    return { ...result, attribution_warning: "TikTok conversions are platform-attributed; never sum with Shopify orders." };
  }
  if (capability === "tiktok.pixel.existing.read") {
    const result = await tiktokPilotApi("GET", "/pixel/list/", { advertiser_id: PILOT_ADVERTISER, pixel_id: EXISTING_SHOPIFY_PIXEL }, env);
    const data = obj(result.data);
    const pixels = Array.isArray(data.pixels) ? data.pixels.map(obj) : list(result);
    return { ok: true, pixel_id: EXISTING_SHOPIFY_PIXEL, verified: pixels.some(p => p.pixel_id === EXISTING_SHOPIFY_PIXEL), read_only: true };
  }
  const path = READ_PATHS[capability];
  if (!path) throw new Error("tiktok_pilot_read_not_supported");
  if (capability.endsWith(".read") && (capability === "tiktok.adgroup.read" || capability === "tiktok.ad.read")) await verifyPilot(request, env);
  const query: JsonObject = { advertiser_id: PILOT_ADVERTISER, page: 1, page_size: 100 };
  if (capability === "tiktok.adgroup.read") query.filtering = { campaign_ids: [PILOT_CAMPAIGN] };
  else if (capability === "tiktok.ad.read") {
    if (!id(request.adgroup_id)) throw new Error("tiktok_pilot_adgroup_id_required");
    await verifyAdgroup(str(request.adgroup_id), env);
    query.filtering = { adgroup_ids: [request.adgroup_id] };
  } else {
    if (!id(request.file_id)) throw new Error("tiktok_pilot_existing_file_id_required");
    if (capability === "tiktok.creative.video.read") query.video_ids = [request.file_id];
    else query.image_ids = [request.file_id];
  }
  return tiktokPilotApi("GET", path, query, env);
}

async function verifyPixel(env: MareBusinessTikTokSafeEnv): Promise<void> {
  const result = await tiktokPilotApi("GET", "/pixel/list/", {
    advertiser_id: PILOT_ADVERTISER, pixel_id: EXISTING_SHOPIFY_PIXEL, page: 1, page_size: 100,
  }, env);
  const data = obj(result.data);
  const pixels = Array.isArray(data.pixels) ? data.pixels.map(obj) : list(result);
  if (!pixels.some(item => item.pixel_id === EXISTING_SHOPIFY_PIXEL)) {
    throw new Error("tiktok_pilot_existing_pixel_not_owned_by_advertiser");
  }
}
async function verifyBudget(p: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<void> {
  const min = Number(env.TIKTOK_PILOT_MIN_DAILY_BUDGET);
  const max = Number(env.TIKTOK_PILOT_MAX_DAILY_BUDGET);
  const approvedCurrency = str(env.TIKTOK_PILOT_ADVERTISER_CURRENCY).toUpperCase();
  if (!Number.isFinite(min) || min <= MIN_USD_ADGROUP_DAILY_BUDGET_EXCLUSIVE ||
      !Number.isFinite(max) || max < min ||
      !["USD", "EUR"].includes(approvedCurrency)) {
    throw new Error("tiktok_pilot_budget_policy_not_verified");
  }
  const info = await tiktokPilotApi("GET", "/advertiser/info/", {
    advertiser_id: PILOT_ADVERTISER, advertiser_ids: [PILOT_ADVERTISER],
  }, env);
  const account = list(info).find(item => item.advertiser_id === PILOT_ADVERTISER);
  if (!account || str(account.currency).toUpperCase() !== approvedCurrency) {
    throw new Error("tiktok_pilot_account_currency_not_verified");
  }
  if (typeof p.budget !== "number" || p.budget < min || p.budget > max) {
    throw new Error("tiktok_pilot_adgroup_budget_outside_approved_limits");
  }
}
function planMarker(key: unknown): string {
  const clean = str(key).replace(/[^A-Za-z0-9]/g, "");
  if (clean.length < 20) throw new Error("tiktok_pilot_immutable_plan_id_required");
  return "MARE-" + clean.slice(-16);
}
async function verifyCreateIdempotency(
  capability: string, payload: JsonObject, marker: string, env: MareBusinessTikTokSafeEnv,
): Promise<JsonObject | null> {
  const adgroup = capability === "tiktok.adgroup.create";
  const endpoint = adgroup ? "/adgroup/get/" : "/ad/get/";
  const filtering = adgroup ? { campaign_ids: [PILOT_CAMPAIGN] } : { adgroup_ids: [payload.adgroup_id] };
  const response = await tiktokPilotApi("GET", endpoint, {
    advertiser_id: PILOT_ADVERTISER, filtering, page: 1, page_size: 1000,
  }, env);
  const pages = Number(obj(obj(response.data).page_info).total_page);
  if (!Number.isFinite(pages) || pages > 1) throw new Error("tiktok_pilot_idempotency_scan_incomplete");
  const matched = list(response).filter(item =>
    str(adgroup ? item.adgroup_name : item.ad_name).includes("[" + marker + "]"));
  if (matched.length > 1) throw new Error("tiktok_pilot_idempotency_collision_reconciliation_required");
  if (!matched.length) return null;
  const found = matched[0];
  if (found.operation_status !== "DISABLE" || (adgroup && found.campaign_id !== PILOT_CAMPAIGN) ||
     (!adgroup && found.adgroup_id !== payload.adgroup_id)) {
    throw new Error("tiktok_pilot_duplicate_not_verified_disabled");
  }
  return found;
}

export async function executeTikTokPilot(capability: string, request: JsonObject, env: MareBusinessTikTokSafeEnv): Promise<JsonObject> {
  assertTikTokPilotPlan(capability, request);
  await verifyPilot(request, env);
  const payload = obj(request.payload);
  const adgroup = capability.includes(".adgroup.");
  const create = capability.endsWith(".create");
  if (adgroup && create) {
    if (env.TIKTOK_PILOT_ADGROUP_SCHEMA_VERIFIED !== "true") throw new Error("tiktok_pilot_provider_schema_not_verified");
    await verifyBudget(payload, env); await verifyPixel(env);
  }
  if (!adgroup && create && env.TIKTOK_PILOT_AD_SCHEMA_VERIFIED !== "true") {
    throw new Error("tiktok_pilot_ad_schema_not_verified");
  }
  if (adgroup && capability.endsWith(".update")) await verifyAdgroup(str(payload.adgroup_id), env);
  if (!adgroup) {
    if (capability.endsWith(".create")) await verifyAdgroup(str(payload.adgroup_id), env);
    else {
      const response = await tiktokPilotApi("GET", "/ad/get/", {
        advertiser_id: PILOT_ADVERTISER, filtering: { ad_ids: [payload.ad_id] }, page: 1, page_size: 100,
      }, env);
      const ad = list(response).find(row => row.ad_id === payload.ad_id);
      if (!ad || ad.operation_status !== "DISABLE") throw new Error("tiktok_pilot_ad_not_verified_disabled");
      await verifyAdgroup(str(ad.adgroup_id), env);
    }
  }
  const endpoint = adgroup ? "/adgroup/" : "/ad/";
  const action = create ? "create" : "update";
  let outgoing = { ...payload, advertiser_id: PILOT_ADVERTISER, operation_status: "DISABLE" };
  let marker: string | undefined;
  if (create) {
    marker = planMarker(request.idempotency_key);
    const existing = await verifyCreateIdempotency(capability, payload, marker, env);
    if (existing) return {
      ok: true, status: "existing_disabled_entity", data: existing, idempotent_replay: true,
      safety: { forced_operation_status: "DISABLE", activation_performed: false, retry_allowed: false, marker },
    };
    const nameField = adgroup ? "adgroup_name" : "ad_name";
    if (!str(payload[nameField])) throw new Error("tiktok_pilot_entity_name_required");
    outgoing = { ...outgoing, [nameField]: (str(payload[nameField]).slice(0, 460) + " [" + marker + "]") };
  }
  // Any failure or uncertain outcome is handled by M.A.R.E. as reconciliation_required; never retry POST.
  const result = await tiktokPilotApi("POST", endpoint + action + "/", outgoing, env);
  const returned = obj(result.data);
  const returnedId = create
    ? str(adgroup ? returned.adgroup_id : returned.ad_id)
    : str(adgroup ? payload.adgroup_id : payload.ad_id);
  if (!id(returnedId)) throw new Error("tiktok_pilot_provider_receipt_missing_reconciliation_required");
  const readback = await tiktokPilotApi("GET", endpoint + "get/", {
    advertiser_id: PILOT_ADVERTISER, filtering: adgroup ? { adgroup_ids: [returnedId] } : { ad_ids: [returnedId] },
    page: 1, page_size: 100,
  }, env);
  const match = list(readback).find(item => (adgroup ? item.adgroup_id : item.ad_id) === returnedId);
  if (!match || match.operation_status !== "DISABLE") throw new Error("tiktok_pilot_readback_unconfirmed_reconciliation_required");
  return {
    ...result, verified_disabled: true, readback: match,
    safety: { forced_operation_status: "DISABLE", activation_performed: false,
      pilot_campaign_id: PILOT_CAMPAIGN, retry_allowed: false, marker: marker ?? null },
  };
}


/** Never replays a TikTok POST or automatically closes a reconciliation_required plan. */
export async function observeTikTokPilotPlan(
  capability: string, originalRequest: JsonObject, planId: string, env: MareBusinessTikTokSafeEnv,
): Promise<JsonObject> {
  assertAdvertiser(originalRequest.advertiser_id);
  if (!WRITE_ALLOWED.has(capability)) throw new Error("tiktok_pilot_reconciliation_capability_invalid");
  const p = obj(originalRequest.payload);
  await verifyPilot(originalRequest, env);
  if (capability.endsWith(".create")) {
    const marker = planMarker(planId);
    const existing = await verifyCreateIdempotency(capability, p, marker, env);
    return {
      ok: true, read_only: true, plan_id: planId, found: Boolean(existing),
      confirmed_disabled: existing?.operation_status === "DISABLE",
      existing_entity: existing ?? null,
      retry_allowed: false, plan_reconciliation_closed: false,
      manual_review_required: true,
    };
  }
  // Update outcomes require a human to compare the immutable payload and current state.
  return {
    ok: true, read_only: true, plan_id: planId,
    outcome: "unverified_update_requires_manual_review", retry_allowed: false,
    plan_reconciliation_closed: false, manual_review_required: true,
  };
}
