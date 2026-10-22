/**
 * Read-only Amazon EU 100632 triage, including optional opposite-market BUYABLE
 * evidence. This DOES NOT infer a brand approval or mutate a marketplace.
 *
 * Accept provider-shaped SP-API data from connected, authenticated readers.
 * The caller must be a trusted backend; untrusted provider data is treated as
 * observations and never authorization for a live write.
 */
type Row = Record<string, unknown>;
type Market = "IT" | "DE" | "FR" | "ES";
export type Amazon100632Route =
  | "RECHECK_REQUIRED"
  | "ALREADY_BUYABLE"
  | "SELLER_LISTING_TECHNICAL_DIAGNOSTICS"
  | "CATALOG_IDENTITY_ESCALATION"
  | "SELLER_CENTRAL_APPROVAL_REQUEST_AVAILABLE"
  | "SELLER_SUPPORT_QUALIFICATION_NO_APPLICATION_LINK";
export type Amazon100632Result = Readonly<{
  market: Market;
  sku: string;
  asin: string | null;
  route: Amazon100632Route;
  errors: readonly string[];
  alongside_technical_errors: readonly string[];
  counterpart_buyable: boolean;
  action: string;
  seller_central_url: string | null;
  brand_approved: false;
  can_publish: false;
  live_mutations: 0;
}>;
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const MARKETS: Market[]=["IT","DE","FR","ES"];
const ISSUE=/^[0-9]{4,10}$/;
const fixed=(input: {
 market:Market;sku:string;asin:string|null;route:Amazon100632Route;
 errors:string[];technical:string[];counterpart:boolean;action:string;url?:string|null;
}):Amazon100632Result=>({
 market:input.market,sku:input.sku,asin:input.asin,route:input.route,
 errors:input.errors,alongside_technical_errors:input.technical,
 counterpart_buyable:input.counterpart,action:input.action,
 seller_central_url:input.url??null,brand_approved:false,
 can_publish:false,live_mutations:0
});
const obj=(x:unknown):Row => x!==null&&typeof x==="object"&&!Array.isArray(x)?x as Row:{};
const rows=(x:unknown):Row[] => Array.isArray(x)?x.map(obj):[];
function statuses(row:Row): string[] {
 return Array.isArray(row.statuses)?row.statuses.filter(x=>typeof x==="string") as string[]:[];
}
function issues(row:Row):string[]{
 return [...new Set(rows(row.issue_signals).filter(x=>typeof x.code==="string"&&ISSUE.test(x.code)).map(x=>x.code as string))];
}
function sameSeller(seller:Row,market:Market,sku:string):Row|null{
 if(seller.ok!==true || seller.source!=="amazon_sp_api_get_listings_item" ||
    seller.marketplace!==market || seller.read_only!==true ||
    seller.has_created_or_updated_offer!==false) return null;
 const found=rows(seller.results).filter(x=>x.sku===sku);
 return found.length===1?found[0]:null;
}
function exactEAN(catalog:Row,market:Market,ean:string,asin:string): "EXACT"|"MISSING"|"OTHER"|"UNKNOWN" {
 const base=obj(catalog.result);
 if(catalog.ok!==true||catalog.source!=="amazon_spapi_catalog_items_live" ||
   catalog.read_only!==true||catalog.identifier_type!=="EAN"||
   base.marketplace!==market||base.complete!==true)return "UNKNOWN";
 const items=rows(base.identifiers).filter(x=>x.ean===ean);
 if(items.length!==1)return "UNKNOWN";
 const v=items[0];
 if(v.state==="EXACT_ONE"&&v.exact_match_count===1&&
   Array.isArray(v.asins)&&v.asins.length===1)return v.asins[0]===asin?"EXACT":"OTHER";
 if(v.state==="NO_EXACT_MATCH"&&v.exact_match_count===0&&
   Array.isArray(v.asins)&&v.asins.length===0)return "MISSING";
 return "UNKNOWN";
}
function asinState(catalog:Row,market:Market,asin:string):"FOUND"|"MISSING"|"UNKNOWN"{
 if(catalog.ok!==true||catalog.source!=="amazon_spapi_catalog_item_live"||
    catalog.read_only!==true||catalog.marketplace!==market)return "UNKNOWN";
 const items=rows(catalog.results).filter(x=>x.asin===asin);
 if(items.length!==1)return "UNKNOWN";
 return items[0].state==="ASIN_NOT_FOUND"?"MISSING":
   items[0].state==="READ_ONLY_DETAILS_COMPLETE"?"FOUND":"UNKNOWN";
}
function restrictions(raw:Row,market:Market,sku:string,asin:string): {
 state:"NONE"|"APPROVAL"|"ASIN_MISSING"|"OTHER"|"UNKNOWN"; url:string|null;
}{
 if(raw.ok!==true||raw.marketplace!==market||raw.read_only!==true||
    raw.provider_mutations!==0) return {state:"UNKNOWN",url:null};
 const matches=rows(raw.results).filter(x=>x.sku===sku && x.asin===asin);
 if(matches.length!==1)return {state:"UNKNOWN",url:null};
 const x=matches[0];
 const codes=Array.isArray(x.reason_codes)?x.reason_codes:[];
 const links=Array.isArray(x.seller_central_links)?x.seller_central_links:[];
 if(x.status==="NO_RESTRICTIONS_RETURNED_NOT_APPROVAL_PROOF" &&
    x.restriction_count===0 && codes.length===0 && links.length===0)
    return {state:"NONE",url:null};
 if(x.status==="RESTRICTIONS_REPORTED" && typeof x.restriction_count==="number" && x.restriction_count>0){
    if(codes.includes("ASIN_NOT_FOUND")) return {state:"ASIN_MISSING",url:null};
    if(codes.includes("APPROVAL_REQUIRED")) {
      // Trust only the exact official Amazon link for this seller ASIN.
      const valid=links.filter((u:unknown)=>typeof u==="string"&&
        u=== "https://sellercentral.amazon."+market.toLowerCase()+
          "/hz/approvalrequest/restrictions/approve?asin="+asin);
      // Amazon IT uses amazon.it; DE amazon.de; FR amazon.fr; ES amazon.es.
      return valid.length===1?{state:"APPROVAL",url:valid[0]}:{state:"OTHER",url:null};
    }
    return {state:"OTHER",url:null};
 }
 return {state:"UNKNOWN",url:null};
}
function otherBuyable(raw:unknown,market:Market,sku:string,asin:string):boolean{
 const seller=obj(raw),row=sameSeller(seller,market,sku);
 return row!==null && row.state==="PRESENT" && row.identity_state==="VERIFIED" &&
 row.asin===asin && statuses(row).includes("BUYABLE");
}
/**
 * Provide raw results from seller.listings.direct, restrictions.readonly,
 * catalog.asin.details and catalog.exact.match. No live call here.
 */
export function triageExisting100632(input: {
 market:Market; sku:string; asin:string; ean:string;
 seller:unknown; restriction:unknown; catalogAsin:unknown; catalogEan:unknown;
 counterpart?:{market:Market;seller:unknown};
}):Amazon100632Result{
 const {market,sku,asin,ean}=input;
 const invalid=!MARKETS.includes(market)||typeof sku!=="string"||!SKU.test(sku)||
   sku!==sku.trim()||typeof asin!=="string"||!ASIN.test(asin)||
   typeof ean!=="string"||!/^\d{13}$/.test(ean);
 const base={market,sku,asin:invalid?null:asin,errors:[] as string[],technical:[] as string[],
 counterpart:false};
 if(invalid)return fixed({...base,route:"RECHECK_REQUIRED",action:"INVALID_IDENTIFIERS"});
 const own=sameSeller(obj(input.seller),market,sku);
 if(!own)return fixed({...base,route:"RECHECK_REQUIRED",action:"SELLER_LISTING_UNVERIFIED"});
 const codes=issues(own);
 const technical=codes.filter(x=>x!=="100632");
 const compare=input.counterpart;
 const counterpart=!!compare&&MARKETS.includes(compare.market)&&compare.market!==market&&
   otherBuyable(compare.seller,compare.market,sku,asin);
 const data={...base,errors:codes,technical,counterpart};
 if(own.state==="PRESENT"&&statuses(own).includes("BUYABLE"))
   return fixed({...data,route:"ALREADY_BUYABLE",action:"NO_ACTION_DO_NOT_DUPLICATE"});
 if(own.state!=="PRESENT"||own.identity_state!=="VERIFIED"||own.asin!==asin)
   return fixed({...data,route:"SELLER_LISTING_TECHNICAL_DIAGNOSTICS",action:"VERIFY_EXISTING_SELLER_IDENTITY"});
 if(!codes.includes("100632"))
   return fixed({...data,route:"RECHECK_REQUIRED",action:"ISSUE_100632_NO_LONGER_VISIBLE"});
 const restriction=restrictions(obj(input.restriction),market,sku,asin);
 const catA=asinState(obj(input.catalogAsin),market,asin);
 const catE=exactEAN(obj(input.catalogEan),market,ean,asin);
 if(restriction.state==="ASIN_MISSING"||catA==="MISSING"||catE==="MISSING"||catE==="OTHER")
   return fixed({...data,route:"CATALOG_IDENTITY_ESCALATION",action:"ESCALATE_ASIN_EAN_MARKET_CATALOG_MISMATCH"});
 if(catA!=="FOUND"||catE!=="EXACT")
   return fixed({...data,route:"RECHECK_REQUIRED",action:"CATALOG_EVIDENCE_INCOMPLETE"});
 if(restriction.state==="APPROVAL")
   return fixed({...data,route:"SELLER_CENTRAL_APPROVAL_REQUEST_AVAILABLE",
     action:"MANUAL_SELLER_CENTRAL_APPROVAL_AND_SEPARATE_TECHNICAL_ISSUES",
     url:restriction.url});
 if(restriction.state==="NONE")
   return fixed({...data,route:"SELLER_SUPPORT_QUALIFICATION_NO_APPLICATION_LINK",
     action:"OPEN_SUPPORT_CASE_100632_NO_RESTRICTION_LINK"});
 return fixed({...data,route:"RECHECK_REQUIRED",action:"RESTRICTIONS_NOT_RESOLVED"});
}
