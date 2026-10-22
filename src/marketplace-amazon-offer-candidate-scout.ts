/**
 * Read-only Offer Only candidate gate, comparing REAL source-shaped snapshots.
 * The output is classification only, NOT authorization to publish.
 * Product/variant details, exact EAN→ASIN and seller SKU absence must agree.
 * Cross-SKU seller ASIN search, brand/GPSR, Channable, policy and Amazon
 * LISTING_OFFER_ONLY validation still require independent fresh evidence.
 */
type Market = "IT" | "DE" | "FR" | "ES";
type Row = Record<string, unknown>;
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN = /^[A-Z0-9]{10}$/;
const EAN = /^\d{13}$/;
const MARKETS: Market[] = ["IT","DE","FR","ES"];
const MAX_AGE_MS = 10 * 60_000;
export type ShopifyOfferScoutInput = Readonly<{
  sku: string; ean: string; active: true; inventory_quantity: number;
}>;
export type OfferScoutResult = Readonly<{
  marketplace: Market;
  sku: string; ean: string;
  asin: string | null;
  state: "CANDIDATE_NEEDS_FULL_PREFLIGHT" |
    "EXISTING_SELLER_OFFER" | "SELLER_LISTING_DIAGNOSTICS" |
    "NEW_ASIN_RESEARCH" | "UNKNOWN_RECHECK" | "INVALID_SHOPIFY_IDENTITY";
  safe_for_live_offer: false;
  can_publish: false;
  reasons: string[];
}>;
function obj(raw: unknown): Row {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Row : {};
}
function eanValid(x: unknown): x is string {
  if(typeof x !== "string" || !EAN.test(x))return false;
  let c = 0; for(let i=0;i<12;i++)c+=Number(x[i])*(i%2===0?1:3);
  return (10-c%10)%10===Number(x[12]);
}
function fresh(t: unknown, clock: ()=>number) {
  if(typeof t!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(t))return false;
  const n=clock(),d=Date.parse(t);
  return Number.isSafeInteger(n)&&Number.isFinite(d)&&d<=n&&n-d<=MAX_AGE_MS;
}
function result(p:ShopifyOfferScoutInput,marketplace:Market,asin:string|null,
  state:OfferScoutResult["state"],reasons:string[]):OfferScoutResult{
  return {marketplace,sku:p.sku,ean:p.ean,asin,state,reasons,can_publish:false,safe_for_live_offer:false};
}
/** Guaranteed to never return READY_TO_PUBLISH, even on fully matched snapshots. */
export function classifyOfferOnlyCandidate(
  p: ShopifyOfferScoutInput, marketplace: Market, catalogRaw: unknown,
  sellerRaw: unknown, clock: ()=>number = Date.now,
): OfferScoutResult {
  if(!MARKETS.includes(marketplace) || typeof p.sku!=="string" || !SKU.test(p.sku) ||
      p.sku!==p.sku.trim() || !eanValid(p.ean) ||
      p.active!==true || !Number.isSafeInteger(p.inventory_quantity) ||
      p.inventory_quantity<=0) {
    return result(p,marketplace,null,"INVALID_SHOPIFY_IDENTITY",["SHOPIFY_NOT_ACTIVE_STOCKED_UNIQUE_IDENTITY"]);
  }
  const cat=obj(catalogRaw), seller=obj(sellerRaw), envelope=obj(cat.result);
  if(cat.ok!==true || cat.source!=="amazon_spapi_catalog_items_live" ||
    cat.association_status!=="CANDIDATES_ONLY" ||
    cat.read_only!==true || cat.has_created_offer!==false ||
    envelope.marketplace!==marketplace || envelope.complete!==true ||
    !Array.isArray(envelope.identifiers) ||
    cat.identifier_type!=="EAN") {
    return result(p,marketplace,null,"UNKNOWN_RECHECK",["EXACT_CATALOG_READ_NOT_VERIFIED"]);
  }
  const codes=envelope.identifiers.map(obj).filter(x=>x.ean===p.ean);
  if(codes.length!==1)return result(p,marketplace,null,"UNKNOWN_RECHECK",["EAN_CATALOG_IDENTITY_AMBIGUOUS"]);
  const x=codes[0];
  if(x.state==="NO_EXACT_MATCH" && x.exact_match_count===0 &&
    Array.isArray(x.asins)&&x.asins.length===0) {
    return result(p,marketplace,null,"NEW_ASIN_RESEARCH",["NO_EXACT_EAN_ASIN_IN_MARKET"]);
  }
  if(x.state!=="EXACT_ONE"||x.exact_match_count!==1||
    !Array.isArray(x.asins)||x.asins.length!==1||
    typeof x.asins[0]!=="string"||!ASIN.test(x.asins[0])) {
    return result(p,marketplace,null,"UNKNOWN_RECHECK",["CATALOG_MATCH_NOT_UNIQUE"]);
  }
  const asin = x.asins[0] as string;
  if(seller.ok!==true||seller.source!=="amazon_sp_api_get_listings_item"||
    seller.read_only!==true||seller.has_created_or_updated_offer!==false||
    seller.marketplace!==marketplace||!fresh(seller.observed_at,clock)||
    !Array.isArray(seller.results)) {
    return result(p,marketplace,asin,"UNKNOWN_RECHECK",["SELLER_LISTING_GET_NOT_VERIFIED"]);
  }
  const sellers=seller.results.map(obj).filter(x=>x.sku===p.sku);
  if(sellers.length!==1)return result(p,marketplace,asin,"UNKNOWN_RECHECK",["SELLER_SKU_RESULT_NOT_UNIQUE"]);
  const row=sellers[0];
  if(!fresh(row.observed_at,clock))return result(p,marketplace,asin,"UNKNOWN_RECHECK",["SELLER_SKU_RESULT_STALE"]);
  if(row.state==="VERIFIED_ABSENT" &&
    row.reason==="listings_item_404_with_verified_not_found" &&
    row.identity_reason==="listing_verified_absent") {
    return result(p,marketplace,asin,"CANDIDATE_NEEDS_FULL_PREFLIGHT",[
      "CHECK_SELLER_ASIN_CROSS_SKU",
      "CHECK_CATALOG_BRAND_TITLE_VARIANT",
      "CHECK_LISTINGS_RESTRICTIONS",
      "CHECK_PT_DEFINITIONS_AND_VALIDATION_PREVIEW",
      "CHECK_COUNTRY_BRAND_GPSR_PRICE",
      "CHECK_CHANNABLE_ISOLATION_AND_ATOMIC_CLAIM",
    ]);
  }
  if(row.state==="PRESENT" && row.identity_state==="VERIFIED" && row.asin===asin) {
    return result(p,marketplace,asin,"EXISTING_SELLER_OFFER",[
      "DO_NOT_CREATE_DUPLICATE", ...(Array.isArray(row.statuses)&&row.statuses.includes("BUYABLE")
        ? []:["EXISTING_OFFER_NOT_BUYABLE_REQUIRES_DIAGNOSTICS"]),
    ]);
  }
  if(row.state==="PRESENT"||row.state==="PRESENT_ATTRIBUTES_UNKNOWN"){
    return result(p,marketplace,asin,"SELLER_LISTING_DIAGNOSTICS",["EXISTING_SELLER_SKU_IDENTITY_OR_ATTRIBUTES_UNCERTAIN"]);
  }
  return result(p,marketplace,asin,"UNKNOWN_RECHECK",["SELLER_ABSENCE_NOT_VERIFIED"]);
}
