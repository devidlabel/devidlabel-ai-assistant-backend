import { readAmazonLatestListingReportSummary } from "./amazon-listing-report-summary.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import type { AmazonCredentials } from "./amazon-auth.js";

type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Reader=(env:AmazonCredentials,market:Market,skus:string[])=>Promise<unknown>;
function obj(x:unknown):Record<string,unknown>{
  return x && typeof x==="object" && !Array.isArray(x)
    ? x as Record<string,unknown> : {};
}
/**
 * Merchant-private, strictly read-only SKU report lookup. MISSING is allowed
 * only after a recent complete, duplicate-free, encoding-verified seller
 * report with a verified listing status column has been fully parsed.
 */
export async function readAmazonMerchantSkuStatuses(
  input: Record<string,unknown>,
  env: AmazonCredentials,
  reader: Reader=readAmazonLatestListingReportSummary
):Promise<unknown>{
  const market=input.marketplace;
  const skus=input.skus;
  if(typeof market!=="string" || !Object.hasOwn(AMAZON_EU_MARKETPLACES,market) ||
    !Array.isArray(skus) || skus.length<1 || skus.length>8 ||
    !skus.every(s=>typeof s==="string" && s.length>=1 && s.length<=150 &&
      !/[\x00-\x1f\x7f]/.test(s) && s===s.trim()) ||
    new Set(skus).size!==skus.length){
    throw new Error("amazon_merchant_sku_status_invalid_request");
  }
  const data=obj(await reader(env,market as Market,skus as string[]));
  if(data.marketplace!==market || data.snapshot_complete!==true ||
      data.safe_for_missing_sku_classification!==true ||
      data.fresh_within_24h!==true || data.encoding_verified!==true ||
      data.duplicate_sku_rows!==0 || data.status_column_present!==true ||
      !Number.isInteger(data.rows) || (data.rows as number)<0){
    throw new Error("amazon_merchant_sku_status_report_unverified");
  }
  const details=obj(data.selected_sku_statuses);
  const knownStates=new Set(["ACTIVE","INACTIVE","INCOMPLETE","SUPPRESSED","UNKNOWN","MISSING"]);
  const statuses=[];
  for(const sku of skus as string[]){
    const status=details[sku];
    if(typeof status!=="string" || !knownStates.has(status))
      throw new Error("amazon_merchant_sku_status_unverified_item");
    statuses.push({sku,status,
      must_not_create_duplicate:status!=="MISSING",
      eligibility_for_new_offer:status==="MISSING"?"NEEDS_PRODUCT_REVIEW":"EXISTING_SKU"});
  }
  return {
    ok:true,read_only:true,no_listing_writes:true,
    marketplace:market,source:"amazon_existing_completed_merchant_listings_report",
    report_created_at:data.report_created_at||null,
    complete:true,has_created_offer:false,
    statuses
  };
}
