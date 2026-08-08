import { shopifyGraphQL } from "./index";
import { handleMc2Back40Once } from "./shopify-mc2back40-once";

export type ShopifyHistoryProbeEnv = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_API_VERSION?: string;
};

type ProbeData = {
  app: { developerType?: string | null } | null;
  orders: { nodes: Array<{ processedAt: string }> };
};

type PageInfo = { hasNextPage?: boolean; endCursor?: string | null };
type Mc2OrderNode = {
  processedAt: string;
  cancelledAt?: string | null;
  test?: boolean;
  email?: string | null;
  customer?: { email?: string | null } | null;
  lineItems: { nodes: Array<{ vendor?: string | null; product?: { vendor?: string | null } | null }>; pageInfo: PageInfo };
};
type Mc2OrdersData = { orders: { nodes: Mc2OrderNode[]; pageInfo: PageInfo } };

const MC2_PATH = "/internal/ops/mc2back40-cohort-2026-08-08";
const GITHUB_REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const MC2_START = "2025-08-10T00:00:00+02:00";
const MC2_END = "2026-08-09T00:00:00+02:00";
const DORMANT_CUTOFF = "2026-07-10T00:00:00+02:00";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function cutoffIso(days = 60): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/access denied|forbidden|shopify_lookup_forbidden/i.test(message)) return "access_denied";
  if (/unauthorized|401|shopify_lookup_unauthorized/i.test(message)) return "unauthorized";
  if (/429|rate.?limit/i.test(message)) return "rate_limited";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/graphql|query|validation/i.test(message)) return "graphql_error";
  if (/token|auth/i.test(message)) return "auth_unavailable";
  return "upstream_unavailable";
}

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function isGitHubRepositoryWriteToken(token: string): Promise<boolean> {
  if (token.length < 20 || token.length > 500) return false;
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devidlabel-mc2back40-cohort",
      },
    });
    if (!response.ok) return false;
    const body = await response.json() as { full_name?: string; permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
    return body.full_name === GITHUB_REPOSITORY && Boolean(body.permissions?.admin || body.permissions?.maintain || body.permissions?.push);
  } catch {
    return false;
  }
}

function normalizeEmail(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function marketplaceRelay(email: string): boolean {
  const domain = email.split("@")[1] || "";
  return domain.includes("spartoo") || domain.includes("amazon") || domain.includes("miinto") || domain.includes("ebay") || domain.includes("tiktok");
}

function isMc2Vendor(value: string | null | undefined): boolean {
  const normalized = (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalized.includes("mc2") || normalized.includes("saint barth") || normalized.includes("st barth") || normalized.includes("saintbarth");
}

async function hashEmail(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleMc2Back40Probe(request: Request, env: ShopifyHistoryProbeEnv): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ ok: false, operation: "mc2back40_cohort", reason: "method_not_allowed" }, 405);
  if (!(await isGitHubRepositoryWriteToken(bearer(request)))) return jsonResponse({ ok: false, operation: "mc2back40_cohort", reason: "not_found" }, 404);

  try {
    const query = `processed_at:>=${MC2_START} processed_at:<${MC2_END}`;
    const state = new Map<string, { latest_any: string; latest_mc2: string | null; mc2_orders: number }>();
    let after: string | null = null;
    let pages = 0;
    let scanned = 0;
    let truncatedLineItems = 0;

    do {
      const data: Mc2OrdersData = await shopifyGraphQL<Mc2OrdersData>(env, `
        query Mc2Back40Orders($first: Int!, $after: String, $query: String!) {
          orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT) {
            pageInfo { hasNextPage endCursor }
            nodes {
              processedAt cancelledAt test email customer { email }
              lineItems(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes { vendor product { vendor } }
              }
            }
          }
        }
      `, { first: 100, after, query });

      for (const order of data.orders.nodes) {
        scanned += 1;
        if (order.test || order.cancelledAt) continue;
        const email = normalizeEmail(order.email || order.customer?.email);
        if (!email || !email.includes("@") || marketplaceRelay(email)) continue;
        const row = state.get(email) || { latest_any: order.processedAt, latest_mc2: null, mc2_orders: 0 };
        if (order.processedAt > row.latest_any) row.latest_any = order.processedAt;
        const mc2 = order.lineItems.nodes.some((item) => isMc2Vendor(item.vendor) || isMc2Vendor(item.product?.vendor));
        if (order.lineItems.pageInfo.hasNextPage) truncatedLineItems += 1;
        if (mc2) {
          row.mc2_orders += 1;
          if (!row.latest_mc2 || order.processedAt > row.latest_mc2) row.latest_mc2 = order.processedAt;
        }
        state.set(email, row);
      }

      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor || null : null;
      pages += 1;
      if (pages > 120 && after) throw new Error("mc2back40_order_page_limit_reached");
    } while (after);

    const customers: Array<{ email_sha256: string; latest_mc2_order: string; latest_any_order: string; mc2_orders: number; dormant_30d: boolean }> = [];
    for (const [email, row] of state.entries()) {
      if (!row.latest_mc2) continue;
      customers.push({
        email_sha256: await hashEmail(email),
        latest_mc2_order: row.latest_mc2,
        latest_any_order: row.latest_any,
        mc2_orders: row.mc2_orders,
        dormant_30d: row.latest_any < DORMANT_CUTOFF,
      });
    }
    customers.sort((left, right) => right.latest_mc2_order.localeCompare(left.latest_mc2_order));

    return jsonResponse({
      ok: true,
      operation: "mc2back40_cohort",
      data_policy: "sha256_email_only_no_pii",
      timeframe: { start: MC2_START, end_exclusive: MC2_END, dormant_cutoff: DORMANT_CUTOFF },
      orders_scanned: scanned,
      pages_scanned: pages,
      line_item_truncation_warnings: truncatedLineItems,
      unique_direct_customers_in_window: state.size,
      mc2_customers: customers.length,
      mc2_dormant_30d: customers.filter((row) => row.dormant_30d).length,
      customers,
    });
  } catch (error) {
    return jsonResponse({ ok: false, operation: "mc2back40_cohort", error: safeErrorCode(error) }, 503);
  }
}

/**
 * PII-free capability probe used only to determine whether the installed Shopify
 * app can see orders older than Shopify's normal 60-day window.
 */
export async function handleShopifyHistoryProbe(request: Request, env: ShopifyHistoryProbeEnv): Promise<Response | null> {
  const discountResponse = await handleMc2Back40Once(request, env as any);
  if (discountResponse) return discountResponse;

  const url = new URL(request.url);
  if (url.pathname === MC2_PATH) return handleMc2Back40Probe(request, env);
  if (url.pathname !== "/internal/shopify/history-probe") return null;
  if (request.method !== "GET") return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);

  try {
    const data = await shopifyGraphQL<ProbeData>(env, `
      query ShopifyHistoricalAccessProbe {
        app { developerType }
        orders(first: 1, reverse: false, sortKey: PROCESSED_AT) {
          nodes { processedAt }
        }
      }
    `);

    const earliest = data.orders.nodes[0]?.processedAt || null;
    const olderThanSixtyDaysAccessible = earliest
      ? new Date(earliest).getTime() < new Date(cutoffIso()).getTime()
      : null;
    const developerType = (data.app?.developerType || "UNKNOWN").toUpperCase();

    return jsonResponse({
      ok: true,
      service: "shopify_history_access_probe",
      data_policy: "capability_only_no_order_data",
      app_developer_type: developerType,
      merchant_created_app: developerType === "MERCHANT",
      order_sample_present: Boolean(earliest),
      historical_orders_over_60_days_accessible: olderThanSixtyDaysAccessible,
      interpretation: olderThanSixtyDaysAccessible === true
        ? "full_history_visible"
        : olderThanSixtyDaysAccessible === false
          ? "oldest_visible_order_is_within_60_days"
          : "indeterminate_no_visible_orders",
    });
  } catch (error) {
    console.warn("shopify_history_access_probe_error", { category: safeErrorCode(error) });
    return jsonResponse({
      ok: false,
      service: "shopify_history_access_probe",
      data_policy: "capability_only_no_order_data",
      error: safeErrorCode(error),
    }, 503);
  }
}
