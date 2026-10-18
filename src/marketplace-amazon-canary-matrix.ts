import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";

/**
 * R3.3 pilot read-only identity classification. It never grants submission,
 * even when all four marketplaces have strong catalog identity evidence.
 * Results must be combined with seller-listing GET + restrictions + PTD,
 * owner-handoff proof, VAT/price, GPSR and order/stock/tracking readiness.
 */
type Row=Record<string,unknown>;
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Variant={
  sku:string;ean:string;vendor:string;product_type:string;title:string;
  status:"ACTIVE"|"DRAFT"|"ARCHIVED";
  inventory_quantity:number;inventory_tracked:boolean;
  inventory_levels_complete:boolean;
};
type CatalogEvidence={
  marketplace:Market;ean:string;asin:string;
  lookup_source:string;lookup_complete:boolean;lookup_state:string;
  lookup_asins:string[];
  details_source:string;details_state:string;
  brand:string;model_number:string|null;part_number:string|null;
  item_name:string|null;color:string|null;size:string|null;
  item_classification:string|null;product_types:string[];
};
const EAN_RE=/^\d{13}$/;
const SKU_RE=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const ASIN_RE=/^[A-Z0-9]{10}$/;
const MARKET_ORDER:Market[]=["IT","DE","FR","ES"];
const COLORS:Record<string,string>={
  "BLACK":"BLACK","NERO":"BLACK","NOIR":"BLACK",
  "SCHWARZ":"BLACK","NEGRO":"BLACK",
  "WHITE":"WHITE","BIANCO":"WHITE","BLANC":"WHITE",
  "WEISS":"WHITE","BLANCO":"WHITE",
  "BLUE":"BLUE","BLU":"BLUE","BLEU":"BLUE",
  "BLAU":"BLUE","AZUL":"BLUE",
  "GREY":"GREY","GRAY":"GREY","GRIGIO":"GREY",
  "GRIS":"GREY","GRAU":"GREY",
  "BEIGE":"BEIGE","BROWN":"BROWN","MARRONE":"BROWN","BRAUN":"BROWN"
};
const NON_ACCESSORY=new Set(["LABEL","STICKER","SHIPPING_LABEL","GIFT_CARD"]);
function clean(x:unknown):string{return typeof x==="string"?x.trim():"";}
function normalized(x:unknown):string{
  return clean(x).normalize("NFKC").toLocaleUpperCase().replace(/\s+/g," ");
}
function checkEan(value:string):boolean{
  if(!EAN_RE.test(value))return false;
  let sum=0;for(let i=0;i<12;i++)sum+=Number(value[i])*(i%2===0?1:3);
  return (10-sum%10)%10===Number(value[12]);
}
function verdict(marketplace:Market,asin:string,status:string,reason:string,
  extra:Row={}):Row{
  return {marketplace,asin,status,reason,...extra,
    read_only:true,can_validate_preview:false,can_create_offer:false,
    can_publish_positive_quantity:false,can_advance_stock_sync:false,
    requires_seller_listing_readback:true,
    requires_channable_writer_exclusion_proof:true};
}
export function classifyAmazonPilotCatalogIdentity(
  variant:Variant,evidences:CatalogEvidence[]
):Row{
  if(!variant||!SKU_RE.test(variant.sku)||!checkEan(variant.ean)||
      !clean(variant.vendor)||!Array.isArray(evidences)||
      variant.status!=="ACTIVE"||
      !Number.isSafeInteger(variant.inventory_quantity)||
      variant.inventory_quantity<1||variant.inventory_tracked!==true||
      variant.inventory_levels_complete!==true||
      normalized(variant.vendor)==="P448")
    throw new Error("amazon_canary_invalid_or_ineligible_shopify_variant");
  if(evidences.length!==4||new Set(evidences.map(x=>x.marketplace)).size!==4||
      MARKET_ORDER.some(x=>!evidences.some(e=>e.marketplace===x)))
    throw new Error("amazon_canary_requires_exactly_four_market_observations");
  const results:Row[]=[];
  const variantColor=normalized(variant.sku.split("_").at(-1));
  const knownColor=COLORS[variantColor]??null;
  const isBag=/pochette|borsell|borsa|borse|zain|bag|backpack|handbag|wallet|portafogli/i.test(variant.product_type);
  for(const m of MARKET_ORDER){
    const e=evidences.find(x=>x.marketplace===m)!;
    if(!Object.hasOwn(AMAZON_EU_MARKETPLACES,m)||e.ean!==variant.ean||
       !ASIN_RE.test(e.asin)||!Array.isArray(e.lookup_asins)||
       !Array.isArray(e.product_types)||!e.product_types.length)
      throw new Error("amazon_canary_evidence_shape_invalid");
    if(e.lookup_source!=="amazon_spapi_catalog_items_live"||
       e.lookup_complete!==true||e.lookup_state!=="EXACT_ONE"||
       e.lookup_asins.length!==1||e.lookup_asins[0]!==e.asin||
       e.details_source!=="amazon_spapi_catalog_item_live"||
       e.details_state!=="READ_ONLY_DETAILS_COMPLETE"){
      results.push(verdict(m,e.asin,"BLOCKED","amazon_live_identity_evidence_incomplete"));
      continue;
    }
    if(normalized(e.brand)!==normalized(variant.vendor)){
      results.push(verdict(m,e.asin,"BLOCKED","brand_conflict"));
      continue;
    }
    if(normalized(e.item_classification).includes("PARENT")){
      results.push(verdict(m,e.asin,"BLOCKED","non_sellable_parent_asin"));
      continue;
    }
    if(isBag&&e.product_types.map(normalized).every(t=>NON_ACCESSORY.has(t))){
      results.push(verdict(m,e.asin,"BLOCKED","clearly_incompatible_product_type"));
      continue;
    }
    if(e.model_number&&e.model_number!==variant.sku){
      results.push(verdict(m,e.asin,"BLOCKED","amazon_model_number_conflicts_with_shopify_sku"));
      continue;
    }
    // A part number may identify either the physical GTIN or a style SKU.
    // If neither is equal, it cannot establish identity alone.
    const partMatch=e.part_number===variant.ean||e.part_number===variant.sku;
    if(e.part_number&&!partMatch){
      results.push(verdict(m,e.asin,"REVIEW_REQUIRED","amazon_part_number_unverified"));
      continue;
    }
    const remoteColor=COLORS[normalized(e.color)]??null;
    if(knownColor&&remoteColor&&knownColor!==remoteColor){
      results.push(verdict(m,e.asin,"BLOCKED","localized_color_conflict"));
      continue;
    }
    if(!e.model_number||!partMatch||!knownColor||!remoteColor){
      results.push(verdict(m,e.asin,"REVIEW_REQUIRED",
        "missing_model_part_or_localized_color_proof",{
          model_exact:e.model_number===variant.sku,
          part_matches_sku_or_ean:partMatch,locale_color_verified:!!knownColor&&knownColor===remoteColor
        }));
      continue;
    }
    results.push(verdict(m,e.asin,"CATALOG_IDENTITY_STRONG",
      "model_part_brand_color_match",{
        model_exact:true,part_matches_sku_or_ean:true,
        locale_color_verified:true,source:"amazon_spapi_catalog_read_only"
      }));
  }
  const strong=results.filter(x=>x.status==="CATALOG_IDENTITY_STRONG").length;
  const blocked=results.filter(x=>x.status==="BLOCKED").length;
  const review=results.filter(x=>x.status==="REVIEW_REQUIRED").length;
  return {
    ok:true,sku:variant.sku,ean:variant.ean,
    warehouse_available_observed:variant.inventory_quantity,
    strong_catalog_identity_market_count:strong,
    review_required_market_count:review,
    blocked_market_count:blocked,
    markets:results,
    overall_status:blocked>0?"CATALOG_IDENTITY_BLOCKED":
      review>0?"CATALOG_IDENTITY_REVIEW_REQUIRED":"CATALOG_IDENTITY_STRONG_ALL_MARKETS",
    source:"mare_canary_catalog_identity_evidence",
    read_only:true,seller_listing_state:"UNVERIFIED",
    missing_mandatory_gates:[
      "seller_id_server_scope_and_listings_items_get",
      "seller_offer_absence_or_existing_offer_handling",
      "product_type_definition_schema_and_gpsr",
      "marketplace_price_policy",
      "channable_listing_writer_ownership",
      "order_importer_proof",
      "stock_by_location_and_fulfillment_tracking"
    ],
    can_validate_preview:false,can_create_offer:false,
    can_publish_positive_quantity:false,can_advance_stock_sync:false
  };
}
