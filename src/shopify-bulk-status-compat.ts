import { shopifyGraphQL } from "./index";

type CompatEnv = {
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_API_VERSION?: string;
  SHOPIFY_TOKENS_KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  SHOPIFY_TOKEN_ENCRYPTION_KEY?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
};

type CurrentBulkOperationData = {
  currentBulkOperation?: {
    id: string;
    status: string;
    errorCode?: string | null;
    objectCount?: string;
    rootObjectCount?: string;
    fileSize?: string | null;
    url?: string | null;
    partialDataUrl?: string | null;
    createdAt?: string;
    completedAt?: string | null;
  } | null;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function authorized(request: Request, env: CompatEnv): boolean {
  const expected = (env.SHOPIFY_REPORT_ACCESS_TOKEN || "").trim();
  const header = request.headers.get("Authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!expected || expected.length !== supplied.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}

/**
 * Shopify Admin API versions before 2026-01 don't expose bulkOperation(id:).
 * The store currently uses 2025-10, where currentBulkOperation(type: QUERY)
 * is the supported polling query. The caller still supplies the expected ID;
 * we reject a mismatch instead of accidentally returning another operation.
 */
export async function handleShopifyBulkStatusCompat(request: Request, env: CompatEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/shopify/bulk/status") return null;
  if (request.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!authorized(request, env)) return json({ ok: false, error: "not_found" }, 404);

  const id = (url.searchParams.get("id") || "").trim();
  if (!/^gid:\/\/shopify\/BulkOperation\/\d+$/.test(id)) return json({ ok: false, error: "invalid_bulk_operation_id" }, 400);

  try {
    const data = await shopifyGraphQL<CurrentBulkOperationData>(env, `
      query ShopifyAdvCurrentBulkStatus {
        currentBulkOperation(type: QUERY) {
          id status errorCode objectCount rootObjectCount fileSize url partialDataUrl createdAt completedAt
        }
      }
    `);
    const operation = data.currentBulkOperation || null;
    if (!operation) return json({ ok: false, error: "bulk_operation_not_found" }, 404);
    if (operation.id !== id) {
      return json({
        ok: false,
        error: "bulk_operation_not_current",
        expected_id: id,
        current_id: operation.id,
        current_status: operation.status,
      }, 409);
    }
    return json({ ok: true, schema_version: 1, bulk_operation: operation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.warn("shopify_bulk_status_compat_failed", { reason: message.slice(0, 120) });
    return json({ ok: false, error: "shopify_bulk_status_unavailable" }, 502);
  }
}
