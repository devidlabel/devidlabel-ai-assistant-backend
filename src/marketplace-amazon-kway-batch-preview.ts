import { previewAmazonGenericEanValidation } from "./marketplace-amazon-generic-ean-preview.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";
import type { AmazonCredentials } from "./amazon-auth.js";

type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_PREVIEW_ENABLED?: string;
};
type Input = { marketplace: "IT" | "DE" | "FR" | "ES"; items: Array<{
  sku: string; product_type: string;
}> };
type Result = Record<string, unknown>;
type Deps = { preview?: typeof previewAmazonGenericEanValidation };
const SKU = /^KWAY_[A-Za-z0-9_ .-]{1,114}$/;
const TYPES = new Set(["COAT","HAT","SHIRT","BACKPACK","SWEATER","SWEATSHIRT","SCARF",
  "HANDBAG","COSMETIC_CASE","STORAGE_BAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK"]);
const MARKETS = new Set(["IT","DE","FR","ES"]);
const ATTRIBUTE = /^[a-z_]{1,64}$/;
const ISSUE = /^[A-Za-z0-9._-]{1,64}$/;
function object(x: unknown): Result {
  return x && typeof x === "object" && !Array.isArray(x) ? x as Result : {};
}
function validate(raw: unknown): Input {
  const x = object(raw);
  if (Object.keys(x).sort().join("|") !== "items|marketplace" ||
      typeof x.marketplace !== "string" || !MARKETS.has(x.marketplace) ||
      !Array.isArray(x.items) || x.items.length < 1 || x.items.length > 8)
    throw new Error("kway_batch_preview_request_invalid");
  const seen = new Set<string>();
  for (const item of x.items) {
    const p = object(item);
    if (Object.keys(p).sort().join("|") !== "product_type|sku" ||
        typeof p.sku !== "string" || !SKU.test(p.sku) || p.sku !== p.sku.trim() ||
        typeof p.product_type !== "string" || !TYPES.has(p.product_type) ||
        seen.has(p.sku)) throw new Error("kway_batch_preview_item_invalid");
    seen.add(p.sku);
  }
  return raw as Input;
}
function issueSummary(raw: unknown): Result[] {
  return Array.isArray(raw) ? raw.slice(0, 25).map(x => {
    const p = object(x);
    const names = Array.isArray(p.attribute_names) ? p.attribute_names :
      Array.isArray(p.attributeNames) ? p.attributeNames : [];
    return {
      code: typeof p.code === "string" && ISSUE.test(p.code) ? p.code : "UNKNOWN",
      attribute_names: names.filter((v: unknown) =>
        typeof v === "string" && ATTRIBUTE.test(v)).slice(0, 10)
    };
  }) : [];
}
/** Sequential, preview-only diagnostics. Never writes live ASINs or inventory. */
export async function previewKwayAsinBatch(
  raw: unknown, env: Env, deps: Deps = {}
): Promise<Result> {
  const req = validate(raw);
  const rows: Result[] = [];
  for (const item of req.items) {
    let result: Result;
    try {
      result = object(await (deps.preview ?? previewAmazonGenericEanValidation)(
        { marketplace: req.marketplace, sku: item.sku, product_type: item.product_type },
        env
      ));
    } catch {
      rows.push({ sku: item.sku, product_type: item.product_type,
        status: "PREVIEW_UNAVAILABLE", can_publish: false });
      continue;
    }
    const issues = issueSummary(result.issues);
    const valid = result.ok === true &&
      result.status === "VALIDATION_ONLY_REVIEW_REQUIRED" &&
      result.provider_validation_performed === true &&
      result.preview_only === true && result.provider_mutations === 0 &&
      result.product_created === false &&
      result.provider_validation_status === "VALID" && issues.length === 0;
    rows.push({
      sku: item.sku, product_type: item.product_type,
      status: typeof result.status === "string" ? result.status : "UNKNOWN",
      validation_status: result.provider_validation_status === "VALID" ? "VALID" :
        result.provider_validation_status === "INVALID" ? "INVALID" : "UNKNOWN",
      ready_for_next_guarded_step: valid,
      issue_count: issues.length, issues,
      reason: typeof result.reason === "string" &&
        /^[a-z0-9_]{1,100}$/.test(result.reason) ? result.reason : undefined,
      submitted_attribute_count: Array.isArray(result.attributes_submitted) ?
        result.attributes_submitted.length : undefined,
      can_publish: false
    });
  }
  return {
    ok: true, status: "KWAY_BATCH_VALIDATION_ONLY",
    marketplace: req.marketplace, requested: req.items.length, processed: rows.length,
    validation_valid: rows.filter(r => r.ready_for_next_guarded_step === true).length,
    rows, preview_only: true, provider_mutations: 0,
    asin_created: false, no_price_stock_channable_writes: true
  };
}
