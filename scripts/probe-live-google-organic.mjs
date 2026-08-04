const workerUrl = (process.env.WORKER_URL || "https://devidlabel-ai-assistant-backend.devidlabel.workers.dev").replace(/\/$/, "");
const token = process.env.DAILY_PULSE_ACCESS_TOKEN || process.env.GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN || "";

if (!token) {
  console.error("Missing DAILY_PULSE_ACCESS_TOKEN or GOOGLE_ORGANIC_REPORT_ACCESS_TOKEN");
  process.exit(2);
}

async function get(path) {
  const response = await fetch(`${workerUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body = {};
  try {
    body = await response.json();
  } catch {
    throw new Error(`${path} returned invalid JSON (${response.status})`);
  }
  if (!response.ok || body.ok === false) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

function rows(table) {
  return Array.isArray(table?.rows) ? table.rows : [];
}

function firstMetric(table) {
  const candidates = [
    ...(Array.isArray(table?.totals) ? table.totals : []),
    ...(Array.isArray(table?.rows) ? table.rows : []),
  ];
  return candidates[0] || {};
}

const [sites, search, ga4, realtime, pulseHealth] = await Promise.all([
  get("/internal/search-console/sites"),
  get("/internal/search-console/report?timeframe=last_7_days"),
  get("/internal/ga4/report?timeframe=last_7_days"),
  get("/internal/ga4/realtime"),
  get("/internal/daily-pulse/health"),
]);

const configuredSite = sites.sites?.find?.((site) => site.site_url === "sc-domain:devidlabel.com");
if (!configuredSite) throw new Error("Search Console domain property is not visible to the service account");
if (ga4.property_id !== "345407658") throw new Error(`Unexpected GA4 property: ${ga4.property_id}`);
if (pulseHealth.configured?.search_console !== true) throw new Error("Daily Pulse does not report Search Console as configured");
if (pulseHealth.configured?.ga4 !== true) throw new Error("Daily Pulse does not report GA4 as configured");

const pulse = await get("/internal/daily-pulse/report");
if (pulse.last_7_days?.sources?.ga4?.ok !== true) throw new Error("GA4 is not healthy inside Daily Pulse");
if (pulse.search_console?.last_7_days?.ok !== true) throw new Error("Search Console is not healthy inside Daily Pulse");

const ga4Overview = firstMetric(ga4.overview);
const summary = {
  search_console: {
    permission_level: configuredSite.permission_level,
    timeframe: search.timeframe,
    clicks: search.totals?.clicks ?? null,
    impressions: search.totals?.impressions ?? null,
    query_rows: rows(search.queries).length,
    page_rows: rows(search.pages).length,
  },
  ga4: {
    property_id: ga4.property_id,
    timeframe: ga4.timeframe,
    active_users: ga4Overview.activeUsers ?? null,
    sessions: ga4Overview.sessions ?? null,
    ecommerce_purchases: ga4Overview.ecommercePurchases ?? null,
    purchase_revenue: ga4Overview.purchaseRevenue ?? null,
    landing_page_rows: rows(ga4.landing_pages).length,
    source_medium_rows: rows(ga4.source_medium).length,
    realtime_rows: rows(realtime.realtime).length,
  },
  daily_pulse: {
    ga4_yesterday_ok: pulse.yesterday?.sources?.ga4?.ok === true,
    ga4_last_7_days_ok: pulse.last_7_days?.sources?.ga4?.ok === true,
    search_console_last_7_days_ok: pulse.search_console?.last_7_days?.ok === true,
  },
};

console.log(JSON.stringify(summary, null, 2));
