import { shopifyGraphQL } from "./index.js";

type JsonObject = Record<string, unknown>;
type Env = Parameters<typeof shopifyGraphQL>[0];
const PATH = "/internal/ops/torna40-readback-2026-08-19";
const CODE = "TORNA40";

function json(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function handleTorna40Readback190826(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return null;
  if (request.method !== "GET") return json({ ok: false, operation: "torna40_readback", reason: "method_not_allowed" }, 405);
  try {
    const data = await shopifyGraphQL<any>(env, `
      query Torna40Readback($code: String!) {
        codeDiscountNodeByCode(code: $code) {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              appliesOncePerCustomer
              usageLimit
              asyncUsageCount
              combinesWith { orderDiscounts productDiscounts shippingDiscounts }
              minimumRequirement {
                ... on DiscountMinimumSubtotal {
                  greaterThanOrEqualToSubtotal { amount currencyCode }
                }
              }
              customerGets {
                value {
                  ... on DiscountAmount {
                    amount { amount currencyCode }
                    appliesOnEachItem
                  }
                }
              }
              codes(first: 10) { nodes { code } }
            }
          }
        }
      }
    `, { code: CODE });
    const node = data.codeDiscountNodeByCode || null;
    const discount = node?.codeDiscount || null;
    return json({ ok: true, operation: "torna40_readback", code: CODE, exists: Boolean(node), node_id: node?.id || null, discount });
  } catch (error) {
    return json({ ok: false, operation: "torna40_readback", reason: error instanceof Error ? error.message.slice(0, 300) : "readback_failed" }, 502);
  }
}
