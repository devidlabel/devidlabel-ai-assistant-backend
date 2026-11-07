import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

type Obj = Record<string, unknown>;
type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type Env = AmazonCredentials & { AMAZON_SP_API_SELLER_ID?: string };
type Deps = { auth?: typeof getAmazonAccessToken; fetch?: typeof fetch };
const HOST = "https://sellingpartnerapi-eu.amazon.com";
const SKU = /^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const SELLER = /^[A-Z0-9]{8,30}$/;
const CODES = new Set(["19038","19037","18701","100708"]);
function obj(x: unknown): Obj { return x && typeof x === "object" && !Array.isArray(x) ? x as Obj : {}; }
function rows(x: unknown): Obj[] { return Array.isArray(x) ? x.map(obj) : []; }
function amount(x: unknown): number|null {
  const n = typeof x === "number" ? x : typeof x === "string" && /^\d{1,8}(?:\.\d{1,2})?$/.test(x) ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 10000000 ? Math.round(n*100)/100 : null;
}
function money(o: Obj, key: string): number|null {
  const a = rows(o[key]);
  const schedule = rows(obj(a[0]).schedule);
  return amount(schedule.length ? schedule[0].value_with_tax : undefined);
}
function request(raw: unknown): {marketplace: Market; skus: string[]} {
  const v = obj(raw), m = String(v.marketplace||"");
  if (Object.keys(v).sort().join("|")!=="marketplace|skus" ||
      !Object.hasOwn(AMAZON_EU_MARKETPLACES,m) ||
      !Array.isArray(v.skus) || v.skus.length<1 || v.skus.length>8 ||
      v.skus.some((s:unknown)=>typeof s!=="string"||!SKU.test(s)||s.trim()!==s) ||
      new Set(v.skus).size!==v.skus.length) throw Error("amazon_price_bounds_request_invalid");
  return {marketplace:m as Market,skus:v.skus as string[]};
}
/** Bound-price diagnostic only: never echoes full raw offer attributes, contacts or issue messages. */
export async function readAmazonEuPriceBounds(raw: unknown,env: Env,deps: Deps={}): Promise<Obj> {
  const input=request(raw), seller=env.AMAZON_SP_API_SELLER_ID;
  if (!seller || !SELLER.test(seller))
    return {ok:false,status:"SELLER_ID_UNVERIFIED",read_only:true,provider_mutations:0};
  let token:string;
  try { token=await(deps.auth??getAmazonAccessToken)(env); }
  catch { return {ok:false,status:"AUTH_UNAVAILABLE",read_only:true,provider_mutations:0}; }
  if (typeof token!=="string"||token.length<5||token.length>16384||/[\s\u0000-\u001f\u007f]/.test(token))
    return {ok:false,status:"AUTH_UNAVAILABLE",read_only:true,provider_mutations:0};
  const marketId=AMAZON_EU_MARKETPLACES[input.marketplace], out:Obj[]=[];
  for(const sku of input.skus) {
    const url=new URL(HOST+"/listings/2021-08-01/items/"+encodeURIComponent(seller)+"/"+encodeURIComponent(sku));
    url.searchParams.set("marketplaceIds",marketId);
    url.searchParams.set("includedData","summaries,attributes,issues,offers");
    let payload:Obj={};
    try {
      const resp=await(deps.fetch??fetch)(url.toString(),{method:"GET",redirect:"manual",
        headers:{"x-amz-access-token":token,Accept:"application/json"},
        signal:AbortSignal.timeout(20000)});
      if(resp.status!==200||!/^application\/json(?:\s*;|$)/i.test(resp.headers.get("content-type")||"")) {
        out.push({sku,state:resp.status===404?"VERIFIED_ABSENT":"RESPONSE_UNAVAILABLE",http_status:resp.status});
        continue;
      }
      const text=await resp.text();
      if(text.length>128000)throw Error("oversize");
      payload=obj(JSON.parse(text));
    } catch { out.push({sku,state:"RESPONSE_UNAVAILABLE"});continue; }
    const sums=rows(payload.summaries).filter(x=>x.marketplaceId===marketId);
    if(payload.sku!==sku||sums.length!==1||typeof sums[0].asin!=="string") {
      out.push({sku,state:"IDENTITY_UNVERIFIED"});continue;
    }
    const offers=rows(obj(payload.attributes).purchasable_offer).filter(x=>
      x.marketplace_id===marketId && x.audience==="ALL" && x.currency==="EUR");
    const offer=offers.length===1?offers[0]:null;
    const high=offer?money(offer,"maximum_seller_allowed_price"):null;
    const low=offer?money(offer,"minimum_seller_allowed_price"):null;
    const current=offer?money(offer,"our_price"):null;
    const errors=rows(payload.issues).map(x=>String(x.code||"")).filter(x=>CODES.has(x));
    const sellAboveMax=high!==null&&current!==null&&current>high;
    const sellBelowMin=low!==null&&current!==null&&current<low;
    out.push({sku,asin:sums[0].asin,state:"PRESENT",marketplace:input.marketplace,
      price_attributes_observed:offer!==null,seller_price_eur:current,
      maximum_seller_allowed_price_eur:high,minimum_seller_allowed_price_eur:low,
      explicit_19038:errors.includes("19038"),pricing_issue_codes:[...new Set(errors)],
      observed_price_above_max:sellAboveMax,observed_price_below_min:sellBelowMin,
      price_max_not_observed:high===null,
      other_listing_issues_may_remain:true});
  }
  return {ok:true,status:"EU_PRICE_BOUNDS_READ_ONLY",marketplace:input.marketplace,
    requested:input.skus.length,results:out,read_only:true,
    provider_mutations:0,channable_changed:false,price_changed:false,quantity_changed:false};
}
