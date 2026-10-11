import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const file = join(mkdtempSync(join(tmpdir(), "mare-report-")), "daily-report.mjs");
await build({ entryPoints: ["src/daily-report-snapshot.ts"], outfile: file, bundle: true, platform: "node", target: "node22", format: "esm" });
const { buildDailyReport, scheduleDailyReport, handleDailyReportRequest } = await import("file://" + file);
const assert = (truthy, message) => { if (!truthy) throw new Error(message); };
const kv = new Map();
const env = {
  DAILY_PULSE_ACCESS_TOKEN: "test-secret",
  SHOPIFY_TOKENS_KV: {
    async get(key) { return kv.get(key) || null; },
    async put(key, value, options) { assert(options.expirationTtl > 86400, "TTL required"); kv.set(key, value); },
  },
};
const baseUrl = "https://mare.example/internal/daily-report/report?date=2026-10-10";
const denied = await handleDailyReportRequest(new Request(baseUrl), env);
assert(denied.status === 401, "private report must require bearer");
const missing = await handleDailyReportRequest(new Request(baseUrl, { headers: { Authorization: "Bearer test-secret" } }), env);
assert(missing.status === 404, "missing report should be 404, not synthetic zeros");

const report = {
  ok: true, complete: false, date: "2026-10-10",
  generated_at: "2026-10-11T05:45:00Z",
  source_status: { meta_1d: { ok: false }, google_1d: { ok: true } },
  rendered: { plain: "spesa Meta N/D", html: "<p>spesa Meta N/D</p>" },
};
kv.set("mare/daily-report/v1/2026-10-10", JSON.stringify(report));
const partial = await handleDailyReportRequest(new Request(baseUrl, { headers: { Authorization: "Bearer test-secret" } }), env);
assert(partial.status === 206, "partial reports must be surfaced as 206");
assert((await partial.json()).rendered.plain.includes("N/D"), "show missing data explicitly");
const wrongDate = await handleDailyReportRequest(new Request("https://mare.example/internal/daily-report/report?date=2026-02-31", { headers: { Authorization: "Bearer test-secret" } }), env);
assert(wrongDate.status === 400, "invalid date must be rejected");
const invalidRefresh = await handleDailyReportRequest(new Request("https://mare.example/internal/daily-report/refresh?date=1900-01-01", { method: "POST", headers: { Authorization: "Bearer test-secret" } }), env);
assert(invalidRefresh.status === 400, "unbounded history refresh must be rejected");
const invalid = await buildDailyReport(env, "2026-02-31").catch(e => e.message);
assert(invalid === "invalid_date", "do not query third-party providers for invalid dates");
await scheduleDailyReport(env, new Date("2026-10-11T04:37:00Z"));
assert(kv.size === 1, "cron must be inert outside the intended time slots");
console.log("Cloudflare Daily Business Report: bearer guard, date validation, partial reporting, readback, cron timing tests passed.");
