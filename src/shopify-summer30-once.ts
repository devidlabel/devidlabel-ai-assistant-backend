import { shopifyGraphQL, type Env as ShopifyEnv } from "./index.js";

type JsonObject = Record<string, unknown>;

type Summer30Env = ShopifyEnv & {
  SHOPIFY_TOKENS_KV?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  };
};

type Preflight = {
  currentAppInstallation: { accessScopes: Array<{ handle: string }> };
  collectionByHandle: { id: string; title: string; handle: string } | null;
  codeDiscountNodeByCode: { id: string } | null;
};

const PATH = "/internal/ops/summer30-2026-08-08";
const OPERATION_KEY = "DL-SUMMER30-2026-08-08-V1";
const CODE = "SUMMER30";
const COLLECTION_HANDLE = "mc2-saint-barth";
const LOCK_KEY = "ops:summer30:2026-08-08:created";
const GITHUB_REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";

function json(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function loadPreflight(env: Summer30Env): Promise<Preflight> {
  return shopifyGraphQL<Preflight>(env, `
    query Summer30Preflight($handle: String!, $code: String!) {
      currentAppInstallation { accessScopes { handle } }
      collectionByHandle(handle: $handle) { id title handle }
      codeDiscountNodeByCode(code: $code) { id }
    }
  `, { handle: COLLECTION_HANDLE, code: CODE });
}

function summarizePreflight(preflight: Preflight): JsonObject {
  const scopes = preflight.currentAppInstallation.accessScopes.map((scope) => scope.handle);
  return {
    ok: true,
    operation: "summer30",
    phase: "read_only_preflight",
    write_discounts: scopes.includes("write_discounts"),
    read_discounts: scopes.includes("read_discounts"),
    collection_found: Boolean(preflight.collectionByHandle),
    collection: preflight.collectionByHandle ? {
      id: preflight.collectionByHandle.id,
      title: preflight.collectionByHandle.title,
      handle: preflight.collectionByHandle.handle,
    } : null,
    code: CODE,
    code_exists: Boolean(preflight.codeDiscountNodeByCode),
    mutation_performed: false,
  };
}

async function isGitHubRepositoryWriteToken(request: Request): Promise<boolean> {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice(7).trim();
  if (token.length < 20 || token.length > 500) return false;

  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "devidlabel-summer30-one-shot",
      },
    });
    if (!response.ok) return false;
    const body = await response.json() as { full_name?: string; permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
    if (body.full_name !== GITHUB_REPOSITORY) return false;
    return Boolean(body.permissions?.admin || body.permissions?.maintain || body.permissions?.push);
  } catch {
    return false;
  }
}

async function isWriteAuthorized(request: Request): Promise<boolean> {
  if (request.headers.get("X-MARE-Operation-Key") === OPERATION_KEY) return true;
  return isGitHubRepositoryWriteToken(request);
}

export async function handleSummer30Once(request: Request, env: Summer30Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== PATH) return null;

  if (request.method === "GET") {
    try {
      return json(summarizePreflight(await loadPreflight(env)));
    } catch (error) {
      return json({
        ok: false,
        operation: "summer30",
        phase: "read_only_preflight",
        mutation_performed: false,
        reason: error instanceof Error ? error.message.slice(0, 240) : "preflight_failed",
      }, 502);
    }
  }

  if (request.method !== "POST") return json({ ok: false, operation: "summer30", reason: "method_not_allowed" }, 405);
  if (!(await isWriteAuthorized(request))) {
    return json({ ok: false, operation: "summer30", reason: "not_found" }, 404);
  }

  const preflight = await loadPreflight(env);
  const scopes = preflight.currentAppInstallation.accessScopes.map((scope) => scope.handle).sort();
  const hasReadDiscounts = scopes.includes("read_discounts");
  const hasWriteDiscounts = scopes.includes("write_discounts");
  const collection = preflight.collectionByHandle;

  if (!hasWriteDiscounts) {
    return json({
      ok: false,
      operation: "summer30",
      phase: "preflight",
      write_discounts: false,
      read_discounts: hasReadDiscounts,
      collection_found: Boolean(collection),
      code_exists: Boolean(preflight.codeDiscountNodeByCode),
      reason: "write_discounts_not_granted",
    }, 412);
  }
  if (!collection) {
    return json({ ok: false, operation: "summer30", phase: "preflight", write_discounts: true, collection_found: false, reason: "mc2_collection_not_found" }, 412);
  }

  if (preflight.codeDiscountNodeByCode) {
    return json({
      ok: true,
      operation: "summer30",
      phase: "existing",
      write_discounts: true,
      collection_found: true,
      collection: { id: collection.id, title: collection.title, handle: collection.handle },
      code: CODE,
      code_exists: true,
      created_now: false,
      discount_node_id: preflight.codeDiscountNodeByCode.id,
      note: "Existing code detected; no mutation performed to avoid overwriting an unknown merchant configuration.",
    });
  }

  if (env.SHOPIFY_TOKENS_KV) {
    const prior = await env.SHOPIFY_TOKENS_KV.get(LOCK_KEY);
    if (prior) return json({ ok: false, operation: "summer30", phase: "locked", reason: "one_shot_lock_present" }, 409);
  }

  const created = await shopifyGraphQL<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null;
      userErrors: Array<{ field?: string[] | null; code?: string | null; message: string }>;
    };
  }>(env, `
    mutation CreateSummer30($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        codeDiscountNode { id }
        userErrors { field code message }
      }
    }
  `, {
    input: {
      title: "MC2 Saint Barth | SUMMER30 | Agosto 2026",
      code: CODE,
      startsAt: new Date().toISOString(),
      endsAt: "2026-08-17T21:59:59Z",
      context: { all: "ALL" },
      customerGets: {
        value: { percentage: 0.30 },
        items: { collections: { add: [collection.id] } },
      },
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: "69.00" } },
      appliesOncePerCustomer: false,
    },
  });

  const errors = created.discountCodeBasicCreate.userErrors || [];
  if (errors.length || !created.discountCodeBasicCreate.codeDiscountNode) {
    return json({
      ok: false,
      operation: "summer30",
      phase: "create",
      write_discounts: true,
      collection_found: true,
      code: CODE,
      user_errors: errors.map((item) => ({ field: item.field ?? null, code: item.code ?? null, message: item.message })),
      reason: "shopify_discount_create_failed",
    }, 422);
  }

  const nodeId = created.discountCodeBasicCreate.codeDiscountNode.id;
  if (env.SHOPIFY_TOKENS_KV) {
    await env.SHOPIFY_TOKENS_KV.put(LOCK_KEY, JSON.stringify({ node_id: nodeId, created_at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return json({
    ok: true,
    operation: "summer30",
    phase: "created",
    write_discounts: true,
    read_discounts: hasReadDiscounts,
    collection_found: true,
    collection: { id: collection.id, title: collection.title, handle: collection.handle },
    code: CODE,
    code_exists: true,
    created_now: true,
    discount_node_id: nodeId,
    settings: {
      percentage_off: 30,
      minimum_subtotal_eur: 69,
      starts_at: "now",
      ends_at: "2026-08-17T23:59:59+02:00",
      applies_once_per_customer: false,
    },
  });
}
