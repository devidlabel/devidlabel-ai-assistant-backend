import { strict as assert } from "node:assert";
import { build } from "esbuild";

// Import the REAL production TypeScript, bundled in memory. No live network or credentials.
async function load(path) {
  const buildResult = await build({
    entryPoints: [path], platform: "node", bundle: true, format: "esm",
    write: false, outdir: "/tmp/mare-tiktok-test", logLevel: "silent",
  });
  const source = buildResult.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
}
const { tiktokPilotApi, updateTikTokCampaignSafe } = await load("src/mare-business-tiktok-safe.ts");
const { assertTikTokPilotPlan, readTikTokPilot, executeTikTokPilot, observeTikTokPilotPlan, tiktokPilotCapabilities } = await load("src/mare-business-tiktok-pilot.ts");
const advertiserId = "7502001151039258640";
const campaignId = "1879657422391810";
const pixelId = "D7SRMKRC77U8CRB30MM0";
const marker = "MARE-9c6f027ed55e4b1f";
const authorization = JSON.stringify({
  access_token: "synthetic-not-a-real-secret",
  advertiser_id: advertiserId, advertiser_ids: [advertiserId], updated_at: "2026-10-21T00:00:00Z",
});
const env = {
  TIKTOK_ADVERTISER_ID: advertiserId,
  TIKTOK_PILOT_MIN_DAILY_BUDGET: "21",
  TIKTOK_PILOT_MAX_DAILY_BUDGET: "35",
  TIKTOK_PILOT_ADVERTISER_CURRENCY: "EUR",
  TIKTOK_PILOT_ADGROUP_SCHEMA_VERIFIED: "true",
  TIKTOK_PILOT_AD_SCHEMA_VERIFIED: "true",
  TIKTOK_PILOT_ALLOWED_LANDING_HOST: "devidlabel.com",
  SHOPIFY_TOKENS_KV: { async get(k) { return k === "mare-business:tiktok:authorization" ? authorization : null; } },
};
function ok(data) { return { code: 0, message: "OK", data }; }
function fail(code, message) { return { code, message, data: {} }; }
let calls = [], fixture;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const body = init.method === "POST" ? JSON.parse(init.body) : null;
  calls.push({ path: u.pathname, method: init.method, params: u.searchParams, body });
  assert.equal(u.hostname, "business-api.tiktok.com", "Requests must be confined to official API host");
  assert.equal(init.headers["Access-Token"], "synthetic-not-a-real-secret");
  const response = fixture(u.pathname, body, u.searchParams);
  return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
};
function reset(handler) { calls = []; fixture = handler; }
const readCapability = tiktokPilotCapabilities(true, env).find(x => x.id === "tiktok.pixel.existing.read");
for (const capabilityId of ["tiktok.advertiser.info.read", "tiktok.adgroup.quota.read", "tiktok.pixel.event.stats.read"]) {
  assert.equal(tiktokPilotCapabilities(true, env).find(x => x.id === capabilityId)?.available, true);
}
assert.equal(readCapability?.available, true);
const blockedWrites = tiktokPilotCapabilities(true, { ...env, TIKTOK_PILOT_ADGROUP_SCHEMA_VERIFIED: "" });
assert.equal(blockedWrites.find(x => x.id === "tiktok.adgroup.create")?.available, false);
assert.equal(blockedWrites.find(x => x.id === "tiktok.reporting.read")?.available, true);

function mock(path, body) {
  if (path.endsWith("/campaign/get/")) return ok({ list: [{ campaign_id: campaignId, advertiser_id: advertiserId, operation_status: "DISABLE", budget_mode: "BUDGET_MODE_INFINITE" }], page_info: { total_page: 1 } });
  if (path.endsWith("/advertiser/info/")) return ok({ list: [{ advertiser_id: advertiserId, currency: "EUR" }] });
  if (path.endsWith("/pixel/list/")) return ok({ list: [{ pixel_id: pixelId, pixel_name: "Existing Shopify Pixel" }] });
  if (path.endsWith("/pixel/event/stats/")) return ok({ list: [{pixel_id:pixelId,events:[{event:"CompletePayment",count:3}]}] });
  if (path.endsWith("/adgroup/quota/")) return ok({quota:100, available_quota:84});
  if (path.endsWith("/adgroup/get/")) return ok({ list: [], page_info: { total_page: 1 } });
  if (path.endsWith("/adgroup/create/")) return ok({ adgroup_id: "1879657422391811", operation_status: "DISABLE" });
  return fail(40001, "unexpected_mock_call");
}
const groupRequest = {
  advertiser_id: advertiserId,
  payload: {
    campaign_id: campaignId, adgroup_name: "Courmayeur test",
    billing_event: "OCPM", optimization_goal: "CONVERT",
    pacing: "PACING_MODE_SMOOTH", schedule_type: "SCHEDULE_FROM_NOW",
    schedule_start_time: "2026-10-22 10:00:00",
    budget_mode: "BUDGET_MODE_DAY", budget: 25,
    pixel_id: pixelId, optimization_event: "COMPLETE_PAYMENT",
    operation_status: "DISABLE",
  },
};
function throwsPlan(partial, fragment) {
  assert.throws(() => assertTikTokPilotPlan("tiktok.adgroup.create", {
    ...groupRequest, payload: { ...groupRequest.payload, ...partial },
  }), new RegExp(fragment));
}
assertTikTokPilotPlan("tiktok.adgroup.create", groupRequest);
throwsPlan({ budget: 20 }, "explicit_daily_budget_required");
throwsPlan({ budget: 0 }, "explicit_daily_budget_required");
throwsPlan({ budget: -1 }, "explicit_daily_budget_required");
throwsPlan({ budget_mode: "BUDGET_MODE_INFINITE" }, "explicit_daily_budget_required");
throwsPlan({ operation_status: "ENABLE" }, "disable_required");
throwsPlan({ pixel_id: "ANOTHER" }, "existing_purchase_pixel_required");
throwsPlan({ optimization_event: "CLICK" }, "existing_purchase_pixel_required");
throwsPlan({ campaign_id: "111111111" }, "campaign_mismatch");
assert.throws(() => assertTikTokPilotPlan("tiktok.adgroup.update", {
  advertiser_id: advertiserId, payload: { adgroup_id: "1879657422391811", budget: 999, operation_status: "DISABLE" },
}), /payload_field_not_allowed/);

reset(mock);
const accepted = await tiktokPilotApi("GET", "/campaign/get/", { advertiser_id: advertiserId }, env);
assert.equal(accepted.code, 0, "Valid advertiser ID must reach mock API");
for (const invalid of ["1234", "abc", "7502-001151039258640", "  ", "7502001151039258640x", "9".repeat(41)]) {
  const prior = calls.length;
  await assert.rejects(() => tiktokPilotApi("GET", "/campaign/get/", { advertiser_id: invalid }, env), /advertiser_not_authorized/);
  assert.equal(calls.length, prior, "Invalid ID must be rejected before network request");
}
reset(mock);
const accountRead = await readTikTokPilot("tiktok.advertiser.info.read", { advertiser_id: advertiserId }, env);
assert.equal(accountRead.currency, "EUR");
assert.equal(accountRead.read_only, true);
const quotaRead = await readTikTokPilot("tiktok.adgroup.quota.read", { advertiser_id: advertiserId }, env);
assert.equal(quotaRead.read_only, true);
assert.equal(quotaRead.data.available_quota, 84);
const pixelStats = await readTikTokPilot("tiktok.pixel.event.stats.read", {
  advertiser_id: advertiserId, start_date: "2026-10-01", end_date: "2026-10-20",
}, env);
assert.equal(pixelStats.read_only, true);
assert.equal(pixelStats.purchase_event_verified, false, "Mock responses must not be treated as actual events");
await assert.rejects(() => readTikTokPilot("tiktok.pixel.event.stats.read", {
  advertiser_id: advertiserId, start_date: "2026-09-01", end_date: "2026-10-20",
}, env), /pixel_stats_dates_invalid/);
assert.equal(calls.filter(c => c.method === "POST").length, 0);
reset(mock);
assert.deepEqual(await readTikTokPilot("tiktok.pixel.existing.read", {advertiser_id:advertiserId},env),
  {ok:true,pixel_id:pixelId,verified:true,read_only:true});
reset((path, body, params) => {
  if (path.endsWith("/adgroup/get/")) return ok({
    list: [{adgroup_id:"1879657422391811",campaign_id:campaignId,operation_status:"DISABLE"}],
    page_info:{total_page:1},
  });
  return mock(path,body);
});
const once = await executeTikTokPilot("tiktok.adgroup.create", {
  ...groupRequest, idempotency_key: "mbp_6388238d-390d-479d-9c6f-027ed55e4b1f",
}, env);
assert.equal(once.verified_disabled, true);
assert.equal(once.safety.activation_performed, false);
const created = calls.filter(c=>c.path.endsWith("/adgroup/create/"));
assert.equal(created.length, 1);
assert.equal(created[0].body.operation_status, "DISABLE");
assert.equal(created[0].body.pixel_id, pixelId);
assert.equal(created[0].body.budget, 25);
const adCreateRequest = {
  advertiser_id: advertiserId,
  payload: {
    adgroup_id: "1879657422391811",
    creatives: [{
      ad_name: "Courmayeur creative A", video_id: "1879657422391813",
      ad_text: "Courmayeur", landing_page_url: "https://devidlabel.com/products/courmayeur",
      operation_status: "DISABLE",
    }],
    operation_status: "DISABLE",
  },
};
assertTikTokPilotPlan("tiktok.ad.create", adCreateRequest);
assert.throws(() => assertTikTokPilotPlan("tiktok.ad.create", {
  ...adCreateRequest,
  payload: { ...adCreateRequest.payload, creatives: [{ ...adCreateRequest.payload.creatives[0], operation_status: "ENABLE" }] },
}), /disable_required/);
reset((path, body, params) => {
  if (path.endsWith("/adgroup/get/")) return ok({
    list: [{ adgroup_id: "1879657422391811", campaign_id: campaignId, operation_status:"DISABLE" }],
    page_info: { total_page: 1 },
  });
  if (path.endsWith("/file/video/ad/info/")) return ok({ list: [{ video_id:"1879657422391813" }] });
  if (path.endsWith("/ad/get/")) {
    const filtering = JSON.parse(params.get("filtering") || "{}");
    return ok({ list: filtering.ad_ids
      ? [{ ad_id: "1879657422391812", ad_name: "Courmayeur creative A", adgroup_id: "1879657422391811", operation_status: "DISABLE" }]
      : [], page_info: { total_page: 1 } });
  }
  if (path.endsWith("/ad/create/")) return ok({ ad_ids: ["1879657422391812"] });
  return mock(path,body,params);
});
const adReceipt = await executeTikTokPilot("tiktok.ad.create", {
  ...adCreateRequest, idempotency_key:"mbp_6388238d-390d-479d-9c6f-027ed55e4b1f",
}, env);
assert.equal(adReceipt.verified_disabled, true);
const adCalls = calls.filter(c => c.path.endsWith("/ad/create/"));
assert.equal(adCalls.length, 1);
assert.equal(adCalls[0].body.operation_status, undefined, "Top-level status is not part of v1.3 AdCreateBody");
assert.equal(adCalls[0].body.creatives[0].operation_status, "DISABLE", "The creative itself must be disabled");
assert.equal(adCalls[0].body.creatives[0].video_id, "1879657422391813");
reset((path, body, params) => {
  if (path.endsWith("/adgroup/get/")) return ok({
    list: [{ adgroup_id:"1879657422391811", adgroup_name:"Courmayeur test [MARE-9c6f027ed55e4b1f]",
      campaign_id:campaignId, operation_status:"DISABLE" }],
    page_info:{total_page:1},
  });
  return mock(path,body);
});
const replay = await executeTikTokPilot("tiktok.adgroup.create", {
  ...groupRequest, idempotency_key: "mbp_6388238d-390d-479d-9c6f-027ed55e4b1f",
}, env);
assert.equal(replay.idempotent_replay, true);
assert.equal(calls.filter(c=>c.method==="POST").length, 0, "Idempotent replay must not POST");
const observation = await observeTikTokPilotPlan(
  "tiktok.adgroup.create", groupRequest,
  "mbp_6388238d-390d-479d-9c6f-027ed55e4b1f", env,
);
assert.equal(observation.read_only, true);
assert.equal(observation.found, true);
assert.equal(observation.confirmed_disabled, true);
assert.equal(observation.plan_reconciliation_closed, false);
assert.equal(observation.retry_allowed, false);
assert.equal(calls.filter(c=>c.method==="POST").length, 0, "Reconciliation must never mutate TikTok");
reset((path, body) => path.endsWith("/adgroup/create/") ? fail(40100,"Invalid budget") : mock(path,body));
await assert.rejects(() => executeTikTokPilot("tiktok.adgroup.create", {
  ...groupRequest, idempotency_key:"mbp_6388238d-390d-479d-9c6f-027ed55e4b1f",
},env), /tiktok_api_error:Invalid budget/);
assert.equal(calls.filter(c=>c.method==="POST").length, 1, "Provider failure must not auto retry");
reset((path, body) => {
  if (path.endsWith("/adgroup/create/")) return ok({}); // accepted but no reliable receipt
  return mock(path,body);
});
await assert.rejects(() => executeTikTokPilot("tiktok.adgroup.create", {
  ...groupRequest, idempotency_key:"mbp_6388238d-390d-479d-9c6f-027ed55e4b1f",
},env), /provider_receipt_missing_reconciliation_required/);
assert.equal(calls.filter(c=>c.method==="POST").length, 1);
reset(mock);
await assert.rejects(() => executeTikTokPilot("tiktok.adgroup.create", groupRequest, {
  ...env, TIKTOK_PILOT_MAX_DAILY_BUDGET: undefined,
}), /budget_policy_not_verified/);
assert.equal(calls.filter(c=>c.method==="POST").length, 0);
await assert.rejects(() => updateTikTokCampaignSafe({
  advertiser_id: advertiserId,
  approval_confirmation: "ENABLE TIKTOK CAMPAIGN",
  payload: { campaign_id: campaignId, operation_status: "ENABLE" },
},env), /tiktok_pilot_campaign_updates_disabled/);
assert.equal(calls.filter(c=>c.method==="POST").length, 0);

reset((path, body) => path.endsWith("/report/integrated/get/")
  ? ok({list:[{dimensions:{campaign_id:campaignId},metrics:{spend:"0",impressions:"0"}}],page_info:{total_page:1}})
  : mock(path,body));
const report = await readTikTokPilot("tiktok.reporting.read", {
  advertiser_id:advertiserId,level:"campaign",start_date:"2026-10-20",end_date:"2026-10-21",
},env);
assert.equal(report.code,0);
const reportCall = calls.find(c => c.path.endsWith("/report/integrated/get/"));
const reportFiltering = JSON.parse(reportCall.params.get("filtering"));
assert.ok(Array.isArray(reportFiltering));
assert.equal(reportFiltering.length, 1);
assert.equal(reportFiltering[0].field_name, "campaign_ids");
assert.equal(reportFiltering[0].filter_type, "IN");
assert.deepEqual(JSON.parse(reportFiltering[0].filter_value), [Number(campaignId)]);
assert.equal(calls.filter(c=>c.method==="POST").length,0);
globalThis.fetch = originalFetch;
console.log("TikTok functional mocks PASS: advertiser allowlist, Pixel, strict budgets, DISABLE, API failures, no retries, idempotency, reconciliation, campaign activation block, reporting.");
