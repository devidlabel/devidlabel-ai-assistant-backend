import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const adapter = readFileSync("src/mare-business-tiktok-safe.ts", "utf8");
const pilot = readFileSync("src/mare-business-tiktok-pilot.ts", "utf8");
const safe = readFileSync("src/mare-business-mcp-safe.ts", "utf8");
const final = readFileSync("src/mare-business-mcp-final.ts", "utf8");
const permissions = readFileSync("src/mare-operations-permissions.ts", "utf8");

for (const capability of [
  "tiktok.adgroup.read", "tiktok.adgroup.create", "tiktok.adgroup.update",
  "tiktok.pixel.existing.read", "tiktok.pilot.reconcile",
  "tiktok.ad.read", "tiktok.ad.create", "tiktok.ad.update",
  "tiktok.creative.video.read", "tiktok.creative.image.read", "tiktok.reporting.read",
]) {
  assert.ok(pilot.includes(capability), capability + " not declared");
}
for (const protection of [
  "tiktok_pilot_advertiser_mismatch", "tiktok_pilot_campaign_mismatch",
  "tiktok_pilot_disable_required", "tiktok_pilot_explicit_daily_budget_required",
  "tiktok_pilot_payload_field_not_allowed", "tiktok_pilot_existing_purchase_pixel_required",
  "tiktok_pilot_campaign_not_verified_disabled", "tiktok_pilot_adgroup_not_verified_disabled",
  "tiktok_pilot_creative_mutation_forbidden", "tiktok_pilot_existing_pixel_not_owned_by_advertiser",
  'operation_status: "DISABLE"', "retry_allowed: false",
]) assert.ok(pilot.includes(protection), "Missing safety rule: " + protection);

assert.ok(adapter.includes("tiktokPilotApi("));
assert.ok(adapter.includes("permitted.includes(requested)"));
assert.ok(adapter.includes('"/report/integrated/get/"'));
assert.ok(safe.includes("tiktokPilotCapabilities(authorized, env)"));
assert.ok(safe.includes("assertTikTokPilotPlan(capabilityId, requestPayload)"));
assert.ok(safe.includes("executeTikTokPilot(plan.capability_id, { ...plan.request, idempotency_key: plan.plan_id }, env)"));
assert.ok(safe.includes("TIKTOK_PILOT_READ.has(capabilityId)"));
assert.ok(safe.includes("observeTikTokPilotPlan(plan.capability_id, plan.request, plan.plan_id, env)"));
assert.ok(safe.includes("TIKTOK_PILOT_WRITE.has(plan.capability_id)"));
assert.ok(safe.includes('authorization_source: "business_os_kv_authorization_status"'));
assert.ok(safe.includes('approval_confirmation: "CREATE TIKTOK CAMPAIGN PAUSED"'));
assert.ok(final.includes('coordinatorAction(env, planId, "claim")'));
assert.ok(!pilot.includes("/pixel/create/"));
assert.ok(!pilot.includes("/file/video/ad/upload/"));
assert.ok(!pilot.includes("ENABLE"));
assert.ok(permissions.includes("const tiktokConfigured = bool(env.TIKTOK_ACCESS_TOKEN)"));
console.log("TikTok Courmayeur Pilot contract and safety checks passed");
