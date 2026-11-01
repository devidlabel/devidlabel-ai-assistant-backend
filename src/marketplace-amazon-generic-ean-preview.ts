import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth.js";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces.js";
import { researchAmazonNewAsinProductType } from "./marketplace-amazon-new-asin-research.js";
import { shopifyGraphQL } from "./index.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/** Generic EAN new-ASIN diagnostic: VALIDATION_PREVIEW only, no live listing write. */
type Row=Record<string,unknown>;
type Market=keyof typeof AMAZON_EU_MARKETPLACES;
type Env=AmazonCredentials & MareBusinessShopifyEnv & {
  AMAZON_SP_API_SELLER_ID?:string;AMAZON_OFFER_PREVIEW_ENABLED?:string;
};
type Deps={research?:typeof researchAmazonNewAsinProductType;
  readShopify?:typeof shopifyGraphQL;
  getAccessToken?:typeof getAmazonAccessToken;fetch?:typeof fetch};
const PRODUCT_TYPES=new Set(["SOCKS","HANDBAG","SHIRT","COAT","HAT","BOOT","BACKPACK","COSMETIC_CASE","STORAGE_BAG","SWEATER","SWEATSHIRT","SCARF"]);
const MARKET_LOCALE:Record<Market,string>={IT:"it_IT",DE:"de_DE",FR:"fr_FR",ES:"es_ES"};
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const EAN=/^\d{13}$/;
const SELLER=/^[A-Z0-9]{8,30}$/;
const REF=/^[A-Za-z0-9._:-]{1,128}$/;
const ISSUE_CODE=/^[A-Za-z0-9_.-]{1,64}$/;
const FIELD=/^[a-z][a-z0-9_]{0,119}$/;
const MAX_BYTES=128000;
const COLOR_QUERY='query GenericEanColorEvidence($colorId:ID!){metaobject(id:$colorId){id type displayName fields{key type value}}}';
const COLOR_GID=/^gid:\/\/shopify\/Metaobject\/[1-9]\d{0,24}$/;
const PRIVATE_QUERY='query GenericEanValidationEvidence($variantId:ID!){productVariant(id:$variantId){id sku barcode price compareAtPrice selectedOptions{name value} inventoryItem{countryCodeOfOrigin} product{id title description vendor status amazonPtd:metafield(namespace:"custom",key:"amazon_product_attributes"){type value} fabric:metafield(namespace:"marketplace",key:"fabric_composition"){type value} bullets:metafield(namespace:"marketplace",key:"bullet_points"){type value} colorRef:metafield(namespace:"features",key:"color"){type value} model:metafield(namespace:"custom",key:"marketplace_model_name"){type value} gender:metafield(namespace:"custom",key:"navigation_gender"){type value}}}}';

/** Merchant-attested, source-scoped product evidence for Refrigiwear and K-Way.
 * Brand, SKU and source Product GID must match. No inferred origin, supplier
 * certification or safety claims; logistics defaults are not product dimensions.
 */
function refrigiwearEvidenceAttrs(product:Row,variant:Row,sku:string,pt:string,
  marketplace:string,marketId:string,available:string[],ptdAlphaTokens:Row={}):Row{
  const isRefrigiwear=sku.startsWith("RFR_")&&product.vendor==="Refrigiwear";
  const isKway=sku.startsWith("KWAY_")&&product.vendor==="K-Way";
  if(!isRefrigiwear&&!isKway)return {};
  if(!["COAT","HAT","SHIRT","BACKPACK","SCARF","SWEATER","SWEATSHIRT",
        "HANDBAG","COSMETIC_CASE","STORAGE_BAG"].includes(pt)||
     marketplace!=="IT")return {};
  const mf=obj(product.amazonPtd);
  if(mf.type!=="json"||typeof mf.value!=="string")return {};
  let fields:Row;
  try{fields=obj(obj(JSON.parse(mf.value)).amazon_ptd_evidence);}
  catch{return {};}
  const enriched=obj(JSON.parse(mf.value));
  const sourceId=obj(enriched).source_product_id;
  const isClark=fields.source_scope==="Clark Hat B31908 MA9083 A00010 WHITE ONLY";
  if(isKway){
    // A generic supplier note cannot silently authorize another K-Way model.
    if(fields.source_scope!=="K-WAY_PRODUCT_VERIFIED_BY_MERCHANT"||
       sourceId!==product.id)return {};
  }else if((isClark&&(sku!=="RFR_B31908_MA9083_A00010_UN"||
       product.title!=="Berretto Clark White"||pt!=="HAT"))||
     (!isClark&&typeof sourceId!=="string"))return {};
  const val=(name:string):string|undefined=>{
    const s=fields[name];
    return typeof s==="string"&&s.length>1&&s.length<250&&
      !/[\u0000-\u001f<>]/.test(s)?s:undefined;
  };
  const attrs:Row={};
  const set=(name:string,value:unknown)=>{
    if(available.includes(name))attrs[name]=value;
  };
  const locale="it_IT";
  const text=(value:string)=>[{value,language_tag:locale,marketplace_id:marketId}];
  for(const [key,source] of [
    ["item_type_name","item_type_name"],
    ["department","department"],
    ["age_range_description","age_range_description"],
    ["care_instructions","care_instructions"],
    ["style","style"],["weave_type","weave_type"]
  ]){
    const v=val(source);
    if(v)set(key,text(v));
  }
  const closure=val("closure");
  if(closure)set("closure",[{type:[{value:closure,language_tag:locale}],marketplace_id:marketId}]);
  const special=val("special_size_type");
  if(special&&pt!=="HAT")set("special_size_type",text(special));
  const water=val("water_resistance_level");
  const levels:Record<string,string>={
    "Idrorepellente":"water_repellent",
    "Resistente all'acqua":"water_resistant",
    "Impermeabile":"waterproof",
    "Non idrorepellente":"not_water_resistant"
  };
  if(water&&levels[water])set("water_resistance_level",[
    {value:levels[water],marketplace_id:marketId}]);
  const fabric=val("fabric_type");
  if(fabric&&validatedRefrigiwearFabric(fabric))
    set("fabric_type",text(fabric));
  const material=val("material");
  if(material)set("material",text(material));
  const fit=val("fit_type");
  if(fit)set("fit_type",text(fit));
  const collar=val("collar_style");
  if(collar)set("collar_style",text(collar));
  const strap=val("strap_type");
  if(strap)set("strap_type",text(strap));
  const lining=val("lining_description");
  if(lining)set("lining_description",text(lining));
  if(pt==="BACKPACK"&&val("size"))set("size",text(val("size")!));
  const n=fields.number_of_compartments;
  if(["BACKPACK","HANDBAG"].includes(pt)&&typeof n==="number"&&
     Number.isInteger(n)&&n>=1&&n<=15)
    set("number_of_compartments",[{value:n,marketplace_id:marketId}]);
  const pockets=fields.number_of_pockets;
  if(isKway&&pt==="HANDBAG"&&typeof pockets==="number"&&
     Number.isInteger(pockets)&&pockets>=0&&pockets<=30)
    set("number_of_pockets",[{value:pockets,marketplace_id:marketId}]);
  const inner=val("inner_material");
  if(isKway&&pt==="HANDBAG"&&inner)
    set("inner",[{material:[{value:inner,language_tag:locale}],
      marketplace_id:marketId}]);
  const sizeInfo=val("size_info");
  if(isKway&&pt==="HANDBAG"&&sizeInfo)
    set("size_info",[{display_name:[{value:sizeInfo,language_tag:locale}],
      marketplace_id:marketId}]);
  const volume=fields.storage_volume_liters;
  if(typeof volume==="number"&&volume>0&&volume<=1000)
    set("storage_volume",[{value:volume,unit:"liters",marketplace_id:marketId}]);
  const size3=obj(fields.item_dimensions_cm);
  if(["height","width","depth"].every(x=>
       typeof size3[x]==="number"&&(size3[x] as number)>0&&
       (size3[x] as number)<500))
    set("item_depth_width_height",[{height:{value:size3.height,unit:"centimeters"},
      width:{value:size3.width,unit:"centimeters"},
      depth:{value:size3.depth,unit:"centimeters"},marketplace_id:marketId}]);
  const operator=val("manufacturer_brand_operator");
  if(operator&&fields.manufacturer_status===
    "LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN")
    set("manufacturer",text(operator));
  const outer=val("outer_material");
  if(outer)set("outer",[{material:[{value:outer,language_tag:locale}],
    marketplace_id:marketId}]);
  // Amazon's as6/alpha schema is explicitly researched for this product.
  const size=val("headwear_size");
  const sizeAliases=new Set(["One Size","Taglia unica","Taglia Unica","UN","OSFA","OSFM"]);
  if(size&&sizeAliases.has(size)){
    const officialTokens=ptdAlphaTokens.headwear_size;
    const mapped=Array.isArray(officialTokens)&&officialTokens.includes("one_size")?
      "one_size":size==="Taglia Unica"?"Taglia unica":size;
    set("headwear_size",[{size:mapped,size_system:"as6",
      size_class:"alpha",marketplace_id:marketId}]);
  }
  if(size)set("special_size_type",[{value:"Standard",
    marketplace_id:marketId}]);
  if(fields.batteries_required===false)
    set("batteries_required",[{value:false,marketplace_id:marketId}]);
  const dg=val("supplier_declared_dg_hz_regulation");
  if(dg)set("supplier_declared_dg_hz_regulation",[{value:dg,
    marketplace_id:marketId}]);
  const logistics=obj(fields.logistics_defaults);
  const dimensions=obj(logistics.item_package_dimensions_cm);
  const weight=logistics.item_package_weight_kg;
  if(["MERCHANT_GLOBAL_DEFAULT_FROM_2026_10_28_MARKETPLACE_PROJECT",
       "MERCHANT_GLOBAL_DEFAULT_MARKETPLACE_2026_10_27_AND_28_UNMEASURED_ESTIMATE"].includes(String(logistics.source))&&
     [dimensions.length,dimensions.width,dimensions.height].every(x=>
       typeof x==="number"&&Number.isFinite(x)&&x>0&&x<=80)&&
     typeof weight==="number"&&Number.isFinite(weight)&&weight>0&&weight<=3){
    set("item_package_dimensions",[{
      length:{value:dimensions.length,unit:"centimeters"},
      width:{value:dimensions.width,unit:"centimeters"},
      height:{value:dimensions.height,unit:"centimeters"},
      marketplace_id:marketId
    }]);
    set("item_package_weight",[{value:weight,unit:"kilograms",
      marketplace_id:marketId}]);
  }
  // MSRP only; no purchasable_offer, seller price or stock mutation.
  const list=typeof variant.compareAtPrice==="string"?
    Number(variant.compareAtPrice):NaN;
  if(Number.isFinite(list)&&list>0&&list<10000)
    set("list_price",[{currency:"EUR",value_with_tax:list,
      marketplace_id:marketId}]);
  return attrs;
}

/** Only source-backed percentages in the existing Shopify evidence metafield.
 * Validate the complete 100% composition without inventing, normalizing or
 * dropping components. The source must still be verified before writing it.
 */
export function validatedRefrigiwearFabric(value:string):boolean{
  if(typeof value!=="string"||value.length>120)return false;
  const parts=value.split(", ");
  if(parts.length<1||parts.length>3)return false;
  const allowed=new Set(["Nylon","Cotone","Poliestere","Elastan","Acrilico","Poliammide","Viscosa","Lana"]);
  let sum=0;
  const seen=new Set<string>();
  for(const part of parts){
    const match=/^([1-9][0-9]{0,2})% ([A-Za-z]+)$/.exec(part);
    if(!match||!allowed.has(match[2])||seen.has(match[2]))return false;
    const pct=Number(match[1]);
    if(pct>100)return false;
    seen.add(match[2]);sum+=pct;
  }
  return sum===100;
}
function safeModel(raw:unknown):raw is string {
  return typeof raw==="string"&&raw.length>=2&&raw.length<=80&&raw===raw.trim()&&
    !/[\u0000-\u001f\u007f<>]/.test(raw);
}
function obj(v:unknown):Row{return v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}
// Merchant-authored public Shopify prose is copy, never evidence for
// material composition, origin, manufacturer, GPSR or package specifications.
// No automatic translation: the canonical copy is emitted only for Amazon IT.
function safeItalianDescription(raw:unknown):string|undefined{
  if(typeof raw!=="string")return undefined;
  const value=raw.trim();
  return value.length>=30&&value.length<=2000&&
    !/[\u0000-\u001f\u007f<>]/.test(value)?value:undefined;
}
// Only the merchant's dedicated, typed marketplace metafield is eligible
// for bullet points. Amazon bullet arrays are capped at five for this pilot.
function verifiedMarketplaceBullets(raw:unknown):{ok:boolean;values:string[]}{
  if(raw===null||raw===undefined)return {ok:true,values:[]};
  const field=obj(raw);
  if(field.type!=="list.single_line_text_field"||
     typeof field.value!=="string"||field.value.length>2500)return {ok:false,values:[]};
  let parsed:unknown;
  try{parsed=JSON.parse(field.value);}catch{return {ok:false,values:[]};}
  if(!Array.isArray(parsed)||parsed.length<1||parsed.length>8 ||
     parsed.some(v=>typeof v!=="string"||v.length<5||v.length>240||
       v!==v.trim()||/[\u0000-\u001f\u007f<>]/.test(v))||
     new Set(parsed.map((v:string)=>v.toLocaleLowerCase("it"))).size!==parsed.length)
    return {ok:false,values:[]};
  return {ok:true,values:(parsed as string[]).slice(0,5)};
}
// Only explicit single-component merchant composition can be a fabric_type
// preview hint. This is not supplier-certified composition or GPSR evidence.
function singleMerchantFabric(raw:unknown):{ok:boolean;value?:string}{
  if(raw===null||raw===undefined)return {ok:true};
  const field=obj(raw);
  if(field.type!=="single_line_text_field"||typeof field.value!=="string"||
     field.value!==field.value.trim()||field.value.length>280||
     /[\u0000-\u001f\u007f<>]/.test(field.value))
    return {ok:false};
  // Never flatten multilayer, mixed or percentage-unknown garments into
  // a false single-fabric assertion. Those require supplier evidence.
  const match=/^100% ([\p{L}]+(?: [\p{L}]+)?)$/u.exec(field.value);
  if(!match||match[1].length>60)return {ok:true};
  return {ok:true,value:field.value};
}
function fabricShapeVerified(research:Row):boolean{
  if(research.ptd_technical_shapes_read_only!==true||
     research.ptd_technical_shapes_no_values_supplied!==true)return false;
  const shape=obj(obj(research.ptd_technical_shapes).fabric_type);
  const item=obj(shape.items),p=obj(item.properties),required=item.required;
  return shape.type==="array"&&item.type==="object"&&
    obj(p.value).type==="string"&&
    obj(p.value).conditional_review_required!==true&&
    obj(p.language_tag).reference_resolution_required===true&&
    obj(p.marketplace_id).reference_resolution_required===true&&
    Array.isArray(required)&&required.includes("value")&&
    required.includes("language_tag")&&
    item.conditional_review_required!==true&&
    shape.conditional_review_required!==true;
}

// Product Type Definitions are fetched fresh for the marketplace. Never
// assume IT size_system values apply to DE, FR or ES. No size guessed from SKU.
function strictSizeOption(raw:unknown):{ok:boolean;size?:string;sizeClass?:string}{
  if(!Array.isArray(raw))return {ok:false};
  const matches=raw.map(obj).filter(o=>typeof o.name==="string"&&
    ["taglia","size"].includes(o.name.toLowerCase().trim()));
  if(matches.length>1)return {ok:false};
  if(matches.length===0)return {ok:true};
  const value=matches[0].value;
  if(typeof value!=="string"||value!==value.trim()||value.length>12)
    return {ok:false};
  if(/^(XXS|XS|S|M|L|XL|XXL|XXXL)$/.test(value))
    return {ok:true,size:value,sizeClass:"alpha"};
  if(/^[2-5][0-9]$/.test(value))
    return {ok:true,size:value,sizeClass:"numeric"};
  // One-size, mixed units and non-standard labels need explicit mapping.
  return {ok:true};
}
// BOOT accepts only an exact, merchant-declared EU footwear number. A
// US/UK size, a SKU suffix, a title or a one-size label is not convertible.
function strictEuBootOption(raw:unknown):{ok:boolean;size?:string;sizeClass?:string}{
  if(!Array.isArray(raw))return {ok:false};
  const opts=raw.map(obj).filter(o=>typeof o.name==="string"&&
    ["numero","taglia","size","shoe size"].includes(o.name.toLowerCase().trim()));
  if(opts.length>1)return {ok:false};
  if(opts.length===0)return {ok:true};
  const value=opts[0].value;
  if(typeof value!=="string"||value.length>12||value!==value.trim())
    return {ok:false};
  const match=/^((?:3[0-9]|4[0-9]|50)) EU$/.exec(value);
  if(!match)return {ok:true};
  return {ok:true,size:match[1],sizeClass:"numeric"};
}
function structuredSizeFromPtd(research:Row,selectedOptions:unknown,pt:string):
  {ok:boolean;attribute?:string;value?:Row}{
  const field=pt==="SHIRT"?"shirt_size":["COAT","SWEATER","SWEATSHIRT"].includes(pt)?"apparel_size":
    pt==="BOOT"?"footwear_size":null;
  if(!field||!research.available_schema_attribute_names ||
     !Array.isArray(research.available_schema_attribute_names)||
     !research.available_schema_attribute_names.includes(field))return {ok:true};
  const sizeShape=obj(research.ptd_size_shapes)[field];
  if(sizeShape===undefined)return {ok:true};
  if(research.ptd_size_shapes_are_read_only!==true||
     research.ptd_size_shapes_not_schema_validation!==true||
     research.ptd_size_mapping_not_performed!==true)
    return {ok:false};
  const option=pt==="BOOT"?strictEuBootOption(selectedOptions):
    strictSizeOption(selectedOptions);
  if(!option.ok)return {ok:false};
  if(!option.size||!option.sizeClass)return {ok:true};
  const shape=obj(sizeShape),item=obj(shape.items),p=obj(item.properties);
  const systems=obj(p.size_system).enum,classes=obj(p.size_class).enum;
  const requires=item.required;
  if(shape.type!=="array"||item.type!=="object"||
     obj(p.size).type!=="string"||
     !Array.isArray(systems)||systems.length!==1||
     typeof systems[0]!=="string"||!/^[a-z0-9_]{1,24}$/.test(systems[0])||
     !Array.isArray(classes)||!classes.includes(option.sizeClass)||
     obj(p.size_class).type!=="string"||obj(p.size_system).type!=="string"||
     !Array.isArray(requires)||!requires.includes("size_class")||
     !requires.includes("size_system")||
     (pt==="BOOT"&&(
       systems[0]!=="eu_footwear_size_system"||
       !requires.includes("size")||
       obj(p.marketplace_id).reference_resolution_required!==true
     ))||
     shape.conditional_review_required===true||item.conditional_review_required===true)
    return {ok:false};
  // PTD enum tokens are often lowercase (e.g. "s") while Shopify labels
  // are uppercase ("S"). Use only tokens observed in Amazon's live schema.
  const tokens=obj(research.ptd_alpha_size_tokens)[field];
  const wanted=option.sizeClass==="alpha"?option.size.toLowerCase():null;
  const official=wanted&&Array.isArray(tokens)&&tokens.includes(wanted);
  const labels=obj(obj(research.ptd_alpha_size_label_tokens)[field]);
  const fromPtd=option.sizeClass==="alpha"?labels[option.size]:undefined;
  const mapped=typeof fromPtd==="string"&&/^[a-z][a-z0-9_]{0,63}$/.test(fromPtd)?
    fromPtd:undefined;
  // XL must never silently fall back to a display label known to be
  // ambiguous with Amazon's conditional enum code.
  if(option.sizeClass==="alpha"&&["XXS","XS","XL","XXL","XXXL"].includes(option.size)&&
     !official&&!mapped)return {ok:false};
  const resolved=mapped??(official?wanted:option.size);
  return {ok:true,attribute:field,value:{
    size:resolved,size_class:option.sizeClass,size_system:systems[0]}};
}

/** Strict single-value seller-curated Shopify metadata, not title inference.
 * Multiple navigation targets are ambiguous and intentionally omitted. */
function genderFromMerchant(raw:unknown):{ok:boolean;value?:string}{
  if(raw===null||raw===undefined)return {ok:true};
  const metafield=obj(raw);
  if(metafield.type!=="list.single_line_text_field"||
      typeof metafield.value!=="string"||metafield.value.length>200)
    return {ok:false};
  let values:unknown;
  try{values=JSON.parse(metafield.value);}catch{return {ok:false};}
  if(!Array.isArray(values)||values.length>5||
     values.some(v=>typeof v!=="string"||
       !["Uomo","Donna","Unisex"].includes(v)))
    return {ok:false};
  if(values.length!==1)return {ok:true};
  const mapping:Record<string,string>={Uomo:"male",Donna:"female",Unisex:"unisex"};
  return {ok:true,value:mapping[values[0] as string]};
}
function eanValid(s:string):boolean{
  if(!EAN.test(s))return false;
  let total=0;for(let i=0;i<12;i++)total+=Number(s[i])*(i%2===0?1:3);
  return (10-total%10)%10===Number(s[12]);
}
function blocked(marketplace:string,sku:string,productType:string,reason:string):Row{
  return {ok:false,status:"BLOCKED_PREVIEW",marketplace,sku,product_type:productType,reason,
    preview_only:true,provider_mutations:0,product_created:false,can_publish:false,
    listing_write_enabled:false,channable_handoff_performed:false,
    brand_authorization_proven:false,gpsr_compliance_proven:false,
    full_schema_validated:false};
}
export async function previewAmazonGenericEanValidation(
  raw:unknown,env:Env,deps:Deps={},
):Promise<Row>{
  const arg=obj(raw);
  if(Object.keys(arg).length!==3||
     typeof arg.marketplace!=="string"||
     !Object.hasOwn(AMAZON_EU_MARKETPLACES,arg.marketplace)||
     typeof arg.sku!=="string"||!SKU.test(arg.sku)||arg.sku!==arg.sku.trim()||
     typeof arg.product_type!=="string"||!PRODUCT_TYPES.has(arg.product_type))
    throw new Error("amazon_generic_ean_preview_invalid_request");
  const marketplace=arg.marketplace as Market,sku=arg.sku,pt=arg.product_type;
  if(env.AMAZON_OFFER_PREVIEW_ENABLED!=="true")
    return blocked(marketplace,sku,pt,"amazon_validation_preview_disabled");
  if(typeof env.AMAZON_SP_API_SELLER_ID!=="string"||!SELLER.test(env.AMAZON_SP_API_SELLER_ID))
    return blocked(marketplace,sku,pt,"seller_identity_not_verified");
  let research:Row;
  try{research=obj(await(deps.research??researchAmazonNewAsinProductType)(
    {marketplace,sku,product_type:pt},env));}
  catch{return blocked(marketplace,sku,pt,"read_only_research_failed");}
  const shop=obj(research.shopify),ean=shop.ean,title=shop.product_title,brand=shop.amazon_listing_brand;
  if(research.ok!==true||research.status!=="REQUIREMENTS_REVIEW_REQUIRED"||
     research.marketplace!==marketplace||research.sku!==sku||research.product_type!==pt||
     research.seller_listing_state!=="VERIFIED_ABSENT"||
     research.ean_match_state!=="NO_EXACT_MATCH"||
     research.ean_absence_not_catalog_absence_proof!==true||
     research.read_only!==true||research.provider_mutations!==0||
     research.can_publish!==false||research.product_payload_constructed!==false||
     research.validation_preview_sent!==false||
     research.schema_enforced!==true||research.schema_requirements!=="LISTING"||
     research.full_schema_validated!==false||research.brand_authorization_proven!==false||
     research.gpsr_compliance_proven!==false||
     !Array.isArray(research.required_attribute_names)||
     !Array.isArray(research.available_schema_attribute_names)||
     !research.available_schema_attribute_names.includes("externally_assigned_product_identifier")||
     !research.required_attribute_names.includes("item_name")||
     !research.required_attribute_names.includes("brand")||
     (research.title_category_conflict_detected===true &&
      !(pt==="SOCKS"&&research.product_type_discovery_source==="AMAZON_KEYWORDS_SHOPIFY_SOCKS")&&
      !(pt==="COAT"&&sku.startsWith("RFR_")&&brand==="Refrigiwear"&&
        research.product_type_discovery_source==="AMAZON_KEYWORDS_REFRIGIWEAR_COAT")&&
      !(pt==="COAT"&&sku.startsWith("KWAY_")&&brand==="K-Way"&&
        research.product_type_discovery_source==="AMAZON_KEYWORDS_KWAY_COAT"))||
     !eanValid(ean as string)||
     (shop.upc!==null&&shop.upc!==undefined)||
     typeof title!=="string"||!title.trim()||title.length>200||
     typeof brand!=="string"||!brand.trim()||brand.length>100||
     !Number.isSafeInteger(shop.shopify_available)||(shop.shopify_available as number)<0||
     ((shop.shopify_available as number)===0&&
      !(sku.startsWith("RFR_")&&brand==="Refrigiwear"))||
     typeof shop.variant_id!=="string"||
     !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/.test(shop.variant_id))
    return blocked(marketplace,sku,pt,"generic_ean_research_or_identity_unverified");
  // A second merchant-private read must match the SKU/title/vendor from the
  // fresh Amazon research. No inference from photos, title, HS code or barcode.
  let privateData:Row;
  try{privateData=obj(await(deps.readShopify??shopifyGraphQL)(
    env,PRIVATE_QUERY,{variantId:shop.variant_id}));}
  catch{return blocked(marketplace,sku,pt,"shopify_private_attributes_unavailable");}
  const v=obj(privateData.productVariant),p=obj(v.product),m=obj(p.model);
  const gender=genderFromMerchant(p.gender);
  if(!gender.ok)return blocked(marketplace,sku,pt,"shopify_navigation_gender_invalid");
  if(v.id!==shop.variant_id||v.sku!==sku||v.barcode!==ean||p.title!==title||
     p.vendor!==shop.brand||p.status!=="ACTIVE"||
     (m.value!==undefined&&m.value!==null&&
       (m.type!=="single_line_text_field"||!safeModel(m.value))))
    return blocked(marketplace,sku,pt,"shopify_private_identity_or_model_unverified");
  const declaredOrigin=obj(v.inventoryItem).countryCodeOfOrigin;
  if(declaredOrigin!==null&&declaredOrigin!==undefined&&
     (typeof declaredOrigin!=="string"||!/^[A-Z]{2}$/.test(declaredOrigin)))
    return blocked(marketplace,sku,pt,"shopify_inventory_origin_invalid");
  const merchantModel=safeModel(m.value)?m.value:undefined;
  const merchantOrigin=typeof declaredOrigin==="string"?declaredOrigin:undefined;
  // A product-level Shopify feature color is accepted only after a second
  // bounded metaobject read. Never infer from title, photos or marketing copy.
  let verifiedColor:string|undefined;
  if(p.colorRef!==null&&p.colorRef!==undefined&&
     research.available_schema_attribute_names.includes("color")){
    const ref=obj(p.colorRef);
    if(ref.type!=="metaobject_reference"||
       typeof ref.value!=="string"||!COLOR_GID.test(ref.value))
      return blocked(marketplace,sku,pt,"shopify_color_reference_invalid");
    let colorData:Row;
    try{colorData=obj(await(deps.readShopify??shopifyGraphQL)(
      env,COLOR_QUERY,{colorId:ref.value}));}
    catch{return blocked(marketplace,sku,pt,"shopify_feature_color_unavailable");}
    const meta=obj(colorData.metaobject),fields=meta.fields;
    const names=Array.isArray(fields)?fields.map(obj).filter(f=>f.key==="name"):[];
    const name=meta.displayName;
    if(meta.id!==ref.value||meta.type!=="product_feature_color"||
       typeof name!=="string"||name.length<2||name.length>60||
       name!==name.trim()||/[\u0000-\u001f\u007f<>]/.test(name)||
       names.length!==1||names[0].type!=="single_line_text_field"||
       names[0].value!==name||!Array.isArray(v.selectedOptions))
      return blocked(marketplace,sku,pt,"shopify_feature_color_identity_invalid");
    const colorOptions=v.selectedOptions.map(obj).filter(o=>
      typeof o.name==="string"&&["colore","color"].includes(o.name.toLowerCase().trim()));
    if(colorOptions.length>1||colorOptions.some(o=>
      typeof o.value!=="string"||o.value.toLowerCase().trim()!==name.toLowerCase()))
      return blocked(marketplace,sku,pt,"shopify_variant_color_conflicts_with_product");
    verifiedColor=name;
  }
  // The Shopify description is merchant-facing marketing copy, not a
  // supplier-certified attribute. No language-tag laundering in DE/FR/ES.
  const hasDescriptionSchema=research.available_schema_attribute_names.includes("product_description");
  const hasBulletSchema=research.available_schema_attribute_names.includes("bullet_point");
  const merchantDescription=marketplace==="IT"&&hasDescriptionSchema?
    safeItalianDescription(p.description):undefined;
  const bullets=marketplace==="IT"&&hasBulletSchema?
    verifiedMarketplaceBullets(p.bullets):{ok:true,values:[]};
  if(!bullets.ok)return blocked(marketplace,sku,pt,"shopify_marketplace_bullets_invalid");
  const merchantFabric=marketplace==="IT"&&
    research.available_schema_attribute_names.includes("fabric_type")?
    singleMerchantFabric(p.fabric):{ok:true};
  if(!merchantFabric.ok)return blocked(marketplace,sku,pt,"shopify_merchant_fabric_invalid");
  if(merchantFabric.value&&!fabricShapeVerified(research))
    return blocked(marketplace,sku,pt,"amazon_ptd_fabric_schema_unverified");
  const merchantSize=structuredSizeFromPtd(research,v.selectedOptions,pt);
  if(!merchantSize.ok)return blocked(marketplace,sku,pt,"shopify_size_or_amazon_ptd_size_unverified");
  const sizeShape=obj(obj(research.ptd_size_shapes)[pt==="SHIRT"?"shirt_size":"apparel_size"]);
  const sizeProps=obj(obj(sizeShape.items).properties);
  const regularFit=["COAT","SHIRT","SWEATER","SWEATSHIRT"].includes(pt)&&
    (sku.startsWith("RFR_")||sku.startsWith("KWAY_"))&&
    merchantSize.attribute===(pt==="SHIRT"?"shirt_size":"apparel_size")&&merchantSize.value&&
    Array.isArray(obj(sizeProps.body_type).enum)&&
    (obj(sizeProps.body_type).enum as string[]).includes("regular")&&
    Array.isArray(obj(sizeProps.height_type).enum)&&
    (obj(sizeProps.height_type).enum as string[]).includes("regular");
  const mappedSize=regularFit?{...merchantSize.value,
    body_type:"regular",height_type:"regular"}:merchantSize.value;
  const marketId=AMAZON_EU_MARKETPLACES[marketplace];
  const attributes={
    brand:[{value:brand,marketplace_id:marketId}],
    item_name:[{value:title,marketplace_id:marketId,language_tag:MARKET_LOCALE[marketplace]}],
    externally_assigned_product_identifier:[{value:ean,type:"ean",marketplace_id:marketId}],
    ...(merchantModel?{model_name:[{value:merchantModel,marketplace_id:marketId}]}:{}),
    ...(merchantOrigin?{country_of_origin:[{value:merchantOrigin,marketplace_id:marketId}]}:{}),
    ...(gender.value&&research.available_schema_attribute_names.includes("target_gender")?
      {target_gender:[{value:gender.value,marketplace_id:marketId}]}:{}),
    ...(verifiedColor?{color:[{value:verifiedColor,marketplace_id:marketId}]}:{}),
    ...(merchantDescription?{product_description:[{
      value:merchantDescription,marketplace_id:marketId,language_tag:"it_IT"}]}:{}),
    ...(bullets.values.length?{bullet_point:bullets.values.map(value=>({
      value,marketplace_id:marketId,language_tag:"it_IT"}))}:{}),
    ...(merchantSize.attribute&&merchantSize.value?{[merchantSize.attribute]:[{
      ...mappedSize,marketplace_id:marketId}]}:{}),
    ...(merchantFabric.value?{fabric_type:[{
      value:merchantFabric.value,language_tag:"it_IT",marketplace_id:marketId}]}:{}),
    ...refrigiwearEvidenceAttrs(p,v,sku,pt,marketplace,marketId,
      research.available_schema_attribute_names as string[],obj(research.ptd_alpha_size_tokens)),
  };
  let token:string;
  try{token=await(deps.getAccessToken??getAmazonAccessToken)(env);}
  catch{return blocked(marketplace,sku,pt,"amazon_auth_failed");}
  if(typeof token!=="string"||!token||token.length>16384||/[\u0000-\u0020\u007f]/.test(token))
    return blocked(marketplace,sku,pt,"amazon_auth_invalid");
  const url=new URL("https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/"+
    encodeURIComponent(env.AMAZON_SP_API_SELLER_ID)+"/"+encodeURIComponent(sku));
  url.searchParams.set("marketplaceIds",marketId);
  url.searchParams.set("mode","VALIDATION_PREVIEW");
  const signal=AbortSignal.timeout(20000);
  let response:Response;
  try{response=await(deps.fetch??fetch)(url.toString(),{
    method:"PUT",redirect:"manual",signal,
    headers:{"x-amz-access-token":token,"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({productType:pt,requirements:"LISTING",attributes}),
  });}catch{return blocked(marketplace,sku,pt,"amazon_preview_transport_failed");}
  if(response.status!==200||!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type")??""))
    return blocked(marketplace,sku,pt,"amazon_preview_response_unverified");
  const contentLength=Number(response.headers.get("content-length")||"0");
  if(!Number.isFinite(contentLength)||contentLength>MAX_BYTES)
    return blocked(marketplace,sku,pt,"amazon_preview_body_too_large");
  if(!response.body)return blocked(marketplace,sku,pt,"amazon_preview_body_unreadable");
  const reader=response.body.getReader();
  const decoder=new TextDecoder("utf-8",{fatal:true});let data="",size=0;
  try{for(;;){
    if(signal.aborted)return blocked(marketplace,sku,pt,"amazon_preview_transport_failed");
    const p=await reader.read();if(p.done)break;
    size+=p.value.byteLength;if(size>MAX_BYTES){void reader.cancel().catch(()=>{});return blocked(marketplace,sku,pt,"amazon_preview_body_too_large");}
    data+=decoder.decode(p.value,{stream:true});
  }data+=decoder.decode();}
  catch{return blocked(marketplace,sku,pt,"amazon_preview_body_unreadable");}
  finally{reader.releaseLock();}
  let body:Row;
  try{body=obj(JSON.parse(data));}
  catch{return blocked(marketplace,sku,pt,"amazon_preview_json_invalid");}
  if(body.sku!==sku||(body.status!=="VALID"&&body.status!=="INVALID")||
     typeof body.submissionId!=="string"||!REF.test(body.submissionId))
    return blocked(marketplace,sku,pt,"amazon_preview_response_identity_invalid");
  if(body.issues!==undefined&&!Array.isArray(body.issues))
    return blocked(marketplace,sku,pt,"amazon_preview_issues_invalid");
  const issues=Array.isArray(body.issues)?body.issues:[];
  if(issues.length>80)return blocked(marketplace,sku,pt,"amazon_preview_issues_invalid");
  const sanitized:Array<{code:string;severity:string;attribute_names:string[]}>=[];
  const headwearDiagnostics:Array<{field:string;rejected_value:string;preconditions:string[]}>=[];
  const sizeIssueHints:string[]=[];
  for(const rawIssue of issues){
    const issue=obj(rawIssue);
    if(typeof issue.code!=="string"||!ISSUE_CODE.test(issue.code)||
       !["ERROR","WARNING","INFO"].includes(String(issue.severity))||
       (issue.attributeNames!==undefined&&
        (!Array.isArray(issue.attributeNames)||issue.attributeNames.length>20||
         issue.attributeNames.some(x=>typeof x!=="string"||!FIELD.test(x)))))
      return blocked(marketplace,sku,pt,"amazon_preview_issues_invalid");
    sanitized.push({code:issue.code,severity:issue.severity as string,
      attribute_names:(issue.attributeNames as string[]|undefined)??[]});
    if(issue.code==="90004205"&&
       (issue.attributeNames as string[]|undefined)?.some(x=>x==="headwear_size"||x==="apparel_size")&&
       typeof issue.message==="string"&&issue.message.length<5000){
      const raw=issue.message as string;
      const normalized=raw.replace(/https?:\/\/[^\s]+/gi,"[url]")
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g,"[email]")
        .replace(/\b\d{7,}\b/g,"[id]")
        .replace(/[^A-Za-z0-9À-ÿ .,;:'"_\-()\[\]]/g," ")
        .replace(/\s+/g," ").trim().slice(0,480);
      if(normalized)sizeIssueHints.push(normalized);
      const valueMatch=/the ['"]([^'"<>]{1,70})['"] on the field/i.exec(raw);
      const fieldMatch=/on the field ['"]([^'"<>]{1,70})['"]/i.exec(raw);
      const preconditions=[...raw.matchAll(/\[([a-z_]{2,40})\.[a-z_]{2,50}\]/g)]
        .map(x=>x[1]).slice(0,8);
      const value=valueMatch?.[1]||"";
      const field=fieldMatch?.[1]||"";
      if(value&&/^[A-Za-z\u00c0-\u00ff0-9 _-]{1,70}$/.test(value)&&
         /^[a-z_\.]{1,70}$/.test(field))
        headwearDiagnostics.push({field,rejected_value:value,preconditions});
    }
  }
  return {ok:true,status:"VALIDATION_ONLY_REVIEW_REQUIRED",marketplace,sku,
    product_type:pt,identifier_type:"EAN",provider_validation_status:body.status,
    preview_submission_reference:body.submissionId,issue_count:sanitized.length,issues:sanitized,
    ...(headwearDiagnostics.length?{headwear_diagnostics:headwearDiagnostics}:{}),
    ...(sizeIssueHints.length?{size_issue_hints:sizeIssueHints}:{}),
    attributes_submitted:Object.keys(attributes),validation_mode:"VALIDATION_PREVIEW",
    preview_only:true,provider_validation_performed:true,
    product_created:false,can_publish:false,listing_write_enabled:false,provider_mutations:0,
    channable_handoff_performed:false,brand_authorization_proven:false,
    gpsr_compliance_proven:false,full_schema_validated:false,
    storefront_unchanged:true,
    next_step:"REVIEW_AMAZON_ISSUES_AND_AUTHORITATIVE_SUPPLIER_EVIDENCE_BEFORE_ANY_LIVE_CREATION"};
}
