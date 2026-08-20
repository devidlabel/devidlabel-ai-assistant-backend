import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;

type SeasonAssignment = {
  product_id: string;
  season_reference: string;
  season_handle: string;
};

type MetaobjectLookup = {
  id?: string | null;
  handle?: string | null;
  type?: string | null;
} | null;

type SeasonMetafield = {
  id?: string | null;
  namespace?: string | null;
  key?: string | null;
  type?: string | null;
  value?: string | null;
  compareDigest?: string | null;
  reference?: MetaobjectLookup;
} | null;

type ProductLookup = {
  __typename?: string | null;
  id?: string | null;
  metafield?: SeasonMetafield;
} | null;

type SetMetafieldsData = {
  metafieldsSet?: {
    metafields?: Array<{
      id?: string | null;
      namespace?: string | null;
      key?: string | null;
      type?: string | null;
      value?: string | null;
      compareDigest?: string | null;
    }> | null;
    userErrors?: Array<{ field?: string[] | null; message?: string | null; code?: string | null }> | null;
  } | null;
};

const MAX_ASSIGNMENTS = 25;
const PRODUCT_ID_PATTERN = /^gid:\/\/shopify\/Product\/\d+$/;
const SEASON_REFERENCE_PATTERN = /^product_feature_season\.([a-z0-9][a-z0-9-]{0,99})$/;
const METAOBJECT_TYPE = "product_feature_season";
const NAMESPACE = "features";
const KEY = "season";
const METAFIELD_TYPE = "metaobject_reference";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseAssignments(args: JsonObject): SeasonAssignment[] {
  if (!Array.isArray(args.assignments) || args.assignments.length < 1 || args.assignments.length > MAX_ASSIGNMENTS) {
    throw new Error("invalid_shopify_season_assignment_count");
  }
  const seen = new Set<string>();
  return args.assignments.map((raw, index) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : {};
    const product_id = normalize(item.product_id);
    const season_reference = normalize(item.season_reference).toLowerCase();
    if (!PRODUCT_ID_PATTERN.test(product_id)) throw new Error(`invalid_shopify_season_product_id:${index}`);
    const match = season_reference.match(SEASON_REFERENCE_PATTERN);
    if (!match) throw new Error(`invalid_shopify_season_reference:${index}`);
    if (seen.has(product_id)) throw new Error(`duplicate_shopify_season_product:${index}`);
    seen.add(product_id);
    return { product_id, season_reference, season_handle: match[1] };
  });
}

async function resolveSeasonMetaobjects(assignments: SeasonAssignment[], env: MareBusinessShopifyEnv): Promise<Map<string, { id: string; handle: string }>> {
  const handles = Array.from(new Set(assignments.map((item) => item.season_handle)));
  const definitions: string[] = [];
  const selections: string[] = [];
  const variables: JsonObject = {};
  handles.forEach((handle, index) => {
    definitions.push(`$h${index}:MetaobjectHandleInput!`);
    variables[`h${index}`] = { type: METAOBJECT_TYPE, handle };
    selections.push(`s${index}:metaobjectByHandle(handle:$h${index}){id handle type}`);
  });
  const query = `query MareResolveSeasonMetaobjects(${definitions.join(",")}){${selections.join(" ")}}`;
  const data = await shopifyGraphQL<Record<string, MetaobjectLookup>>(env, query, variables);
  const result = new Map<string, { id: string; handle: string }>();
  handles.forEach((handle, index) => {
    const row = data[`s${index}`];
    const id = normalize(row?.id);
    const resolvedHandle = normalize(row?.handle);
    const type = normalize(row?.type);
    if (!id || resolvedHandle !== handle || type !== METAOBJECT_TYPE) {
      throw new Error(`shopify_season_metaobject_not_found:${handle}`);
    }
    result.set(handle, { id, handle });
  });
  return result;
}

function buildProductStateQuery(assignments: SeasonAssignment[]): { query: string; variables: JsonObject } {
  const definitions: string[] = [];
  const selections: string[] = [];
  const variables: JsonObject = {};
  assignments.forEach((item, index) => {
    definitions.push(`$p${index}:ID!`);
    variables[`p${index}`] = item.product_id;
    selections.push(`p${index}:node(id:$p${index}){__typename ... on Product{id metafield(namespace:"${NAMESPACE}",key:"${KEY}"){id namespace key type value compareDigest reference{... on Metaobject{id handle type}}}}}`);
  });
  return {
    query: `query MareSeasonState(${definitions.join(",")}){${selections.join(" ")}}`,
    variables,
  };
}

async function readProductSeasonState(assignments: SeasonAssignment[], env: MareBusinessShopifyEnv): Promise<ProductLookup[]> {
  const lookup = buildProductStateQuery(assignments);
  const data = await shopifyGraphQL<Record<string, ProductLookup>>(env, lookup.query, lookup.variables);
  return assignments.map((item, index) => {
    const row = data[`p${index}`];
    if (!row || normalize(row.__typename) !== "Product" || normalize(row.id) !== item.product_id) {
      throw new Error(`shopify_season_product_not_found:${index}`);
    }
    return row;
  });
}

function safeSeasonSnapshot(assignments: SeasonAssignment[], rows: ProductLookup[]): JsonObject[] {
  return assignments.map((item, index) => {
    const metafield = rows[index]?.metafield || null;
    const reference = metafield?.reference || null;
    return {
      product_id: item.product_id,
      namespace: NAMESPACE,
      key: KEY,
      metafield_type: metafield ? normalize(metafield.type) || null : null,
      metafield_id: metafield ? normalize(metafield.id) || null : null,
      compare_digest: metafield ? normalize(metafield.compareDigest) || null : null,
      season_reference: reference?.handle ? `${METAOBJECT_TYPE}.${normalize(reference.handle)}` : null,
      metaobject_id: reference ? normalize(reference.id) || null : null,
    };
  });
}

export async function assignMissingShopifyProductSeasons(
  args: JsonObject,
  env: MareBusinessShopifyEnv,
): Promise<JsonObject> {
  const assignments = parseAssignments(args);
  const resolved = await resolveSeasonMetaobjects(assignments, env);
  const beforeRows = await readProductSeasonState(assignments, env);

  beforeRows.forEach((row, index) => {
    if (row?.metafield) throw new Error(`shopify_season_must_be_missing:${index}`);
  });

  const inputs = assignments.map((item) => {
    const target = resolved.get(item.season_handle);
    if (!target) throw new Error(`shopify_season_metaobject_not_resolved:${item.season_handle}`);
    return {
      ownerId: item.product_id,
      namespace: NAMESPACE,
      key: KEY,
      type: METAFIELD_TYPE,
      value: target.id,
      compareDigest: null,
    };
  });

  const mutation = `mutation MareAssignMissingProductSeason($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{id namespace key type value compareDigest} userErrors{field message code}}}`;
  const mutationData = await shopifyGraphQL<SetMetafieldsData>(env, mutation, { metafields: inputs });
  const userErrors = mutationData.metafieldsSet?.userErrors || [];
  if (userErrors.length) {
    const safeErrors = userErrors.slice(0, 10).map((error) => ({
      field: error.field || [],
      code: error.code || null,
      message: normalize(error.message).slice(0, 240),
    }));
    throw new Error(`shopify_season_assignment_rejected:${JSON.stringify(safeErrors)}`);
  }

  const afterRows = await readProductSeasonState(assignments, env);
  afterRows.forEach((row, index) => {
    const metafield = row?.metafield || null;
    const reference = metafield?.reference || null;
    const target = resolved.get(assignments[index].season_handle);
    if (!metafield || normalize(metafield.type) !== METAFIELD_TYPE) {
      throw new Error(`shopify_season_readback_missing:${index}`);
    }
    if (!target || normalize(reference?.id) !== target.id || normalize(reference?.handle) !== assignments[index].season_handle || normalize(reference?.type) !== METAOBJECT_TYPE) {
      throw new Error(`shopify_season_readback_mismatch:${index}`);
    }
  });

  return {
    ok: true,
    operation: "shopify_assign_missing_product_season",
    assigned_count: assignments.length,
    atomic_write: true,
    concurrency_control: "compare_digest_null_create_if_absent",
    field_allowlist: { owner_type: "Product", namespace: NAMESPACE, key: KEY, type: METAFIELD_TYPE, metaobject_type: METAOBJECT_TYPE },
    overwrite_existing_allowed: false,
    arbitrary_metafield_creation_allowed: false,
    delete_allowed: false,
    read_before_write: true,
    read_after_write: true,
    before: safeSeasonSnapshot(assignments, beforeRows),
    after: safeSeasonSnapshot(assignments, afterRows),
    correction: {
      supported_with_separate_controlled_operation: true,
      automatic_delete_rollback: false,
      note: "This AUTO+LOG capability only fills a missing season. It never overwrites or deletes an existing season value.",
    },
  };
}
