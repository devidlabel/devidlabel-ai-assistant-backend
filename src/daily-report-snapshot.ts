import { handleDailyPulseRequest } from "./daily-pulse-organic";
import { shopifyGraphQL } from "./index";
import { handleShopifyAnalyticsReportingRequest } from "./shopify-analytics-reporting";
import { handleShopifyReportingRequest } from "./shopify-reporting";
import { refreshPaidMediaSnapshot } from "./paid-media-snapshot";

type Data = Record<string, any>;
type KV = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
};
type Env = {
  SHOPIFY_TOKENS_KV?: KV;
  DAILY_PULSE_ACCESS_TOKEN?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  MARE_DAILY_REPORT_CRON_ENABLED?: string;
  [key: string]: unknown;
};
type SourceResult = { ok: boolean; status: number; data: Data | null; error: string | null };
const PREFIX = "mare/daily-report/v1/";
const TTL = 45 * 86400;

const normalize = (v: unknown): string => typeof v === "string" ? v.trim() : "";
const asObject = (v: unknown): Data => v && typeof v === "object" && !Array.isArray(v) ? v as Data : {};
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (v: number): number => Math.round(v * 100) / 100;
const optional = (v: unknown): number | null => v === null || v === undefined ? null : round(num(v));
const money = (v: unknown): string => v === null || v === undefined ? "N/D" : new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(num(v));
const number = (v: unknown): string => v === null || v === undefined ? "N/D" : new Intl.NumberFormat("it-IT").format(num(v));
const text = (v: unknown): string => String(v === null || v === undefined ? "N/D" : v);
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
function authorized(request: Request, env: Env): boolean {
  const expected = normalize(env.DAILY_PULSE_ACCESS_TOKEN);
  const auth = request.headers.get("Authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!expected || !got || expected.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function rome(now: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const read = (t: string) => parts.find(p => p.type === t)?.value || "";
  return { date: read("year") + "-" + read("month") + "-" + read("day"), hour: Number(read("hour")), minute: Number(read("minute")) };
}
function yesterday(now: Date): string { return rome(new Date(now.getTime() - 86400000)).date; }
function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T12:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}
function start3(date: string): string {
  const dateObj = new Date(date + "T12:00:00Z");
  dateObj.setUTCDate(dateObj.getUTCDate() - 2);
  return dateObj.toISOString().slice(0, 10);
}
async function invoke(handler: (request: Request, env: any) => Promise<Response | null>, path: string, token: string, env: Env): Promise<SourceResult> {
  if (!token) return { ok: false, status: 503, data: null, error: "missing_internal_report_token" };
  try {
    const response = await handler(new Request("https://mare.internal" + path, { headers: { Authorization: "Bearer " + token } }), env);
    if (!response) return { ok: false, status: 404, data: null, error: "handler_not_found" };
    const data = asObject(await response.json());
    return { ok: response.ok && data.ok === true, status: response.status, data, error: response.ok && data.ok === true ? null : normalize(data.error) || "source_failed" };
  } catch {
    return { ok: false, status: 502, data: null, error: "source_execution_error" };
  }
}
function sourceStatus(value: SourceResult): Data { return { ok: value.ok, status: value.status, error: value.error }; }

async function salesByChannel(env: Env, start: string, end: string): Promise<SourceResult> {
  const query = "FROM sales SHOW orders, gross_sales, discounts, sales_reversals, net_sales, shipping_charges, taxes, total_sales " +
    "GROUP BY sales_channel SINCE " + start + " UNTIL " + end;
  const operation = "query DailyReportSalesReconciliation($query: String!) { shopifyqlQuery(query: $query) { parseErrors tableData { rows } } }";
  try {
    const result = await shopifyGraphQL<{ shopifyqlQuery: { parseErrors: string[]; tableData: { rows: Data[] } | null } }>(
      env as any, operation, { query });
    const table = result.shopifyqlQuery?.tableData;
    if (result.shopifyqlQuery?.parseErrors?.length || !table || !Array.isArray(table.rows)) {
      return { ok: false, status: 502, error: "shopifyql_sales_invalid", data: null };
    }
    const rows = table.rows.map(row => ({
      sales_channel: normalize(row.sales_channel),
      orders: num(row.orders),
      gross_sales: round(num(row.gross_sales)),
      discounts: round(num(row.discounts)),
      reversals: round(num(row.sales_reversals)),
      net_sales: round(num(row.net_sales)),
      total_sales: round(num(row.total_sales)),
    }));
    const direct = rows.filter(row => ["online store", "shop"].includes(row.sales_channel.toLowerCase()));
    const sum = (items: typeof rows, key: keyof typeof rows[number]): number =>
      round(items.reduce((total, row) => total + num(row[key]), 0));
    return { ok: true, status: 200, error: null, data: {
      ok: true, timeframe: { start, end, timezone: "Europe/Rome" }, rows,
      direct: { orders: sum(direct, "orders"), net_sales: sum(direct, "net_sales"),
        total_sales: sum(direct, "total_sales"), gross_sales: sum(direct, "gross_sales") },
      marketplace: rows.filter(row => /channable|amazon|spartoo|tiktok/i.test(row.sales_channel)),
      physical: rows.filter(row => /point of sale|draft/i.test(row.sales_channel)),
    } };
  } catch { return { ok: false, status: 503, error: "shopifyql_sales_unavailable", data: null }; }
}

function checkRange(window: unknown, end: string): boolean {
  const root = asObject(window);
  const range = asObject(root.range);
  return range.end === end;
}

function compose(data: Data): { plain: string; html: string } {
  const date = text(data.date);
  const day = asObject(data.windows?.yesterday);
  const shopify = asObject(day.sources?.shopify);
  const meta = asObject(day.sources?.meta);
  const google = asObject(day.sources?.google);
  const tiktok = asObject(day.sources?.tiktok_ads);
  const metrics = asObject(shopify.metrics);
  const segments = asObject(shopify.segments);
  const metaSpend = optional(meta.totals?.spend);
  const googleSpend = optional(google.totals?.spend);
  const tiktokSpend = optional(tiktok.totals?.spend);
  const advComplete = meta.ok === true && google.ok === true;
  const spendMG = advComplete ? round(num(metaSpend) + num(googleSpend)) : null;
  const allComplete = advComplete && tiktok.ok === true;
  const spendAll = allComplete ? round(num(spendMG) + num(tiktokSpend)) : null;
  const revenue = shopify.ok === true ? optional(metrics.net_merchandise_revenue) : null;
  const merMG = revenue !== null && spendMG !== null && spendMG > 0 ? round(revenue / spendMG) : null;
  const merAll = revenue !== null && spendAll !== null && spendAll > 0 ? round(revenue / spendAll) : null;
  const analytics = asObject(data.shopify_analytics?.yesterday);
  const human = asObject(analytics.totals?.human);
  const bot = asObject(analytics.totals?.bot);
  const last3 = asObject(data.shopify_analytics?.last_3_days);
  const last7 = asObject(data.shopify_analytics?.last_7_days);
  const s3 = asObject(data.shopify_commerce_3d?.data?.metrics);
  const s7 = asObject(data.windows?.last_7_days?.sources?.shopify?.metrics);
  const klaviyo = asObject(day.sources?.klaviyo);
  const ga4 = asObject(day.sources?.ga4);
  const gsc = asObject(data.organic?.search_console);
  const status = asObject(data.source_status);
  const statusLine = Object.keys(status).sort().map(k => k + "=" + (status[k]?.ok ? "OK" : "N/D")).join(" | ");
  const lines = [
    "DEVID LABEL — DAILY BUSINESS REPORT — " + date,
    "Generato: " + data.generated_at + " | Stato: " + (data.complete ? "COMPLETO" : "PARZIALE, controllare fonti N/D"),
    "",
    "VENDITE ECOMMERCE DIRETTO (Online Store + Shop, esclusi POS, Draft e marketplace)",
    "Ordini: " + number(metrics.valid_orders ?? metrics.orders) + " | Netto merce: " + money(revenue) +
      " | Lordo merce: " + money(metrics.gross_merchandise_revenue ?? metrics.gross_sales) +
      " | Sconti: " + money(metrics.discounts),
    "Canali separati: " + (shopify.ok ? JSON.stringify({
      pos: segments.point_of_sale?.metrics || segments.pos?.metrics || null,
      draft: segments.draft_orders_store_proxy?.metrics || null,
      marketplaces: segments.marketplaces?.metrics || null,
    }) : "N/D"),
    "",
    "ADV (spese effettive dai provider, non attribuzioni da sommare a Shopify)",
    "Meta: " + money(metaSpend) + " | Google: " + money(googleSpend) + " | TikTok: " + money(tiktokSpend),
    "Meta+Google: " + money(spendMG) + " | MER M+G: " + (merMG === null ? "N/D" : String(merMG)),
    "ADV totale M+G+TikTok: " + money(spendAll) + " | MER totale: " + (merAll === null ? "N/D" : String(merAll)),
    "",
    "SHOPIFY ANALYTICS — TRAFFICO UMANO E BOT",
    "Sessioni umane 1D: " + (analytics.ok ? number(human.sessions) : "N/D") +
      " | Bot 1D: " + (analytics.ok ? number(bot.sessions) : "N/D"),
    "Conversioni sessioni umane 1D: " + (analytics.ok ? number(human.sessions_that_completed_checkout) : "N/D"),
    "3D sessioni umane: " + (last3.ok ? number(last3.totals?.human?.sessions) : "N/D") +
      " | 7D: " + (last7.ok ? number(last7.totals?.human?.sessions) : "N/D"),
    "Netto merce diretto 3D: " + (data.shopify_commerce_3d?.ok ? money(s3.net_merchandise_revenue) : "N/D") +
      " | 7D: " + (data.windows?.last_7_days?.sources?.shopify?.ok ? money(s7.net_merchandise_revenue) : "N/D"),
    "",
    "KLAVIYO: " + (klaviyo.ok ? "Fonte disponibile; analizzare campagne, flow e ricavi attribuiti separatamente" : "N/D"),
    "GA4: " + (ga4.ok ? "Fonte disponibile (dati di misurazione, non fatturato)" : "N/D"),
    "SEARCH CONSOLE: " + (gsc.ok ? "Fonte disponibile (finestra di dati consolidati, non ieri)" : "N/D"),
    "",
    "QUALITA DATI: " + statusLine,
    "Nota: COGS e profitto netto non sono dichiarati certi senza copertura storica dei costi; POS e marketplace esclusi dal MER.",
  ];
  const plain = lines.join("\n");
  const html = "<!doctype html><html><head><meta charset='utf-8'></head><body style='font-family:Arial,Helvetica,sans-serif;color:#17212b;max-width:820px;margin:auto;padding:20px'>" +
    "<h1 style='font-size:24px'>Devid Label — Daily Business Report</h1><p><b>" + escapeHtml(date) + "</b> — " +
    (data.complete ? "Fonti principali disponibili" : "Report parziale: alcune fonti N/D") + "</p>" +
    plain.split("\n\n").map(section => "<section style='padding:14px 0;border-top:1px solid #ddd'>" +
      section.split("\n").map(line => "<div style='font-size:14px;line-height:1.6'>" + escapeHtml(line) + "</div>").join("") +
      "</section>").join("") + "</body></html>";
  return { plain, html };
}

export async function buildDailyReport(env: Env, date: string, now = new Date()): Promise<Data> {
  if (!validDate(date)) throw new Error("invalid_date");
  if (!env.SHOPIFY_TOKENS_KV) throw new Error("daily_report_kv_missing");
  const token = normalize(env.DAILY_PULSE_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const shopifyToken = normalize(env.SHOPIFY_REPORT_ACCESS_TOKEN) || normalize(env.KLAVIYO_REPORT_ACCESS_TOKEN);
  const shopifyEnv = { ...env, SHOPIFY_REPORT_ACCESS_TOKEN: shopifyToken };
  // MARE's existing protected Daily Pulse supplies commerce, Meta, Google, TikTok,
  // Klaviyo, GA4, Search Console and YouTube in the same provider-approved scopes.
  // ShopifyQL human/bot 1/3/7-day analytics are queried independently as a control.
  const [pulse, commerce3, analytics1, analytics3, analytics7, sales1, sales3, sales7] = await Promise.all([
    invoke(handleDailyPulseRequest, "/internal/daily-pulse/report", token, env),
    invoke(handleShopifyReportingRequest, "/internal/shopify/report?timeframe=custom&start=" + start3(date) + "&end=" + date, shopifyToken, shopifyEnv),
    invoke(handleShopifyAnalyticsReportingRequest, "/internal/shopify-analytics/report?timeframe=custom&start=" + date + "&end=" + date, shopifyToken, shopifyEnv),
    invoke(handleShopifyAnalyticsReportingRequest, "/internal/shopify-analytics/report?timeframe=custom&start=" + start3(date) + "&end=" + date, shopifyToken, shopifyEnv),
    invoke(handleShopifyAnalyticsReportingRequest, "/internal/shopify-analytics/report?timeframe=last_7_days", shopifyToken, shopifyEnv),
    salesByChannel(shopifyEnv, date, date),
    salesByChannel(shopifyEnv, start3(date), date),
    salesByChannel(shopifyEnv, new Date(new Date(date + "T12:00:00Z").getTime() - 6 * 86400000).toISOString().slice(0,10), date),
  ]);
  const yesterdayWindow = asObject(pulse.data?.yesterday);
  const last7Window = asObject(pulse.data?.last_7_days);
  const pulseFresh = pulse.ok && checkRange(yesterdayWindow, date) && checkRange(last7Window, date);
  // Never silently carry forward yesterday's otherwise successful pulse.
  const windows: Data = pulseFresh ? { yesterday: yesterdayWindow, last_7_days: last7Window } : {};
  const shopify1 = asObject(windows.yesterday?.sources?.shopify);
  const meta1 = asObject(windows.yesterday?.sources?.meta);
  const google1 = asObject(windows.yesterday?.sources?.google);
  const klaviyo1 = asObject(windows.yesterday?.sources?.klaviyo);
  const shopify7 = asObject(windows.last_7_days?.sources?.shopify);
  const withExpectedDates = (result: SourceResult, expectedStart: string, expectedEnd: string): SourceResult => {
    if (!result.ok) return result;
    const tf = asObject(result.data?.timeframe);
    if (tf.start === expectedStart && tf.end === expectedEnd) return result;
    return { ok: false, status: 502, error: "source_date_mismatch", data: null };
  };
  const validatedCommerce3 = withExpectedDates(commerce3, start3(date), date);
  const validatedAnalytics1 = withExpectedDates(analytics1, date, date);
  const validatedAnalytics3 = withExpectedDates(analytics3, start3(date), date);
  // Last7 analytics reports should share yesterday's date but may be marked custom in other sources.
  const analytics7End = asObject(analytics7.data?.timeframe).end;
  const validatedAnalytics7 = analytics7.ok && analytics7End === date ? analytics7 :
    { ok: false, status: analytics7.status, error: "source_date_mismatch_or_unavailable", data: null };
  const adminDirect = optional(shopify1.metrics?.net_merchandise_revenue);
  const qlDirect = sales1.ok ? optional(sales1.data?.direct?.net_sales) : null;
  const adminOrderCount = shopify1.ok ? num(shopify1.metrics?.valid_orders) : null;
  const qlOrderCount = sales1.ok ? num(sales1.data?.direct?.orders) : null;
  const reconciliationOk = shopify1.ok === true && sales1.ok &&
    adminDirect !== null && qlDirect !== null &&
    Math.abs(adminDirect - qlDirect) <= 0.5 && adminOrderCount === qlOrderCount;
  const reconciliation: Data = {
    ok: reconciliationOk,
    admin_direct_net: adminDirect,
    shopifyql_direct_net: qlDirect,
    delta_net: adminDirect !== null && qlDirect !== null ? round(adminDirect - qlDirect) : null,
    admin_direct_orders: adminOrderCount,
    shopifyql_direct_orders: qlOrderCount,
    note: reconciliationOk ? "Admin and ShopifyQL direct ecommerce reconcile" :
      "Admin and ShopifyQL disagree or a source is missing: do not publish a certain MER.",
  };
  const core = {
    pulse: { ok: pulseFresh, status: pulse.status, error: pulseFresh ? null : "pulse_unavailable_or_stale" },
    shopify_1d: { ok: shopify1.ok === true },
    shopify_3d: sourceStatus(validatedCommerce3),
    shopify_7d: { ok: shopify7.ok === true },
    shopifyql_1d: sourceStatus(validatedAnalytics1),
    shopifyql_3d: sourceStatus(validatedAnalytics3),
    shopifyql_7d: sourceStatus(validatedAnalytics7),
    sales_1d: sourceStatus(sales1),
    sales_3d: sourceStatus(sales3),
    sales_7d: sourceStatus(sales7),
    ecommerce_reconciled: { ok: reconciliationOk },
    meta_1d: { ok: meta1.ok === true },
    google_1d: { ok: google1.ok === true },
    klaviyo_1d: { ok: klaviyo1.ok === true },
    tiktok_1d: { ok: windows.yesterday?.sources?.tiktok_ads?.ok === true },
    ga4_1d: { ok: windows.yesterday?.sources?.ga4?.ok === true },
    gsc_7d: { ok: pulseFresh && pulse.data?.search_console?.last_7_days?.ok === true },
  };
  const required = ["pulse", "shopify_1d", "shopify_3d", "shopify_7d", "shopifyql_1d", "shopifyql_3d", "shopifyql_7d", "sales_1d", "sales_3d", "sales_7d", "ecommerce_reconciled", "meta_1d", "google_1d", "klaviyo_1d"];
  const missing = required.filter(key => !core[key as keyof typeof core].ok);
  const report: Data = {
    ok: true, complete: missing.length === 0, missing_required_sources: missing, date,
    generated_at: now.toISOString(), timezone: "Europe/Rome",
    delivery: { status: "not_sent_by_worker", reason: "Gmail delivery handled by connected ChatGPT Gmail tool; never infer send success from KV" },
    windows,
    shopify_sales: { yesterday: sales1, last_3_days: sales3, last_7_days: sales7 },
    reconciliation,
    shopify_commerce_3d: validatedCommerce3,
    shopify_analytics: {
      yesterday: validatedAnalytics1.ok ? validatedAnalytics1.data : { ok: false, error: validatedAnalytics1.error },
      last_3_days: validatedAnalytics3.ok ? validatedAnalytics3.data : { ok: false, error: validatedAnalytics3.error },
      last_7_days: validatedAnalytics7.ok ? validatedAnalytics7.data : { ok: false, error: validatedAnalytics7.error },
    },
    organic: { search_console: pulseFresh ? pulse.data?.search_console?.last_7_days : { ok: false } },
    source_status: core,
  };
  report.rendered = compose(report);
  await env.SHOPIFY_TOKENS_KV.put(PREFIX + date, JSON.stringify(report), { expirationTtl: TTL });
  return report;
}

export async function scheduleDailyReport(env: Env, now = new Date()): Promise<void> {
  if (normalize(env.MARE_DAILY_REPORT_CRON_ENABLED).toLowerCase() === "false") return;
  if (!env.SHOPIFY_TOKENS_KV) { console.error("daily_report_missing_kv"); return; }
  const clock = rome(now);
  // The ADV snapshot runs at 07:05/20/35/50; avoid competing invocations.
  const shouldRun = (clock.hour === 7 && [25, 45].includes(clock.minute)) ||
    (clock.hour === 8 && [15, 45].includes(clock.minute)) ||
    (clock.hour >= 9 && clock.hour <= 12 && clock.minute === 15);
  if (!shouldRun) return;
  const date = yesterday(now);
  const existing = await env.SHOPIFY_TOKENS_KV.get(PREFIX + date);
  if (existing) {
    try {
      const previous = JSON.parse(existing) as Data;
      if (previous.date === date && previous.complete === true) return;
    } catch { /* invalid KV record: rebuild */ }
  }
  try {
    const report = await buildDailyReport(env, date, now);
    console.log("daily_report_snapshot", JSON.stringify({ date, complete: report.complete, missing: report.missing_required_sources }));
  } catch {
    console.error("daily_report_snapshot_failed", date);
  }
}

export async function handleDailyReportRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/internal/daily-report/")) return null;
  if (!authorized(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
  if (!env.SHOPIFY_TOKENS_KV) return json({ ok: false, error: "storage_unavailable" }, 503);
  const date = normalize(url.searchParams.get("date")) || yesterday(new Date());
  if (!validDate(date)) return json({ ok: false, error: "invalid_date" }, 400);
  if (url.pathname === "/internal/daily-report/report") {
    if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
    const current = await env.SHOPIFY_TOKENS_KV.get(PREFIX + date);
    if (!current) return json({ ok: false, error: "report_not_ready", date }, 404);
    try {
      const parsed = JSON.parse(current) as Data;
      return json(parsed, parsed.complete === true ? 200 : 206);
    } catch {
      return json({ ok: false, error: "report_corrupt", date }, 502);
    }
  }
  if (url.pathname !== "/internal/daily-report/refresh") return json({ ok: false, error: "not_found" }, 404);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const ageDays = (Date.now() - new Date(date + "T12:00:00Z").getTime()) / 86400000;
  if (ageDays > 45 || ageDays < -1) return json({ ok: false, error: "date_out_of_range" }, 400);
  // Source reads only; state writes limited to MARE's private KV snapshot.
  try {
    const paidKey = "mare/paid-media/v1/" + date;
    if (!await env.SHOPIFY_TOKENS_KV.get(paidKey)) {
      await refreshPaidMediaSnapshot(env, date);
    }
    const report = await buildDailyReport(env, date);
    return json({ ok: true, date, complete: report.complete, missing_required_sources: report.missing_required_sources, generated_at: report.generated_at }, report.complete ? 200 : 206);
  } catch { return json({ ok: false, error: "report_refresh_failed", date }, 503); }
}
