import { handleRequest } from "./index";

type WorkerEnv = Parameters<typeof handleRequest>[1];
type WorkerExecutionContext = NonNullable<Parameters<typeof handleRequest>[2]>;

function normalizeShopifyOrigin(env: WorkerEnv): string {
  const domain = env.SHOPIFY_SHOP_DOMAIN
    ?.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();

  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) return "";
  return `https://${domain}`;
}

function addShopifyPreviewCors(response: Response, request: Request, env: WorkerEnv): Response {
  const requestOrigin = (request.headers.get("Origin") || "").trim().toLowerCase();
  if (!requestOrigin) return response;

  const existingAllowedOrigin = (response.headers.get("Access-Control-Allow-Origin") || "").trim().toLowerCase();
  if (existingAllowedOrigin === requestOrigin) return response;

  const shopifyOrigin = normalizeShopifyOrigin(env);
  if (!shopifyOrigin || requestOrigin !== shopifyOrigin) return response;

  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", requestOrigin);
  headers.set("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const response = await handleRequest(request, env, context);
    return addShopifyPreviewCors(response, request, env);
  },
};

export { addShopifyPreviewCors, normalizeShopifyOrigin };
