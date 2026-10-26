import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { readAmazonSellerListingsDirect } from "./mare-business-amazon-listings-direct.js";
import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import { previewAmazonNewAsinShoesValidation } from "./marketplace-amazon-new-asin-preview.js";
import { readAmazonShoesPrivateShopifyValues } from "./marketplace-amazon-shoes-private-shopify-values.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * ONE real Amazon SHOES new-ASIN submission, based ONLY on a fresh Shopify
 * source and the exact payload already sent in Amazon VALIDATION_PREVIEW.
 *
 * In an explicitly flagged experiment, missing-required-field error 90220 is
 * tolerated in VALIDATION_PREVIEW, so the subsequent live PUT can reveal actual
 * provider rejection without inventing product facts. A rejected PUT is NOT an
 * ASIN creation. Every attempt starts with zero FBM units and NO price.
 *
 * No bulk, no auto retry, no Channable / Shopify mutation, no synthetic
 * manufacturer, GTIN, GPSR, size, origin, composition or brand approval.
 */
type Row = Record<string, unknown>;
type Env = AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_PREVIEW_ENABLED?: string;
};
export type NewAsinPilotDeps = {
  preview?: typeof previewAmazonNewAsinShoesValidation;
  readPrivateFields?: typeof readAmazonShoesPrivateShopifyValues;
  research?: typeof researchAmazonNewAsinProductType;
  sellerReader?: typeof readAmazonSellerListingsDirect;
  accessToken?: typeof getAmazonAccessToken;
  fetch?: typeof fetch;
};
type Input = Readonly<{
  marketplace: keyof typeof AMAZON_EU_MARKETPLACES;
  sku: string;
  allow_known_missing_attributes: boolean;
}>;
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER = /^[A-Z0-9]{8,30}$/;
const EAN = /^\d{13}$/;
const SUBMISSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ATTRIBUTE = /^[a-z][a-z0-9_]{0,119}$/;
const ISSUE = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_BODY = 128_000;
const DEADLINE = 20_000;
const attributesAllowed = new Set([
  "brand", "item_name", "externally_assigned_product_identifier",
  "model_name", "color", "country_of_origin", "age_range_description",
  "product_description", "model_number", "bullet_point", "closure",
  "target_gender", "footwear_size", "outer", "inner", "sole_material",
  "manufacturer", "list_price", "lifestyle", "style", "leather_type",
  "shaft", "height_map", "strap_type", "water_resistance_level",
  "batteries_required", "item_package_weight", "item_package_dimensions"
]);
function obj(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row : {};
}
function inputValidated(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
       Object.getPrototypeOf(value) !== null)) throw new Error("new_asin_pilot_invalid_input");
  const keys = Reflect.ownKeys(value);
  const whitelist = ["marketplace", "sku", "allow_known_missing_attributes"];
  if (keys.length !== whitelist.length ||
      keys.some(x => typeof x !== "string" || !whitelist.includes(x)))
    throw new Error("new_asin_pilot_invalid_input");
  const v = obj(value);
  for (const key of whitelist) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !("value" in d) || !d.enumerable) throw new Error("new_asin_pilot_invalid_input");
  }
  if (typeof v.marketplace !== "string" ||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES, v.marketplace) ||
      typeof v.sku !== "string" || !SKU.test(v.sku) ||
      v.sku !== v.sku.trim() ||
      typeof v.allow_known_missing_attributes !== "boolean")
    throw new Error("new_asin_pilot_invalid_input");
  return Object.freeze({
    marketplace: v.marketplace as Input["marketplace"],
    sku: v.sku,
    allow_known_missing_attributes: v.allow_known_missing_attributes
  });
}
function blocked(input: Input, reason: string, notes: Row = {}): Row {
  return {
    ok: false, status: "BLOCKED_NEW_ASIN_PILOT",
    marketplace: input.marketplace, sku: input.sku, blocker: reason,
    provider_write_attempted: false, asin_created_verified: false,
    buyable_verified: false, no_channable_changes: true, ...notes
  };
}
function validEAN(value: string): boolean {
  if (!EAN.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === Number(value[12]);
}
async function boundedJson(response: Response): Promise<Row> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || ""))
    throw new Error("new_asin_pilot_unknown_response_type");
  const len = response.headers.get("content-length");
  if (len && /^\d+$/.test(len) && Number(len) > MAX_BODY)
    throw new Error("new_asin_pilot_response_too_large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("new_asin_pilot_response_missing");
  let bytes = 0, raw = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const x = await reader.read();
      if (x.done) break;
      bytes += x.value.byteLength;
      if (bytes > MAX_BODY) throw new Error("new_asin_pilot_response_too_large");
      raw += decoder.decode(x.value, { stream: true });
    }
    raw += decoder.decode();
  } finally { reader.releaseLock(); }
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new Error("new_asin_pilot_response_unparseable"); }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw new Error("new_asin_pilot_response_unparseable");
  return obj(decoded);
}
function safeAmazonDiagnostic(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 3 || value.length > 16000)
    return null;
  let s = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[AUTH]")
    .replace(/\b(?:token|secret|password|authorization|refresh_token|access_token)\s*[:=]\s*\S+/gi, "[SECRET]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[OPAQUE]")
    .replace(/\b\d{12,}\b/g, "[LONG_NUMBER]")
    .replace(/[\x00-\x1f\x7f<>]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!s || s.length > 600) s = s.slice(0, 600).trim();
  return s || null;
}
function errorCodes(issues: unknown): string[] {
  if (!Array.isArray(issues) || issues.length > 100)
    throw new Error("new_asin_pilot_invalid_issue_list");
  const out: string[] = [];
  for (const issue of issues) {
    const x = obj(issue);
    if (typeof x.code !== "string" || !ISSUE.test(x.code) ||
        !["ERROR", "WARNING", "INFO"].includes(String(x.severity)))
      throw new Error("new_asin_pilot_invalid_issue_list");
    out.push(x.code);
  }
  return [...new Set(out)];
}
function previewAccepted(pre: Row, input: Input): boolean {
  const errors = Array.isArray(pre.issues)
    ? pre.issues.filter(x => obj(x).severity === "ERROR") : [];
  if (pre.ok !== true || pre.status !== "VALIDATION_ONLY_REVIEW_REQUIRED" ||
      pre.marketplace !== input.marketplace || pre.sku !== input.sku ||
      pre.product_type !== "SHOES" || pre.validation_mode !== "VALIDATION_PREVIEW" ||
      pre.provider_validation_performed !== true || pre.preview_only !== true ||
      pre.provider_mutations !== 0 || pre.product_created !== false ||
      pre.listing_write_enabled !== false || !Array.isArray(pre.issues) ||
      pre.issues.length > 80 || pre.issue_count !== pre.issues.length)
    return false;
  if (pre.provider_validation_status === "VALID" && errors.length === 0) return true;
  if (!input.allow_known_missing_attributes ||
      pre.provider_validation_status !== "INVALID" || errors.length === 0) return false;
  // An experimental live reject is acceptable; no false product facts may
  // be added to force the request through.
  return errors.every(x => obj(x).code === "90220");
}
function researchVerified(r: Row, input: Input): boolean {
  const s = obj(r.shopify);
  return r.ok === true && r.status === "REQUIREMENTS_REVIEW_REQUIRED" &&
    r.marketplace === input.marketplace && r.sku === input.sku &&
    r.product_type === "SHOES" &&
    r.seller_listing_state === "VERIFIED_ABSENT" &&
    r.ean_match_state === "NO_EXACT_MATCH" &&
    r.ean_absence_not_catalog_absence_proof === true &&
    r.read_only === true && r.provider_mutations === 0 &&
    r.schema_enforced === true && r.schema_requirements === "LISTING" &&
    s.shopify_product_type === "Sneakers" &&
    typeof s.ean === "string" && validEAN(s.ean) &&
    typeof s.amazon_listing_brand === "string" && Boolean(s.amazon_listing_brand) &&
    typeof s.product_title === "string" && Boolean(s.product_title) &&
    Number.isSafeInteger(s.shopify_available) && (s.shopify_available as number) > 0 &&
    typeof s.variant_id === "string" &&
    /^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(s.variant_id);
}
function payloadVerified(body: Row, marketId: string, research: Row, input: Input, freshEvidence: Row): boolean {
  const attrs = obj(body.attributes), s = obj(research.shopify);
  if (body.productType !== "SHOES" || body.requirements !== "LISTING" ||
      Object.keys(body).sort().join("|") !== "attributes|productType|requirements" ||
      Object.keys(attrs).length < 5 ||
      Object.keys(attrs).some(k => !attributesAllowed.has(k))) return false;
  const single = (field: string): Row => {
    const a = attrs[field];
    return Array.isArray(a) && a.length === 1 ? obj(a[0]) : {};
  };
  if (single("brand").value !== s.amazon_listing_brand ||
      single("item_name").value !== s.product_title ||
      single("externally_assigned_product_identifier").value !== s.ean ||
      single("externally_assigned_product_identifier").type !== "ean")
    return false;
  // Generic shared attributes require fresh exact Shopify variant evidence.
  const locale=({IT:"it_IT",DE:"de_DE",FR:"fr_FR",ES:"es_ES"} as const)[input.marketplace];
  if (Object.hasOwn(attrs,"style")){
    if(freshEvidence.catalog_style!=="Sneaker"||JSON.stringify(attrs.style)!==
       JSON.stringify([{value:"Sneaker",language_tag:locale,marketplace_id:marketId}]))
      return false;
  }
  if (Object.hasOwn(attrs,"list_price")){
    const price=freshEvidence.shopify_list_price_eur;
    if(typeof price!=="number"||!Number.isFinite(price)||price<=0||
       price>99999||JSON.stringify(attrs.list_price)!==
       JSON.stringify([{currency:"EUR",value_with_tax:price,marketplace_id:marketId}]))
      return false;
    if(freshEvidence.shopify_snapshot_price!==s.shopify_price)return false;
  }
  if (Object.hasOwn(attrs,"manufacturer")){
    const pilotOperator=obj(freshEvidence.pilot_brand_operator);
    const modelPilot=input.marketplace==="IT"&&
      /^4B12_PLAYNEW_D2045_(?:37|38|39|40)_EU$/.test(input.sku)&&
      s.amazon_listing_brand==="4B12"&&s.product_title==="PlayNew D-2045 White/Bronze"&&
      pilotOperator.name==="Medusa s.r.l."&&
      pilotOperator.source==="OFFICIAL_4B12_CONTACTS_NOT_GPSR";
    const manufacturer=freshEvidence.merchant_manufacturer_name;
    const supported=typeof manufacturer==="string"&&manufacturer.length>1?
      manufacturer:modelPilot?"Medusa s.r.l.":null;
    if(!supported||JSON.stringify(attrs.manufacturer)!==
      JSON.stringify([{value:supported,language_tag:locale,marketplace_id:marketId}]))
      return false;
  }
  // Extra product facts must match EXACT observed pilot source/market identity.
  // Never accept an arbitrary manufacturer/list price through a mock/plan.
  const extraFields=["outer","inner","sole_material",
    "lifestyle","leather_type","shaft","height_map","strap_type",
    "water_resistance_level","batteries_required","item_package_weight","item_package_dimensions"];
  if (extraFields.some(k => Object.hasOwn(attrs,k))) {
    const verifiedPlayNewGTIN:Record<string,string>={
      "4B12_PLAYNEW_D2045_37_EU":"8057270148088",
      "4B12_PLAYNEW_D2045_38_EU":"8057270148095",
      "4B12_PLAYNEW_D2045_39_EU":"8057270148101",
      "4B12_PLAYNEW_D2045_40_EU":"8057270148118"
    };
    if(input.marketplace!=="IT"||
       !Object.hasOwn(verifiedPlayNewGTIN,input.sku)||
       s.ean!==verifiedPlayNewGTIN[input.sku]||
       s.amazon_listing_brand!=="4B12"||
       s.product_title!=="PlayNew D-2045 White/Bronze"||
       s.shopify_price!=="179.10") return false;
    const expectedExtras:Record<string,unknown>={
      outer:[{material:[{value:"Pelle e suede",language_tag:"it_IT"}],marketplace_id:marketId}],
      inner:[{material:[{value:"Pelle e spugna",language_tag:"it_IT"}],marketplace_id:marketId}],
      sole_material:[{value:"Gomma",language_tag:"it_IT",marketplace_id:marketId}],
      manufacturer:[{value:"Medusa s.r.l.",language_tag:"it_IT",marketplace_id:marketId}],
      list_price:[{currency:"EUR",value_with_tax:199,marketplace_id:marketId}],
      lifestyle:[{value:"Casual",language_tag:"it_IT",marketplace_id:marketId}],
      style:[{value:"Sneaker",language_tag:"it_IT",marketplace_id:marketId}],
      leather_type:[{value:"Pelle scamosciata",language_tag:"it_IT",marketplace_id:marketId}],
      shaft:[{height:[{value:"6",unit:"centimeters",language_tag:"it_IT"}],marketplace_id:marketId}],
      height_map:[{value:"low-top",marketplace_id:marketId}],
      strap_type:[{value:"no-strap",marketplace_id:marketId}],
      water_resistance_level:[{value:"not_water_resistant",marketplace_id:marketId}],
      batteries_required:[{value:false,marketplace_id:marketId}],
      item_package_weight:[{value:1.2,unit:"kilograms",marketplace_id:marketId}],
      item_package_dimensions:[{
        length:{value:34,unit:"centimeters"},
        width:{value:23,unit:"centimeters"},
        height:{value:13,unit:"centimeters"},marketplace_id:marketId
      }]
    };
    for(const key of extraFields)if(Object.hasOwn(attrs,key)&&
       JSON.stringify(attrs[key])!==JSON.stringify(expectedExtras[key])) return false;
  }
  for (const a of Object.values(attrs)) {
    if (!Array.isArray(a) || a.length < 1 || a.length > 5 ||
        a.some(v => obj(v).marketplace_id !== marketId)) return false;
  }
  return true;
}

/** Invoked only through MARE's immutable, explicitly executed live-write plan. */
export async function createAmazonNewAsinShoesPilot(
  rawInput: unknown, env: Env, deps: NewAsinPilotDeps = {}
): Promise<Row> {
  const input = inputValidated(rawInput);
  const sellerId = env.AMAZON_SP_API_SELLER_ID;
  if (!SELLER.test(sellerId ?? "") || env.AMAZON_OFFER_PREVIEW_ENABLED !== "true")
    return blocked(input, "seller_or_preview_not_configured");
  const marketId = AMAZON_EU_MARKETPLACES[input.marketplace];
  const verifiedSellerId = sellerId as string;
  let captured: Row | null = null;
  const transport = deps.fetch ?? fetch;
  const captureTransport: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    if (u.origin !== HOST ||
        u.pathname !== "/listings/2021-08-01/items/" +
          encodeURIComponent(verifiedSellerId) + "/" + encodeURIComponent(input.sku) ||
        u.searchParams.get("mode") !== "VALIDATION_PREVIEW" ||
        u.searchParams.get("marketplaceIds") !== marketId ||
        init?.method !== "PUT" || typeof init.body !== "string" ||
        captured !== null) throw new Error("new_asin_pilot_preview_transport_untrusted");
    try { captured = obj(JSON.parse(init.body)); }
    catch { throw new Error("new_asin_pilot_preview_body_unparseable"); }
    return transport(url, init);
  };
  const preview = obj(await (deps.preview ?? previewAmazonNewAsinShoesValidation)(
    { marketplace: input.marketplace, sku: input.sku }, env,
    { fetch: captureTransport, ...(deps.research ? { research: deps.research } : {}) }
  ));
  const validatedCapture: Row = obj(captured);
  if (!previewAccepted(preview, input) || !Object.keys(validatedCapture).length)
    return blocked(input, "preview_not_accepted_or_payload_missing", {
      preview_status: preview.provider_validation_status ?? null,
      preview_issue_codes: Array.isArray(preview.issues) ? errorCodes(preview.issues) : []
    });
  // Fresh source read after preview. Seller SKU / catalog matching might have
  // changed in the interim. No user-provided source field is ever trusted.
  const source = obj(await (deps.research ?? researchAmazonNewAsinProductType)(
    { marketplace: input.marketplace, sku: input.sku, product_type: "SHOES" }, env
  ));
  if (!researchVerified(source, input))
    return blocked(input, "fresh_identity_or_product_facts_changed");
  const shop=obj(source.shopify),capturedAttributes=obj(validatedCapture.attributes);
  const requiresEvidence=["style","list_price","manufacturer"].some(k=>
    Object.hasOwn(capturedAttributes,k));
  let freshEvidence: Row={};
  if(requiresEvidence){
    freshEvidence=obj(await(deps.readPrivateFields??readAmazonShoesPrivateShopifyValues)({
      sku:input.sku,variantId:shop.variant_id as string,
      productTitle:shop.product_title as string,shopifyVendor:shop.brand as string,
      amazonBrand:shop.amazon_listing_brand as string
    },env).catch(():Row=>({ok:false})));
    const model=Array.isArray(capturedAttributes.model_name)?
      obj(capturedAttributes.model_name[0]).value:null;
    const color=Array.isArray(capturedAttributes.color)?
      obj(capturedAttributes.color[0]).value:null;
    if(freshEvidence.ok!==true||freshEvidence.draft_values_review_only!==true||
       freshEvidence.ready_for_publication!==false||
       freshEvidence.model_name!==model||freshEvidence.color!==color)
      return blocked(input,"fresh_private_evidence_changed_or_unavailable");
  }
  if(!payloadVerified(validatedCapture, marketId, source, input,freshEvidence))
    return blocked(input,"fresh_identity_or_product_facts_changed");
  const seller = obj(await (deps.sellerReader ?? readAmazonSellerListingsDirect)(
    { marketplace: input.marketplace, skus: [input.sku] }, env
  ));
  const rows = Array.isArray(seller.results) ? seller.results : [];
  if (seller.ok !== true || seller.marketplace !== input.marketplace ||
      rows.length !== 1 || obj(rows[0]).sku !== input.sku ||
      obj(rows[0]).state !== "VERIFIED_ABSENT")
    return blocked(input, "seller_sku_not_independently_verified_absent");

  // Same merchant-authored product facts as the real Amazon preview.
  // Zero quantity; no price, manufacture or safety values are invented.
  const attributes = {
    ...obj(validatedCapture.attributes),
    fulfillment_availability: [{
      fulfillment_channel_code: "DEFAULT", quantity: 0, marketplace_id: marketId
    }]
  };
  const body = { productType: "SHOES", requirements: "LISTING", attributes };
  const token = await (deps.accessToken ?? getAmazonAccessToken)(env);
  if (typeof token !== "string" || !token.trim() || token.length > 16384 ||
      /[\u0000-\u0020\u007f]/.test(token)) throw new Error("new_asin_pilot_auth_failed");
  const url = new URL(HOST + "/listings/2021-08-01/items/" +
    encodeURIComponent(verifiedSellerId) + "/" + encodeURIComponent(input.sku));
  url.searchParams.set("marketplaceIds", marketId);
  // Production submission omits mode. Amazon accepts only VALIDATION_PREVIEW as an explicit mode.
  let res: Response;
  try {
    res = await transport(url.toString(), {
      method: "PUT", redirect: "manual",
      headers: {
        "x-amz-access-token": token, "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(DEADLINE)
    });
  } catch {
    // Delivery may have occurred; never retry an uncertain write.
    throw new Error("new_asin_pilot_uncertain_submission_reconcile_before_retry");
  }
  if (res.status !== 200) {
    // Amazon can return useful structured error codes for 400 responses.
    // Do not return raw messages, links, or request payloads to callers.
    const requestId = (res.headers.get("x-amzn-requestid") ||
      res.headers.get("x-amzn-request-id") || "").trim();
    let providerCodes: string[] = [];
    let providerDescriptions: string[] = [];
    if (res.status === 400 && /^application\/json(?:\s*;|$)/i.test(
      res.headers.get("content-type") || "")) {
      try {
        const rejection = await boundedJson(res);
        if (Array.isArray(rejection.errors) && rejection.errors.length <= 25) {
          providerCodes = [...new Set(rejection.errors.map((entry: unknown) => {
            const code = obj(entry).code;
            return typeof code === "string" && ISSUE.test(code) ? code : "UNCLASSIFIED";
          }))];
          providerDescriptions = [...new Set(rejection.errors
            .map((entry: unknown) => safeAmazonDiagnostic(obj(entry).message))
            .filter((message: string | null): message is string => message !== null))]
            .slice(0, 5);
        }
      } catch { /* Unreadable body remains an unknown rejection. */ }
    } else {
      void res.body?.cancel().catch(() => {});
    }
    return {
      ok: false, status: "PROVIDER_HTTP_REJECTED_OR_UNKNOWN",
      marketplace: input.marketplace, sku: input.sku, http_status: res.status,
      amazon_error_codes: providerCodes,
      amazon_error_descriptions_redacted: providerDescriptions,
      ...(SUBMISSION.test(requestId) ? { amazon_request_id: requestId } : {}),
      provider_write_attempted: true, asin_created_verified: false,
      buyable_verified: false, reconciliation_required: true,
      no_channable_changes: true
    };
  }
  let ack: Row;
  try { ack = await boundedJson(res); }
  catch { throw new Error("new_asin_pilot_uncertain_ack_reconcile_before_retry"); }
  if (ack.sku !== input.sku ||
      !["ACCEPTED", "INVALID"].includes(String(ack.status)) ||
      typeof ack.submissionId !== "string" || !SUBMISSION.test(ack.submissionId))
    throw new Error("new_asin_pilot_untrusted_ack_reconcile_before_retry");
  const issues = errorCodes(ack.issues ?? []);
  const validationDetails = (Array.isArray(ack.issues) ? ack.issues : [])
    .slice(0, 40).map((raw: unknown) => {
      const issue = obj(raw);
      const names = Array.isArray(issue.attributeNames) ? issue.attributeNames :
        typeof issue.attributeName === "string" ? [issue.attributeName] : [];
      return {
        code: issue.code,
        severity: issue.severity,
        attribute_names: names.slice(0, 12).filter(
          (name: unknown): name is string => typeof name === "string" && ATTRIBUTE.test(name)
        ),
        message_redacted: safeAmazonDiagnostic(issue.message)
      };
    });
  if (ack.status === "INVALID" || issues.length > 0) {
    return {
      ok: false, status: "AMAZON_REJECTED_NEW_ASIN_SUBMISSION",
      marketplace: input.marketplace, sku: input.sku,
      submission_reference: ack.submissionId, issue_codes: issues,
      issue_details_redacted: validationDetails,
      trial_incomplete_attributes: input.allow_known_missing_attributes,
      provider_write_attempted: true, asin_created_verified: false,
      buyable_verified: false, no_channable_changes: true,
      next_step: "IMPROVE_OFFICIAL_PRODUCT_ATTRIBUTE_EVIDENCE_AND_RESUBMIT_AFTER_NEW_RESEARCH"
    };
  }
  // Amazon ACCEPTED is a submission status; no ASIN is inferred from it.
  let observed: Row = {};
  try {
    observed = obj(await (deps.sellerReader ?? readAmazonSellerListingsDirect)(
      { marketplace: input.marketplace, skus: [input.sku] }, env
    ));
  } catch { /* Eventual consistency; never claim created without seller readback. */ }
  const found = Array.isArray(observed.results) ? observed.results : [];
  const e = obj(found[0]);
  const verified = observed.ok === true && found.length === 1 &&
    e.sku === input.sku && e.state === "PRESENT" &&
    e.identity_state === "VERIFIED" &&
    typeof e.asin === "string" && /^[A-Z0-9]{10}$/.test(e.asin);
  return {
    ok: true, status: verified ? "NEW_ASIN_SELLER_LISTING_VERIFIED" :
      "NEW_ASIN_SUBMITTED_AWAITING_READBACK",
    marketplace: input.marketplace, sku: input.sku,
    ...(verified ? { asin: e.asin } : {}),
    submission_reference: ack.submissionId, provider_write_attempted: true,
    asin_created_verified: verified, buyable_verified: false,
    submitted_quantity: 0, no_channable_changes: true,
    next_step: "RECHECK_CATALOG_AND_GPSR; COORDINATE_CHANNABLE_BEFORE_STOCK_POSITIVE"
  };
}
