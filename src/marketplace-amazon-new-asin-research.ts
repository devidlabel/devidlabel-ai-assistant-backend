import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readShopifyCatalogComplete } from "./mare-business-shopify-complete.js";
import { buildAmazonShoesGapReport } from "./marketplace-amazon-shoes-gap-report.js";
import { resolveAmazonListingBrand } from "./marketplace-amazon-listing-brand.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { readAmazonExactMatchCandidates } from "./mare-business-amazon-matching.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Merchant-private, zero-mutation first stage of the NEW-ASIN pipeline.
 *
 * There is deliberately NO Listings Items PUT, feed POST, inventory update,
 * product creation or user-supplied URL. PTD discovery is not publication
 * eligibility, approved brand ownership, GTIN exemption or GPSR proof.
 */
type Row = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Input = Readonly<{ marketplace: Market; sku: string; product_type?: string }>;
type Env = AmazonCredentials & MareBusinessShopifyEnv & { AMAZON_SP_API_SELLER_ID?: string };
export type AmazonNewAsinResearchDependencies = {
  readShopify?: typeof readShopifyCatalogComplete;
  readListing?: typeof readAmazonSellerListingsDirect;
  readCatalogMatch?: typeof readAmazonExactMatchCandidates;
  getAccessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
  clock?: () => number;
};

const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const TYPE_RE = /^[A-Z][A-Z0-9_]{1,79}$/;
const SELLER_RE = /^[A-Z0-9]{8,30}$/;
const EAN_RE = /^\d{13}$/;
const UPC_RE = /^\d{12}$/;
// UPC-A is treated as a distinct identifier. Never pad it into an EAN, and
// never mistake a missing UPC catalog match for permission to publish.
const FIELD_RE = /^[a-z][a-z0-9_]{0,119}$/;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_PRODUCT_TYPES = 100;
const MAX_OUTPUT_TYPES = 15;
const MAX_ATTRIBUTES = 1000;
const TIMEOUT_MS = 20_000;
const FLAGS = Object.freeze({
  read_only: true, provider_mutations: 0,
  has_created_listing: false, can_publish: false,
  can_transfer_writer_ownership: false,
  product_creation_writer_implemented: false,
  full_schema_validated: false,
  brand_authorization_proven: false, gpsr_compliance_proven: false,
  gtin_exemption_proven: false,
});

function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function now(clock: () => number): string {
  const t = clock();
  if (!Number.isSafeInteger(t) || t < 0 || !Number.isFinite(new Date(t).getTime()))
    throw new Error("amazon_new_asin_invalid_clock");
  return new Date(t).toISOString();
}
function validEAN(s: string): boolean {
  if (!EAN_RE.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === Number(s[12]);
}
function validUPC(s:string):boolean {
  if(!UPC_RE.test(s))return false;
  let sum=0;
  for(let i=0;i<11;i++)sum+=Number(s[i])*(i%2===0?3:1);
  return (10-sum%10)%10===Number(s[11]);
}
function validate(raw: unknown): Input {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("amazon_new_asin_invalid_request");
  const values = raw as Row;
  if (Object.keys(values).length < 2 || Object.keys(values).length > 3 ||
      Object.keys(values).some(k => !["marketplace", "sku", "product_type"].includes(k)) ||
      typeof values.marketplace !== "string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES, values.marketplace) ||
      typeof values.sku !== "string" || !SKU_RE.test(values.sku) || values.sku !== values.sku.trim() ||
      (values.product_type !== undefined && (typeof values.product_type !== "string" || !TYPE_RE.test(values.product_type))))
    throw new Error("amazon_new_asin_invalid_request");
  return Object.freeze({
    marketplace: values.marketplace as Market, sku: values.sku,
    ...(typeof values.product_type === "string" ? { product_type: values.product_type } : {}),
  });
}
function blocked(input: Input, at: string, status: string, reason: string, extra: Row = {}): Row {
  return { ok: false, marketplace: input.marketplace, sku: input.sku, observed_at: at,
    status, blocker: reason, ...extra, ...FLAGS };
}
function entries(catalogRaw: unknown, sku: string): {product: Row; variant: Row} | null {
  const catalog = obj(catalogRaw);
  if (catalog.ok !== true || catalog.truncated !== false ||
      catalog.complete_variant_pagination !== true ||
      !Array.isArray(catalog.products) ||
      !Number.isSafeInteger(catalog.product_count) ||
      catalog.product_count !== catalog.products.length ||
      catalog.inline_product_count !== catalog.product_count ||
      catalog.product_count > 50) return null;
  const matches: Array<{product: Row; variant: Row}> = [];
  for (const rawProduct of catalog.products) {
    const product = obj(rawProduct);
    if (!Array.isArray(product.variants)) return null;
    for (const rawVariant of product.variants) {
      const variant = obj(rawVariant);
      if (variant.sku === sku) matches.push({product, variant});
    }
  }
  if(matches.length===1)return matches[0];
  // A merchant may have a zero-stock, UNLISTED historical copy of an ACTIVE
  // K-Way SKU. Never treat it as a second sellable identity, but only when
  // SKU, EAN and brand agree and precisely one ACTIVE variant remains.
  if(sku.startsWith("KWAY_")){
    const active=matches.filter(x=>x.product.status==="ACTIVE"&&
      x.product.vendor==="K-Way");
    if(active.length===1&&
       typeof active[0].variant.barcode==="string"&&
       matches.every(x=>x===active[0]||
         (x.product.vendor==="K-Way"&&
          ["UNLISTED","ARCHIVED"].includes(String(x.product.status))&&
          x.variant.barcode===active[0].variant.barcode&&
          Number.isSafeInteger(x.variant.inventory_quantity)&&
          x.variant.inventory_quantity===0)))
      return active[0];
  }
  return null;
}

function eanUniqueInShopify(catalogRaw: unknown, ean: string, expectedVariantId: unknown): boolean {
  const catalog = obj(catalogRaw);
  if (catalog.ok !== true || catalog.truncated !== false ||
      catalog.complete_variant_pagination !== true ||
      !Array.isArray(catalog.products) ||
      !Number.isSafeInteger(catalog.product_count) ||
      catalog.product_count !== catalog.products.length ||
      catalog.inline_product_count !== catalog.product_count ||
      catalog.product_count > 50 ||
      typeof expectedVariantId !== "string" ||
      !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(expectedVariantId)) return false;
  const records:Array<{product:Row;variant:Row}>=[];
  for(const rawProduct of catalog.products){
    const product=obj(rawProduct);
    if(!Array.isArray(product.variants))return false;
    for(const rawVariant of product.variants){
      const variant=obj(rawVariant);
      if(variant.barcode===ean)records.push({product,variant});
    }
  }
  const selected=records.filter(x=>x.variant.id===expectedVariantId);
  if(selected.length!==1)return false;
  if(records.length===1)return true;
  const main=selected[0];
  if(main.product.status!=="ACTIVE"||main.product.vendor!=="K-Way"||
     typeof main.variant.sku!=="string"||!main.variant.sku.startsWith("KWAY_"))
    return false;
  return records.every(x=>x===main||
    (x.product.vendor==="K-Way"&&
     ["UNLISTED","ARCHIVED"].includes(String(x.product.status))&&
     x.variant.sku===main.variant.sku&&
     x.variant.barcode===main.variant.barcode&&
     Number.isSafeInteger(x.variant.inventory_quantity)&&
     x.variant.inventory_quantity===0));
}

async function readJson(url: string, token: string | null, fetcher: typeof fetch, schemaDocument = false): Promise<Row> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET", headers: token
        ? { "x-amz-access-token": token, Accept: "application/json" }
        : { Accept: "application/json" },
      redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new Error("provider_transport_unverified"); }
  if (response.status !== 200) throw new Error("provider_http_" + response.status);
  const mime = (response.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  // The JSON Schema is a short-lived Amazon-signed object link: its Content-Type
  // is not reliably application/json (as confirmed against live IT PTD).
  // Trust provenance, not arbitrary MIME: schemaDocument is set ONLY for the
  // verified PTD schema URL after strict Amazon-host allowlisting. The bounded
  // body must still decode as JSON and pass structural checks below.
  // Authenticated SP-API metadata calls continue requiring application/json.
  if (!schemaDocument && mime !== "application/json")
    throw new Error("provider_content_type_unverified");
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES)
    throw new Error("provider_payload_too_large");
  if (!response.body) throw new Error("provider_body_missing");
  let bytes = 0;
  const parts: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("provider_payload_too_large");
      parts.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) { raw.set(part, offset); offset += part.length; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("provider_invalid_json");
    return parsed as Row;
  } catch { throw new Error("provider_invalid_json"); }
}
function approvedSchemaUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !(/(^|\.)amazonaws\.com$/.test(url.hostname) ||
        /(^|\.)amazon\.com$/.test(url.hostname))) return null;
  return url.toString();
}
function safeName(value: unknown): string | null {
  return typeof value === "string" && FIELD_RE.test(value) ? value : null;
}
function requiredAttributes(schema: Row): {
  required: string[]; visible: string[]; visibleCount: number; truncated: boolean;
  complex: boolean; structure: "TOP_LEVEL_ATTRIBUTES" | "WRAPPED_ATTRIBUTES";
  staticRequiredDeclared: boolean;
} | null {
  if (schema.type !== "object") return null;
  const rootProperties = obj(schema.properties);
  const wrapped = obj(rootProperties.attributes);
  // Amazon's PTD JSON Schema normally describes listing attributes DIRECTLY
  // under root properties/required. A feed/representation wrapper may place
  // attributes under properties.attributes. Support both, never infer missing
  // conditional requirements from an empty static required array.
  const nested = wrapped.type === "object" &&
    Object.keys(obj(wrapped.properties)).length > 0;
  const holder = nested ? wrapped : schema;
  const props = obj(holder.properties), names = Object.keys(props);
  if (names.length < 1 || names.length > MAX_ATTRIBUTES) return null;
  const declared = Array.isArray(holder.required);
  const required = declared ? holder.required as unknown[] : [];
  if (required.length > MAX_ATTRIBUTES || !required.every(x => safeName(x) !== null))
    return null;
  const visible = names.filter(name => safeName(name) !== null).sort();
  if (visible.length !== names.length) return null;
  const structure = JSON.stringify(schema);
  return {
    required: [...new Set(required as string[])].sort(),
    visible: visible.slice(0, 160), visibleCount: visible.length, truncated: visible.length > 160,
    complex: /"(?:allOf|anyOf|oneOf|if|then|else|\$ref|dependentSchemas)"/.test(structure),
    structure: nested ? "WRAPPED_ATTRIBUTES" : "TOP_LEVEL_ATTRIBUTES",
    staticRequiredDeclared: declared,
  };
}


/** Bounded, read-only structural hint from Amazon's live SHOES PTD.
 * No signed schema URLs, raw schema, product values or inferred enum choices.
 * A shape is an inspection aid, NOT proof that a draft passes PTD conditions. */
function selectedAttributeShapes(schema: Row, names: readonly string[]): Row {
  const root = obj(schema.properties), wrapper = obj(root.attributes);
  const holder = wrapper.type === "object" &&
    Object.keys(obj(wrapper.properties)).length > 0 ? wrapper : schema;
  const attributes = obj(holder.properties);
  if(names.length>20 || names.some(n=>safeName(n)===null))
    return {inspection_blocked:true};
  function shape(node: unknown, depth = 0): Row {
    if (depth > 5) return {truncated: true};
    const value = obj(node), result: Row = {};
    if (typeof value.type === "string" &&
      ["array","object","string","integer","number","boolean","null"].includes(value.type))
      result.type = value.type;
    if (typeof value.$ref === "string") result.reference_resolution_required = true;
    const values = value.enum;
    if (Array.isArray(values) && values.length <= 100 &&
      values.every(v => typeof v === "string" && v.length <= 96 &&
        !/[\u0000-\u001f<>]/.test(v)))
      result.enum = values;
    if (typeof value.pattern === "string" && value.pattern.length <= 200)
      result.pattern = value.pattern;
    if (typeof value.minimum === "number" && Number.isFinite(value.minimum))
      result.minimum = value.minimum;
    if (typeof value.maximum === "number" && Number.isFinite(value.maximum))
      result.maximum = value.maximum;
    if (value.items) result.items = shape(value.items, depth + 1);
    const properties = obj(value.properties), keys = Object.keys(properties);
    if (keys.length > 0) {
      if (keys.length > 40) result.properties_truncated = true;
      else {
        const output: Row = {};
        for (const k of keys) if (safeName(k) !== null)
          output[k] = shape(properties[k], depth + 1);
        result.properties = output;
      }
    }
    if (Array.isArray(value.required) && value.required.length <= 40 &&
      value.required.every(v => safeName(v) !== null))
      result.required = value.required;
    for (const keyword of ["allOf","anyOf","oneOf","if","then","else","dependentSchemas"]) {
      if (value[keyword] !== undefined) result.conditional_review_required = true;
    }
    return result;
  }
  const result: Row = {};
  for (const name of names) if (attributes[name] !== undefined)
    result[name] = shape(attributes[name]);
  return result;
}
/** Read only exact PTD alpha-size wire tokens, not user-facing labels. */
function ptdAlphaSizeTokens(schema:Row):Row {
  const root=obj(schema.properties), wrapper=obj(root.attributes);
  const holder=wrapper.type==="object"&&Object.keys(obj(wrapper.properties)).length>0?
    wrapper:schema;
  const attributes=obj(holder.properties), output:Row={};
  const permitted=["xxs","xs","s","m","l","xl","xxl","xxxl","one_size"];
  for(const field of ["shirt_size","apparel_size","headwear_size"]){
    const attr=obj(attributes[field]), item=obj(attr.items);
    const size=obj(obj(item.properties).size), values=size.enum;
    if(attr.type!=="array"||item.type!=="object"||
       !Array.isArray(values)||values.length>10000||
       values.some(x=>typeof x!=="string"))continue;
    const tokens=permitted.filter(x=>values.includes(x));
    if(tokens.length)output[field]=tokens;
  }
  return output;
}
/** The XL display label can have an opaque PTD wire enum (e.g. x_l).
 * Read paired enum/enumNames from the same Amazon schema; no guessed aliases
 * and no binding across sizes, markets or product types.
 */
function ptdAlphaSizeLabelTokens(schema:Row):Row {
  const root=obj(schema.properties), wrapper=obj(root.attributes);
  const holder=wrapper.type==="object"&&Object.keys(obj(wrapper.properties)).length>0?
    wrapper:schema;
  const attributes=obj(holder.properties), output:Row={};
  for(const field of ["shirt_size","apparel_size","headwear_size"]){
    const attr=obj(attributes[field]), item=obj(attr.items);
    const size=obj(obj(item.properties).size);
    const values=size.enum, labels=size.enumNames;
    if(attr.type!=="array"||item.type!=="object"||
       !Array.isArray(values)||!Array.isArray(labels)||
       values.length!==labels.length||values.length>10000||
       values.some(x=>typeof x!=="string")||
       labels.some(x=>typeof x!=="string"))continue;
    const matches:Row={};
    for(const [merchant,display] of [
      ["XXS",["XXS","XX-Small","2XS"]],
      ["XS",["XS","X-Small","X Small"]],
      ["XL",["XL","X-Large","X Large"]],
      ["XXL",["XXL","XX-Large","2XL"]],
      ["XXXL",["XXXL","3XL","XXX-Large"]]
    ] as const){
      const candidates=values.filter((v,i)=>
        (display as readonly string[]).includes(labels[i])&&/^[a-z][a-z0-9_]{0,63}$/.test(v)&&
        !/^(?:jaspo_|numeric_|go_|age_)/.test(v));
      const unique=[...new Set(candidates)];
      if(unique.length===1)matches[merchant]=unique[0];
    }
    if(Object.keys(matches).length)output[field]=matches;
  }
  return output;
}
const SHOES_INSPECTION_FIELDS=[
  "footwear_size","target_gender","age_range_description","closure",
  "sole_material","inner","outer","leather_type",
  "item_package_weight","item_package_dimensions","list_price",
  "country_of_origin","manufacturer","batteries_required",
  "shaft","height_map","strap_type","style","lifestyle","water_resistance_level",
] as const;
// Read-only marketplace-specific shape inspection. Enum hints must never be
// used as default values or allow creation without complete PTD validation.
const GENERIC_SIZE_INSPECTION_FIELDS=[
  "apparel_size","shirt_size","headwear_size","size_info",
  "footwear_size",
] as const;
// These are *schema* hints only. Merchant Shopify copy, a material facet,
// product vendor or missing shipping weight is not manufacturer/GPSR proof.
// Never send provider values or defaults through this read-only inspection.
const GENERIC_TECHNICAL_INSPECTION_FIELDS=[
  "department","age_range_description","fabric_type","outer","manufacturer",
  "item_package_weight","item_package_dimensions","care_instructions",
  "water_resistance_level","closure","special_size_type","material",
  "item_depth_width_height","number_of_compartments","lining_description",
  "storage_volume","strap_type","fit_type","collar_style","weave_type",
] as const;



/** Deterministic missing-attribute worklist for non-SHOES PTD families.
 * Only source presence is acknowledged. A Shopify title/vendor/GTIN is not
 * an Amazon-valid field value, brand permission, GPSR approval or payload.
 * Unknown conditional requirements always remain unresolved. */
function nonShoesAttributeGapReport(
  product: Row, variant: Row, productType: string, required: string[],
  staticDeclared: boolean, conditional: boolean,
): Row {
  const reportBase = {
    product_type: productType, read_only: true, provider_mutations: 0,
    values_sent_to_amazon: false, product_payload_constructed: false,
    ready_for_validation_preview: false, ready_for_publication: false,
    brand_authorization_proven: false, gpsr_compliance_proven: false,
    schema_checksum_verified: false, full_schema_validated: false,
  };
  if (!staticDeclared || required.length === 0 ||
      required.length > MAX_ATTRIBUTES ||
      required.some(name => !FIELD_RE.test(name)) ||
      new Set(required).size !== required.length ||
      product.status !== "ACTIVE" || typeof variant.sku !== "string" ||
      !variant.sku)
    return {report_status:"BLOCKED_SCHEMA_OR_SOURCE_UNVERIFIED",
      required_attribute_count:0, attributes:[], ...reportBase};
  const sources: Record<string,string> = {};
  if (typeof product.title === "string" && product.title.trim())
    sources.item_name = "product.title";
  if (typeof product.vendor === "string" && product.vendor.trim())
    sources.brand = "product.vendor";
  const barcode = variant.barcode;
  if (typeof barcode === "string" && (validEAN(barcode) || validUPC(barcode)))
    sources.externally_assigned_product_identifier = "variant.barcode";
  const attributes = [...required].sort().map(attribute => ({
    attribute,
    status: Object.hasOwn(sources, attribute) ? "SOURCE_VERIFIED" : "MISSING",
    source_path: sources[attribute] ?? null,
  }));
  const verified = attributes.filter(x => x.status === "SOURCE_VERIFIED").length;
  return {
    report_status:"GAPS_REQUIRE_REVIEW", ...reportBase,
    required_attribute_count:attributes.length, attributes,
    required_status_counts:{SOURCE_VERIFIED:verified,MISSING:attributes.length-verified},
    conditional_requirements_detected:conditional,
    conditional_requirements:conditional ? [{
      attribute:"unmapped_schema_conditions",
      status:"CONDITIONAL_UNRESOLVED",source_path:null,
    }] : [],
    status_semantics:"SOURCE_VERIFIED means Shopify source presence only, not Amazon schema acceptance or authorization",
    technical_values_inferred:false,
  };
}

/** One request, one marketplace, one SKU, optional explicitly selected PTD product type.
 * No request URL, image URL, compliance assertion or product attribute injection. */
export async function researchAmazonNewAsinProductType(
  rawInput: unknown, env: Env, dependencies: AmazonNewAsinResearchDependencies = {},
): Promise<Row> {
  const input = validate(rawInput);
  const at = now(dependencies.clock ?? Date.now);
  if (!SELLER_RE.test(env.AMAZON_SP_API_SELLER_ID || ""))
    return blocked(input, at, "BLOCKED_CONFIG", "seller_identity_not_configured");

  let selected: {product: Row; variant: Row} | null;
  try {
    const catalog = await (dependencies.readShopify ?? readShopifyCatalogComplete)({
      query: 'sku:"' + input.sku + '" status:active,draft,archived,unlisted',
      max_products: 50, inline_limit: 50, include_csv: false,
      stable_order: true, persist_artifacts: false,
    }, env);
    selected = entries(catalog, input.sku);
  } catch { return blocked(input, at, "BLOCKED_SHOPIFY", "shopify_source_unverified"); }
  if (!selected) return blocked(input, at, "BLOCKED_SHOPIFY", "sku_missing_duplicated_or_incomplete");
  const {product, variant} = selected;
  const brand = typeof product.vendor === "string" ? product.vendor : "";
  const brandIdentity = resolveAmazonListingBrand(brand);
  const title = typeof product.title === "string" ? product.title : "";
  const code = typeof variant.barcode === "string" ? variant.barcode : "";
  const quantity = variant.inventory_quantity;
  const identifierType=validEAN(code)?"EAN":validUPC(code)?"UPC":null;
  if (product.status !== "ACTIVE" || brand.toLowerCase() === "p448" ||
      !title || title.length > 200 || !brand || brand.length > 100 ||
      !identifierType || !Number.isSafeInteger(quantity) || (quantity as number) < 0 ||
      ((quantity as number) === 0 &&
       !(input.sku.startsWith("RFR_") && brand === "Refrigiwear") &&
       !(input.sku.startsWith("KWAY_") && brand === "K-Way")) ||
      variant.inventory_tracked !== true || variant.inventory_levels_complete !== true)
    return blocked(input, at, "BLOCKED_SHOPIFY", "active_gtin_stock_or_inventory_unverified");
  const source = {
    product_title: title, brand, amazon_listing_brand: brandIdentity?.amazon_brand ?? null,
    amazon_brand_mapping_source: brandIdentity?.source ?? null,
    brand_authorization_proven: false, shopify_product_type: product.product_type || null,
    ...(identifierType==="EAN"?{ean:code}:{ean:null,upc:code,identifier_type:"UPC"}),
    shopify_available: quantity, has_media: (product.media_count as number) > 0,
    variant_id: variant.id, shopify_price: variant.price ?? null,
  };
  try {
    const barcodeCatalog = await (dependencies.readShopify ?? readShopifyCatalogComplete)({
      query: 'barcode:"' + code + '" status:active,draft,archived,unlisted',
      max_products: 50, inline_limit: 50, include_csv: false,
      stable_order: true, persist_artifacts: false,
    }, env);
    if (!eanUniqueInShopify(barcodeCatalog, code, variant.id))
      return blocked(input, at, "BLOCKED_SHOPIFY", "ean_missing_or_duplicated_in_shopify", {shopify: source});
  } catch {
    return blocked(input, at, "BLOCKED_SHOPIFY", "ean_identity_read_unverified", {shopify: source});
  }
  let listing: Row;
  try {
    const result = obj(await (dependencies.readListing ?? readAmazonSellerListingsDirect)({
      marketplace: input.marketplace, skus: [input.sku],
    }, env));
    if (result.ok !== true || result.marketplace !== input.marketplace ||
        result.provider_mutations !== 0 || result.can_change_stock !== false ||
        !Array.isArray(result.results)) throw new Error("invalid_listing_observation");
    const matches = result.results.map(obj).filter(row => row.sku === input.sku);
    if (matches.length !== 1) throw new Error("ambiguous_listing_observation");
    listing = matches[0];
  } catch { return blocked(input, at, "BLOCKED_AMAZON", "seller_listing_unverified", { shopify: source }); }
  if (listing.state !== "VERIFIED_ABSENT")
    return blocked(input, at, "BLOCKED_AMAZON", "seller_listing_not_proven_absent", {
      shopify: source, seller_listing_state: listing.state,
    });

  let matched: Row;
  try {
    matched = obj(await (dependencies.readCatalogMatch ?? readAmazonExactMatchCandidates)({
      marketplace: input.marketplace, identifier_type: identifierType, identifiers: [code],
    }, env));
  } catch { return blocked(input, at, "BLOCKED_AMAZON", "gtin_catalog_lookup_unverified", {shopify: source}); }
  const results = obj(matched.result);
  const identities = Array.isArray(results.identifiers) ? results.identifiers.map(obj) : [];
  if (matched.ok !== true || results.complete !== true ||
      results.marketplace !== input.marketplace || identities.length !== 1 ||
      identities[0][identifierType==="EAN"?"ean":"upc"] !== code)
    return blocked(input, at, "BLOCKED_AMAZON", "gtin_catalog_lookup_incomplete", {shopify: source});
  const identity = identities[0];
  if (identity.state !== "NO_EXACT_MATCH" || identity.exact_match_count !== 0 ||
      !Array.isArray(identity.asins) || identity.asins.length !== 0)
    return blocked(input, at, "BLOCKED_MATCHING", "existing_or_ambiguous_catalog_candidate", {
      shopify: source, ...(identifierType==="EAN"?{ean_match_state:identity.state}:{upc_match_state:identity.state}),
    });
  const base = {
    marketplace: input.marketplace, sku: input.sku, observed_at: at,
    shopify: source, seller_listing_state: "VERIFIED_ABSENT",
    ...(identifierType==="EAN"?{ean_match_state:"NO_EXACT_MATCH",ean_absence_not_catalog_absence_proof:true}:
      {upc_match_state:"NO_EXACT_MATCH",upc_absence_not_catalog_absence_proof:true}),
    ...FLAGS,
  };

  let token: string;
  try { token = await (dependencies.getAccessToken ?? getAmazonAccessToken)(env); }
  catch { return {ok: false, status: "BLOCKED_AUTH", blocker: "amazon_token_unverified", ...base}; }
  const fetcher = dependencies.fetch ?? fetch;
  const marketId = AMAZON_EU_MARKETPLACES[input.marketplace];
  const searchUrl = new URL(HOST + "/definitions/2020-09-01/productTypes");
  searchUrl.searchParams.set("marketplaceIds", marketId);
  searchUrl.searchParams.set("itemName", title);
  let found: Row;
  try { found = await readJson(searchUrl.toString(), token, fetcher); }
  catch { return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_search_unverified", ...base}; }
  if (!Array.isArray(found.productTypes) || found.productTypes.length > MAX_PRODUCT_TYPES)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_search_invalid", ...base};
  // Item-name recommendations are advisory. Ambiguous sneaker titles such as
  // "PlayNew" and "Violet Lime" have returned SPEAKERS / DRINK_FLAVORED live.
  // A Shopify Sneakers category is a scoped hint, not publication eligibility.
  // Recheck with a separate Amazon product-type keyword search and fail closed.
  function extractTypes(raw: unknown): Array<{name:string; display_name:string}> | null {
    if (!Array.isArray(raw) || raw.length > MAX_PRODUCT_TYPES) return null;
    const choices: Array<{name:string; display_name:string}> = [];
    for (const row of raw) {
      const candidate = obj(row), name = candidate.name;
      if (typeof name !== "string" || !TYPE_RE.test(name) ||
          !Array.isArray(candidate.marketplaceIds) || !candidate.marketplaceIds.includes(marketId))
        continue;
      choices.push({name, display_name:
        typeof candidate.displayName === "string" ? candidate.displayName.slice(0,120) : name});
    }
    return [...new Map(choices.map(c => [c.name, c])).values()];
  }
  let candidates = extractTypes(found.productTypes);
  if (!candidates)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_search_invalid", ...base};
  const sneakers = typeof product.product_type === "string" &&
    product.product_type.trim().toLowerCase() === "sneakers";
  let discoverySource = "AMAZON_ITEM_NAME";
  let titleCategoryConflict = false;
  if (sneakers) {
    const footwear = (choices: Array<{name:string; display_name:string}>) =>
      choices.filter(c => c.name === "SHOES" || c.name === "BOOT");
    const titleFootwear = footwear(candidates);
    if (titleFootwear.length) {
      candidates = titleFootwear;
      discoverySource = "AMAZON_ITEM_NAME_FOOTWEAR";
    } else {
      titleCategoryConflict = candidates.length > 0;
      const keywordUrl = new URL(HOST + "/definitions/2020-09-01/productTypes");
      keywordUrl.searchParams.set("marketplaceIds", marketId);
      keywordUrl.searchParams.set("keywords", "shoes");
      keywordUrl.searchParams.set("searchLocale", "en_US");
      let keywordTypes: Row;
      try { keywordTypes = await readJson(keywordUrl.toString(), token, fetcher); }
      catch {
        return {ok: false, status: "BLOCKED_DEFINITIONS",
          blocker: "sneakers_keyword_search_unverified", ...base};
      }
      const verifiedTypes = extractTypes(keywordTypes.productTypes);
      if (!verifiedTypes)
        return {ok: false, status: "BLOCKED_DEFINITIONS",
          blocker: "sneakers_keyword_search_invalid", ...base};
      candidates = footwear(verifiedTypes);
      if (candidates.length === 0)
        return {ok: false, status: "BLOCKED_DEFINITIONS",
          blocker: "sneakers_footwear_type_not_recommended", ...base};
      discoverySource = "AMAZON_KEYWORDS_SHOPIFY_SNEAKERS";
    }
  }
  // The Shopify product category Calze/Calzini is trustworthy manual category
  // evidence; item-name PTD sometimes returns PANTS or SHOES for actual socks.
  // A second Amazon-verified keyword lookup can yield SOCKS without guessing.
  const isSocks=typeof product.product_type==="string"&&
    ["calze","calzini"].includes(product.product_type.trim().toLowerCase());
  if(isSocks){
    const sockChoices=candidates.filter(c=>c.name==="SOCKS");
    if(sockChoices.length>0){
      candidates=sockChoices;
      discoverySource="AMAZON_ITEM_NAME_SOCKS";
    }else{
      titleCategoryConflict=candidates.length>0;
      const keywordUrl=new URL(HOST+"/definitions/2020-09-01/productTypes");
      keywordUrl.searchParams.set("marketplaceIds",marketId);
      keywordUrl.searchParams.set("keywords","socks");
      keywordUrl.searchParams.set("searchLocale","en_US");
      let keywordTypes:Row;
      try{keywordTypes=await readJson(keywordUrl.toString(),token,fetcher);}
      catch{return {ok:false,status:"BLOCKED_DEFINITIONS",
        blocker:"socks_keyword_search_unverified",...base};}
      const verifiedTypes=extractTypes(keywordTypes.productTypes);
      if(!verifiedTypes)return {ok:false,status:"BLOCKED_DEFINITIONS",
        blocker:"socks_keyword_search_invalid",...base};
      candidates=verifiedTypes.filter(c=>c.name==="SOCKS");
      if(candidates.length===0)return {ok:false,status:"BLOCKED_DEFINITIONS",
        blocker:"socks_product_type_not_recommended",...base};
      discoverySource="AMAZON_KEYWORDS_SHOPIFY_SOCKS";
    }
  }
  // Amazon title suggestions are advisory. Verify COAT through a separate
  // marketplace keyword lookup only for exact Shopify coat category, trusted
  // brand/SKU correspondence, and explicit outerwear title. Never use SWEATER
  // solely because the title-based recommendation suggested it.
  const coatBrand=(product.vendor==="Refrigiwear"&&input.sku.startsWith("RFR_"))?
    "refrigiwear":(product.vendor==="K-Way"&&input.sku.startsWith("KWAY_"))?
    "kway":null;
  const jacket=coatBrand!==null&&product.product_type==="Giacche e cappotti"&&
    input.product_type==="COAT"&&
    /(?:Jacket|Giacca|Bomber|Parka|Gilet|Piumino|Vest)/i.test(String(product.title));
  if(jacket&&!candidates.some(c=>c.name==="COAT")){
    titleCategoryConflict=candidates.length>0;
    const u=new URL(HOST+"/definitions/2020-09-01/productTypes");
    u.searchParams.set("marketplaceIds",marketId);
    u.searchParams.set("keywords","coat");
    u.searchParams.set("searchLocale","en_US");
    let response:Row;
    try{response=await readJson(u.toString(),token,fetcher);}
    catch{return {ok:false,status:"BLOCKED_DEFINITIONS",
      blocker:coatBrand+"_coat_keyword_unverified",...base};}
    const recommended=extractTypes(response.productTypes);
    if(!recommended)return {ok:false,status:"BLOCKED_DEFINITIONS",
      blocker:coatBrand+"_coat_keyword_invalid",...base};
    candidates=recommended.filter(c=>c.name==="COAT");
    if(candidates.length!==1)return {ok:false,status:"BLOCKED_DEFINITIONS",
      blocker:coatBrand+"_coat_keyword_not_recommended",...base};
    discoverySource=coatBrand==="kway"?"AMAZON_KEYWORDS_KWAY_COAT":
      "AMAZON_KEYWORDS_REFRIGIWEAR_COAT";
  }
  // Amazon itemName recommendations can be unrelated to the actual merchandise.
  // Observed live 22 Oct: MC2 Christmas Box in Shopify "Pochette e Borselli"
  // returned ABIS_MUSIC; Sprayground suitcases were mapped to TABLETOP_GAME/
  // APPAREL elsewhere in Catalog Items. Shopify category is evidence for
  // MANUAL taxonomy review, not an Amazon-approved product type.
  const merchantCategory=typeof product.product_type==="string"?
    product.product_type.trim():"";
  const accessoryCategories=new Set([
    "Borse","Borsoni e Valigie","Pochette e Borselli",
    "Zaini","Beauty Case","Cappelli e berretti","Portafogli",
  ]);
  const definitelyUnrelated=new Set([
    "ABIS_MUSIC","SPEAKERS","DRINK_FLAVORED","TABLETOP_GAME",
  ]);
  // Live 23 Oct: Amazon recommended PANTS for Red Sox socks ("Calze").
  // Reject obvious socks/trousers category inversions; never guess the
  // correct product type or create a listing from title recommendation.
  const sockCategories=new Set(["Calze","Calzini"]);
  const unrelated=accessoryCategories.has(merchantCategory)?
    candidates.filter(c=>definitelyUnrelated.has(c.name)||
      (merchantCategory==="Borsoni e Valigie"&&c.name==="APPAREL")):
    sockCategories.has(merchantCategory)?
      candidates.filter(c=>["PANTS","SHORTS","LEGGINGS","TROUSERS","SHOES","BOOT","SANDAL","SLIPPER"].includes(c.name)):[];
  if(unrelated.length>0){
    titleCategoryConflict=true;
    candidates=candidates.filter(c=>!unrelated.some(u=>u.name===c.name));
    discoverySource="AMAZON_ITEM_NAME_CATEGORY_GUARDED";
  }
  const rejectedTypes=unrelated.map(c=>c.name);
  const unique = candidates;
  const discoveryEvidence = {
    rejected_unrelated_product_type_names:rejectedTypes,
    shopify_category_is_manual_review_evidence_only:true,
    product_type_discovery_source: discoverySource,
    title_category_conflict_detected: titleCategoryConflict,
    seller_selected_product_type_not_automatically_approved: true,
  };
  if (rejectedTypes.length>0 && unique.length===0 && !input.product_type)
    return {ok:true,status:"PRODUCT_TYPE_CATEGORY_REVIEW_REQUIRED",
      product_type_candidates:[],candidates_truncated:false,candidate_count:0,
      next_step:"VERIFY_ACTUAL_PRODUCT_AND_FIND_RELEVANT_AMAZON_PRODUCT_TYPE",
      ...discoveryEvidence,...base};
  if (input.product_type && rejectedTypes.includes(input.product_type))
    return {ok:false,status:"BLOCKED_DEFINITIONS",
      blocker:"item_name_product_type_conflicts_with_shopify_category",
      product_type_candidates:unique.slice(0,MAX_OUTPUT_TYPES),
      ...discoveryEvidence,...base};
  if (!input.product_type) return {
    ok: true, status: "PRODUCT_TYPE_SELECTION_REQUIRED",
    product_type_candidates: unique.slice(0, MAX_OUTPUT_TYPES),
    candidates_truncated: unique.length > MAX_OUTPUT_TYPES,
    candidate_count: unique.length,
    next_step: "REVIEW_PRODUCT_TYPE_AND_REQUEST_FULL_LISTING_SCHEMA",
    ...discoveryEvidence,
    ...base,
  };
  if (!unique.some(c => c.name === input.product_type))
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_not_in_marketplace_recommendations",
      product_type_candidates: unique.slice(0, MAX_OUTPUT_TYPES), ...discoveryEvidence, ...base};

  const url = new URL(HOST + "/definitions/2020-09-01/productTypes/" + input.product_type);
  url.searchParams.set("marketplaceIds", marketId);
  url.searchParams.set("requirements", "LISTING");
  url.searchParams.set("requirementsEnforced", "ENFORCED");
  url.searchParams.set("productTypeVersion", "LATEST");
  url.searchParams.set("parentageLevel", "NONE");
  url.searchParams.set("sellerId", env.AMAZON_SP_API_SELLER_ID!);
  let definition: Row;
  try { definition = await readJson(url.toString(), token, fetcher); }
  catch { return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_definition_unverified", ...base}; }
  const link = obj(obj(definition.schema).link), version = obj(definition.productTypeVersion);
  const schemaUrl = approvedSchemaUrl(link.resource);
  if (definition.productType !== input.product_type ||
      definition.requirements !== "LISTING" ||
      definition.requirementsEnforced !== "ENFORCED" ||
      !Array.isArray(definition.marketplaceIds) ||
      definition.marketplaceIds.length !== 1 || definition.marketplaceIds[0] !== marketId ||
      link.verb !== "GET" || version.latest !== true ||
      typeof version.version !== "string" || !version.version ||
      typeof obj(definition.schema).checksum !== "string" || !schemaUrl)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_schema_metadata_unverified", ...base};

  let rawSchema: Row;
  try { rawSchema = await readJson(schemaUrl, null, fetcher, true); }
  catch (error) {
    const kind = error instanceof Error && /^provider_(?:transport_unverified|http_[0-9]{3}|content_type_unverified|payload_too_large|body_missing|invalid_json)$/.test(error.message)
      ? error.message : "provider_unknown";
    return {ok: false, status: "BLOCKED_DEFINITIONS",
      blocker: "product_type_schema_unavailable",
      schema_download_diagnostic: kind,
      ...base};
  }
  const fields = requiredAttributes(rawSchema);
  if (!fields)
    return {ok: false, status: "BLOCKED_DEFINITIONS", blocker: "product_type_schema_structure_unverified", ...base};
  const shoesGap = sneakers && input.product_type === "SHOES"
    ? buildAmazonShoesGapReport(product, variant, fields.required,
      fields.staticRequiredDeclared, fields.complex)
    : null;
  const otherGap = !shoesGap
    ? nonShoesAttributeGapReport(product, variant, input.product_type,
      fields.required, fields.staticRequiredDeclared, fields.complex)
    : null;
  return {
    ok: true, status: "REQUIREMENTS_REVIEW_REQUIRED",
    ...discoveryEvidence,
    product_type: input.product_type, parentage_level: "NONE",
    schema_requirements: "LISTING", schema_enforced: true,
    schema_version: version.version, schema_checksum_reported: true,
    schema_checksum_verified: false,
    required_attribute_names: fields.required,
    available_schema_attribute_names: fields.visible,
    schema_attribute_count: fields.visibleCount,
    available_schema_attribute_names_truncated: fields.truncated,
    schema_attribute_structure: fields.structure,
    static_required_set_declared: fields.staticRequiredDeclared,
    conditional_requirements_detected: fields.complex,
    static_requirements_not_full_validation: true,
    ...(sneakers && input.product_type === "SHOES" ? {
      ptd_attribute_shapes: selectedAttributeShapes(rawSchema,SHOES_INSPECTION_FIELDS),
      ptd_shapes_are_read_only: true,
      ptd_shapes_are_not_schema_validation: true,
    } : {}),
    ...(["SOCKS","HANDBAG","SHIRT","COAT","HAT","BOOT","BACKPACK","SCARF","SWEATER","SWEATSHIRT"].includes(input.product_type) ? {
      ptd_size_shapes: selectedAttributeShapes(rawSchema,GENERIC_SIZE_INSPECTION_FIELDS),
      ptd_alpha_size_tokens:ptdAlphaSizeTokens(rawSchema),
      ptd_alpha_size_label_tokens:ptdAlphaSizeLabelTokens(rawSchema),
      ptd_size_shapes_are_read_only:true,
      ptd_size_shapes_not_schema_validation:true,
      ptd_size_mapping_not_performed:true,
      ptd_technical_shapes: selectedAttributeShapes(rawSchema,GENERIC_TECHNICAL_INSPECTION_FIELDS),
      ptd_technical_shapes_read_only:true,
      ptd_technical_shapes_no_values_supplied:true,
    } : {}),
    supported_shopify_evidence_fields: [
      "item_name", "brand", "externally_assigned_product_identifier",
      "purchasable_offer", "fulfillment_availability",
    ],
    ...(shoesGap ? {attribute_gap_report: shoesGap} : {attribute_gap_report:otherGap}),
    product_payload_constructed: false, validation_preview_sent: false,
    next_step: "MAP_REQUIRED_ATTRIBUTES_AND_VALIDATE_GPSR_BRAND_AND_GTIN_BEFORE_VALIDATION_PREVIEW",
    ...base,
  };
}
