import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type JsonObject = Record<string, unknown>;

function dict(x: unknown): JsonObject {
  return x && typeof x === "object" && !Array.isArray(x) ? x as JsonObject : {};
}
function string(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim().slice(0, 500) : null;
}
function shortAttribute(attributes: JsonObject, ...keys: string[]): string | null {
  for (const key of keys) {
    const attr=attributes[key];
    if (typeof attr === "string") return string(attr);
    if (Array.isArray(attr)) {
      for (const value of attr) {
        const field=dict(value);
        const v=string(field.value || field.display_value);
        if(v)return v;
      }
    }
  }
  return null;
}

/** Amazon Catalog Items is throttled independently from Listings.
 * Retry only transient HTTP 429 on the SAME read-only GET. If Amazon asks
 * to wait longer than 3 s, stop and fail closed instead of hammering the API
 * or risking a long Worker request. Missing/ambiguous details are NEVER an
 * ASIN absence claim. At most three total GET attempts per ASIN.
 */
async function catalogItemFetch(url:string,token:string):Promise<Response> {
  for(let attempt=0;attempt<3;attempt++){
    let response:Response;
    try {
      response=await fetch(url,{
        method:"GET",
        headers:{"x-amz-access-token":token,Accept:"application/json"},
        signal:AbortSignal.timeout(30000),redirect:"manual",
      });
    }catch{throw new Error("amazon_catalog_details_network_error");}
    if(response.status!==429||attempt===2)return response;
    const header=response.headers.get("retry-after")?.trim();
    let waitMs=attempt===0?500:1250;
    if(header!==undefined){
      if(!/^[0-3](?:\.\d{1,3})?$/.test(header))return response;
      waitMs=Math.floor(Number(header)*1000);
    }
    await response.body?.cancel().catch(()=>{});
    if(waitMs>0)await new Promise<void>(resolve=>setTimeout(resolve,waitMs));
  }
  throw new Error("amazon_catalog_details_http_429");
}

/**
 * Authenticated merchant-only SP-API GET Catalog Item.
 * Never returns access tokens, signed URLs or raw arbitrary Amazon response.
 */
export async function readAmazonCatalogASINDetails(
  request: JsonObject, env: AmazonCredentials
): Promise<unknown> {
  const market=request.marketplace;
  const input=request.asins;
  if (typeof market!=="string" ||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES, market) ||
      !Array.isArray(input) || input.length<1 || input.length>3 ||
      !input.every(v=>typeof v==="string" && /^[A-Z0-9]{10}$/.test(v)) ||
      new Set(input).size!==input.length) throw new Error("amazon_catalog_details_invalid_input");

  const m=market as Market;
  const marketplaceId=AMAZON_EU_MARKETPLACES[m];
  const token=await getAmazonAccessToken(env);
  const results=[];
  for (const asin of input as string[]) {
    const url=new URL("https://sellingpartnerapi-eu.amazon.com/catalog/2022-04-01/items/"+asin);
    url.searchParams.set("marketplaceIds",marketplaceId);
    url.searchParams.set("includedData","summaries,attributes,images,productTypes,identifiers");
    const response=await catalogItemFetch(url.toString(),token);
    if (response.status===404) {
      results.push({asin,state:"ASIN_NOT_FOUND"});
      continue;
    }
    if (!response.ok) throw new Error("amazon_catalog_details_http_"+response.status);
    let body: JsonObject;
    try { body=dict(await response.json()); }
    catch { throw new Error("amazon_catalog_details_invalid_json"); }
    if (body.asin!==asin || !Array.isArray(body.summaries) ||
        !Array.isArray(body.productTypes) || !Array.isArray(body.images)) {
      throw new Error("amazon_catalog_details_incomplete_response");
    }

    const summary=body.summaries.map(dict).find(s=>s.marketplaceId===marketplaceId);
    if (!summary) throw new Error("amazon_catalog_details_marketplace_summary_missing");
    const categories=(body.productTypes as unknown[]).map(dict)
      .filter(item=>item.marketplaceId===marketplaceId)
      .map(item=>string(item.productType)).filter(Boolean).slice(0,6);
    const images=(body.images as unknown[]).map(dict)
      .filter(item=>item.marketplaceId===marketplaceId);
    const imageCount=images.reduce((n,item)=>n+(Array.isArray(item.images)?item.images.length:0),0);
    const attrs=dict(body.attributes);
    results.push({
      asin,
      state:"READ_ONLY_DETAILS_COMPLETE",
      brand:string(summary.brand || summary.brandName) ||
        shortAttribute(attrs,"brand","brand_name"),
      item_name:string(summary.itemName),
      manufacturer:string(summary.manufacturer),
      model_number:string(summary.modelNumber),
      part_number:string(summary.partNumber),
      item_classification:string(summary.itemClassification),
      product_types:categories,
      color:shortAttribute(attrs,"color","color_name"),
      size:shortAttribute(attrs,"size","size_name"),
      images_available:imageCount,
      catalog_source:"amazon_spapi"
    });
  }
  return {
    ok:true, read_only:true, no_listing_writes:true,
    marketplace:m, source:"amazon_spapi_catalog_item_live",
    association_status:"PRODUCT_ATTRIBUTES_TO_REVIEW",
    has_created_offer:false,
    results
  };
}
