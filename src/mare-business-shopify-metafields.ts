import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;

type RequestedMetafieldUpdate = {
  owner_id: string;
  namespace: "custom";
  key: string;
  value: string;
};

type ExistingMetafield = {
  id?: string | null;
  namespace?: string | null;
  key?: string | null;
  type?: string | null;
  value?: string | null;
  compareDigest?: string | null;
};

type LookupNode = {
  __typename?: string | null;
  metafield?: ExistingMetafield | null;
} | null;

type LookupData = Record<string, LookupNode>;

type SetMetafieldsData = {
  metafieldsSet?: {
    metafields?: ExistingMetafield[] | null;
    userErrors?: Array<{ field?: string[] | null; message?: string | null; code?: string | null }> | null;
  } | null;
};

const MAX_UPDATES = 25;
const MAX_VALUE_BYTES = 20 * 1024;
const OWNER_ID_PATTERN = /^gid:\/\/shopify\/(Product|ProductVariant)\/\d+$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseUpdates(args: JsonObject): RequestedMetafieldUpdate[] {
  if (!Array.isArray(args.metafields) || args.metafields.length < 1 || args.metafields.length > MAX_UPDATES) {
    throw new Error("invalid_shopify_metafield_update_count");
  }

  const seen = new Set<string>();
  return args.metafields.map((raw, index) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
    const owner_id = normalize(item.owner_id);
    const namespace = normalize(item.namespace);
    const key = normalize(item.key);
    const value = typeof item.value === "string" ? item.value : "";

    if (!OWNER_ID_PATTERN.test(owner_id)) throw new Error(`invalid_shopify_metafield_owner:${index}`);
    if (namespace !== "custom") throw new Error(`shopify_metafield_namespace_not_allowed:${index}`);
    if (!KEY_PATTERN.test(key)) throw new Error(`invalid_shopify_metafield_key:${index}`);
    if (textBytes(value) > MAX_VALUE_BYTES) throw new Error(`shopify_metafield_value_too_large:${index}`);

    const identity = `${owner_id}|${namespace}|${key}`;
    if (seen.has(identity)) throw new Error(`duplicate_shopify_metafield_target:${index}`);
    seen.add(identity);

    return { owner_id, namespace: "custom", key, value };
  });
}

function buildLookupQuery(updates: RequestedMetafieldUpdate[]): { query: string; variables: JsonObject } {
  const definitions: string[] = [];
  const selections: string[] = [];
  const variables: JsonObject = {};

  updates.forEach((item, index) => {
    definitions.push(`$owner${index}:ID!,$namespace${index}:String!,$key${index}:String!`);
    variables[`owner${index}`] = item.owner_id;
    variables[`namespace${index}`] = item.namespace;
    variables[`key${index}`] = item.key;
    selections.push(`m${index}:node(id:$owner${index}){__typename ... on Product{metafield(namespace:$namespace${index},key:$key${index}){id namespace key type value compareDigest}} ... on ProductVariant{metafield(namespace:$namespace${index},key:$key${index}){id namespace key type value compareDigest}}}`);
  });

  return {
    query: `query MareExistingMetafields(${definitions.join(",")}){${selections.join(" ")}}`,
    variables,
  };
}

async function readExistingMetafields(
  updates: RequestedMetafieldUpdate[],
  env: MareBusinessShopifyEnv,
): Promise<Array<{ request: RequestedMetafieldUpdate; owner_type: string; metafield: ExistingMetafield }>> {
  const lookup = buildLookupQuery(updates);
  const data = await shopifyGraphQL<LookupData>(env, lookup.query, lookup.variables);

  return updates.map((request, index) => {
    const node = data[`m${index}`];
    const ownerType = normalize(node?.__typename);
    if (!node || !["Product", "ProductVariant"].includes(ownerType)) {
      throw new Error(`shopify_metafield_owner_not_found:${index}`);
    }
    const metafield = node.metafield || null;
    if (!metafield?.id || !normalize(metafield.type)) {
      throw new Error(`shopify_metafield_must_already_exist:${index}`);
    }
    const digest = normalize(metafield.compareDigest);
    if (!digest) throw new Error(`shopify_metafield_compare_digest_missing:${index}`);
    return { request, owner_type: ownerType, metafield };
  });
}

function safeSnapshot(
  rows: Array<{ request: RequestedMetafieldUpdate; owner_type: string; metafield: ExistingMetafield }>,
): JsonObject[] {
  return rows.map(({ request, owner_type, metafield }) => ({
    owner_id: request.owner_id,
    owner_type,
    namespace: request.namespace,
    key: request.key,
    type: normalize(metafield.type),
    value: typeof metafield.value === "string" ? metafield.value : "",
    compare_digest: normalize(metafield.compareDigest) || null,
    metafield_id: normalize(metafield.id) || null,
  }));
}

export async function updateExistingShopifyMetafields(
  args: JsonObject,
  env: MareBusinessShopifyEnv,
): Promise<JsonObject> {
  const updates = parseUpdates(args);
  const beforeRows = await readExistingMetafields(updates, env);

  const inputs = beforeRows.map(({ request, metafield }) => ({
    ownerId: request.owner_id,
    namespace: request.namespace,
    key: request.key,
    type: normalize(metafield.type),
    value: request.value,
    compareDigest: normalize(metafield.compareDigest),
  }));

  const mutation = `mutation MareSetExistingMetafields($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{id namespace key type value compareDigest} userErrors{field message code}}}`;
  const mutationData = await shopifyGraphQL<SetMetafieldsData>(env, mutation, { metafields: inputs });
  const userErrors = mutationData.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    const safeErrors = userErrors.slice(0, 10).map((error) => ({
      field: error.field || [],
      code: error.code || null,
      message: normalize(error.message).slice(0, 240),
    }));
    throw new Error(`shopify_metafields_set_rejected:${JSON.stringify(safeErrors)}`);
  }

  const afterRows = await readExistingMetafields(updates, env);
  const before = safeSnapshot(beforeRows);
  const after = safeSnapshot(afterRows);

  for (let index = 0; index < updates.length; index += 1) {
    if (after[index]?.value !== updates[index].value) {
      throw new Error(`shopify_metafield_readback_mismatch:${index}`);
    }
  }

  return {
    ok: true,
    operation: "shopify_existing_metafields_update",
    updated_count: updates.length,
    atomic_write: true,
    concurrency_control: "compare_digest_cas",
    read_before_write: true,
    read_after_write: true,
    creation_allowed: false,
    deletion_allowed: false,
    owner_types_allowed: ["Product", "ProductVariant"],
    namespaces_allowed: ["custom"],
    before,
    after,
    rollback: {
      supported: true,
      method: "Call the same capability with the values from before; a fresh compareDigest will be read before rollback.",
    },
  };
}
