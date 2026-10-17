import { readAmazonMarketplaceParticipations } from "./amazon-readonly";
import type { AmazonCredentials } from "./amazon-auth";

type Env = AmazonCredentials & { ASSISTANT_ADMIN_TOKEN?: string };
function equal(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
export async function handleAmazonReadonlyRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/amazon/marketplaces") return null;
  if (request.method !== "GET") return respond({ ok: false, error: "method_not_allowed" }, 405);
  const header = request.headers.get("Authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!equal(bearer, env.ASSISTANT_ADMIN_TOKEN || "")) return respond({ ok: false, error: "unauthorized" }, 401);
  try {
    const result = await readAmazonMarketplaceParticipations(env);
    return respond({ ok: true, service: "amazon_spapi", read_only: true, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "amazon_read_failed";
    return respond({ ok: false, error: code }, 502);
  }
}
