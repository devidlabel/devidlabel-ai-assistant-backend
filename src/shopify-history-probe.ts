import { shopifyGraphQL } from "./index";

export type ShopifyHistoryProbeEnv = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_API_VERSION?: string;
};

type ProbeData = {
  app: { developerType?: string | null } | null;
  orders: { nodes: Array<{ processedAt: string }> };
};

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

/**
 * PII-free capability probe used only to determine whether the installed Shopify
 * app can see orders older than Shopify's normal 60-day window.
 *
 * It deliberately returns no order IDs, totals, customer data or timestamps.
 */
export async function handleShopifyHistoryProbe(request: Request, env: ShopifyHistoryProbeEnv): Promise<Response | null> {
  const url = new URL(request.url);
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
