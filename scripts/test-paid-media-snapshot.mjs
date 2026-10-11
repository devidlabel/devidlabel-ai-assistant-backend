import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = join(mkdtempSync(join(tmpdir(), "mare-paid-media-")), "snapshot.mjs");
await build({
  entryPoints: ["src/paid-media-snapshot.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
const { schedulePaidMediaSnapshot, refreshPaidMediaSnapshot, handlePaidMediaSnapshotRequest } = await import("file://" + output);

function assert(value, description) {
  if (!value) throw new Error(description);
}

const kvData = new Map();
let writes = 0;
const kv = {
  async get(key) { return kvData.get(key) || null; },
  async put(key, value, options) {
    assert(options.expirationTtl >= 86400, "snapshots must have retention");
    kvData.set(key, value);
    writes++;
  },
};
const env = {
  SHOPIFY_TOKENS_KV: kv,
  DAILY_PULSE_ACCESS_TOKEN: "snapshot-secret",
  META_REPORT_ACCESS_TOKEN: "meta-report-secret",
  META_ADS_ACCESS_TOKEN: "meta-read-secret",
  META_AD_ACCOUNT_ID: "843613162004896",
  GOOGLE_ADS_REPORT_ACCESS_TOKEN: "google-report-secret",
  GOOGLE_ADS_CLIENT_ID: "client",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_DEVELOPER_TOKEN: "developer",
  GOOGLE_ADS_CUSTOMER_ID: "9429975153",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "3414479537",
  GOOGLE_ADS_API_VERSION: "v25",
};

let providerCalls = 0;
let googleBroken = false;
globalThis.fetch = async (request, init = {}) => {
  const url = new URL(String(request));
  providerCalls++;
  if (url.hostname === "oauth2.googleapis.com") {
    return new Response(JSON.stringify({ access_token: "temporary-token" }), { status: 200 });
  }
  if (url.hostname === "graph.facebook.com") {
    return new Response(JSON.stringify({ data: [{
      account_id: "843613162004896",
      campaign_id: "100",
      campaign_name: "Meta sales",
      spend: "35",
      impressions: "2000",
      clicks: "45",
      actions: [{ action_type: "purchase", value: "2" }],
      action_values: [{ action_type: "purchase", value: "120" }],
    }] }), { status: 200 });
  }
  if (url.hostname === "googleads.googleapis.com") {
    if (googleBroken) return new Response(JSON.stringify({ error: "permission_denied" }), { status: 403 });
    return new Response(JSON.stringify([{
      results: [{
        campaign: { id: "200", name: "PMax" },
        metrics: {
          costMicros: "45000000", impressions: "4500", clicks: "64",
          conversions: 3, conversionsValue: 150,
        },
      }],
    }]), { status: 200 });
  }
  return new Response("not_found", { status: 404 });
};

const first = new Date("2026-10-11T05:05:00Z"); // 07:05 CEST
await schedulePaidMediaSnapshot(env, first);
const key = "mare/paid-media/v1/2026-10-10";
const stored = JSON.parse(kvData.get(key));
assert(stored.ok && stored.combined.complete, "both ads sources should be complete");
assert(stored.date === "2026-10-10", "reporting date must be Europe/Rome yesterday");
assert(stored.combined.paid_media_spend_meta_google === 80, "Meta + Google spend must be €80");
assert(stored.sources.meta.conversions === 2, "Meta purchase actions should aggregate");
assert(stored.sources.google.conversion_value === 150, "Google conversion value should aggregate");
assert(stored.sources.meta.campaigns.length === 1 && stored.sources.google.campaigns.length === 1, "retain campaign summaries");
assert(!JSON.stringify(stored).includes("meta-read-secret"), "no provider tokens stored");
const before = providerCalls;
await schedulePaidMediaSnapshot(env, new Date("2026-10-11T05:20:00Z"));
assert(providerCalls === before, "successful daily snapshot must be idempotent");
await schedulePaidMediaSnapshot(env, new Date("2026-10-11T05:45:00Z"));
assert(providerCalls === before, "out-of-slot cron should not query providers");

const denied = await handlePaidMediaSnapshotRequest(new Request("https://worker.test/internal/paid-media/snapshot?date=2026-10-10"), env);
assert(denied?.status === 401, "snapshot must require bearer");
const allowed = await handlePaidMediaSnapshotRequest(new Request("https://worker.test/internal/paid-media/snapshot?date=2026-10-10", {
  headers: { Authorization: "Bearer snapshot-secret" },
}), env);
assert(allowed?.status === 200, "authorized daily snapshot should be accessible");
assert((await allowed.json()).combined.paid_media_spend_meta_google === 80, "snapshot readback must match KV");

googleBroken = true;
const failed = await refreshPaidMediaSnapshot(env, "2026-10-09");
assert(failed.ok === false && failed.sources.google.spend === null, "failed Google API cannot turn into zero spend");
assert(failed.combined.paid_media_spend_meta_google === null, "partial media spend must be null");
assert(failed.combined.missing_sources.includes("google"), "missing source must be explicit");
googleBroken = false;
const recovered = await refreshPaidMediaSnapshot(env, "2026-10-09");
assert(recovered.ok === true && recovered.combined.complete === true, "retry should recover");
assert(recovered.combined.paid_media_spend_meta_google === 80, "recovered spend should be correct");

assert(writes === 3, "only one successful snapshot and two deliberate refreshes should write KV");
console.log("Cloudflare paid-media snapshots: schedule, auth, spend, recovery and fail-closed tests passed.");
