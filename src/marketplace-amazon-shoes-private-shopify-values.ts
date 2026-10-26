import { shopifyGraphQL } from "./index.js";
import { resolveAmazonListingBrand } from "./marketplace-amazon-listing-brand.js";
import type { MareBusinessShopifyEnv } from "./mare-business-shopify.js";

/**
 * Reads only merchant-maintained Amazon SHOES metadata from Shopify Admin API.
 * Values are for VALIDATION_PREVIEW ONLY, never product publishing.
 * No GraphQL mutation, public Storefront API request or storefront/theme write.
 */
type Row=Record<string,unknown>;
const GID=/^gid:\/\/shopify\/ProductVariant\/[1-9]\d{0,24}$/;
const SKU=/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/;
const QUERY='query MerchantPrivateShoesValues($variantId:ID!){productVariant(id:$variantId){id sku price compareAtPrice selectedOptions{name value} inventoryItem{countryCodeOfOrigin} googleAgeGroup:metafield(namespace:"mm-google-shopping",key:"age_group"){type value} googleSizeSystem:metafield(namespace:"mm-google-shopping",key:"size_system"){type value} product{id title vendor status productType descriptionHtml metafields(first:20,namespace:"amazon_ptd_shoes"){nodes{key namespace type value} pageInfo{hasNextPage endCursor}} fallbackModel:metafield(namespace:"custom",key:"marketplace_model_name"){type value} fallbackGender:metafield(namespace:"custom",key:"navigation_gender"){type value} fallbackColorText:metafield(namespace:"agentic",key:"color"){type value} fallbackColorRef:metafield(namespace:"features",key:"color"){type value}}}}';
const COLOR_QUERY='query MerchantShoesFeatureColor($colorId:ID!){metaobject(id:$colorId){id type displayName fields{key type value}}}';
const COLOR_GID=/^gid:\/\/shopify\/Metaobject\/[1-9]\d{0,24}$/;
function obj(value:unknown):Row {
  return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Row:{};
}
function safeText(raw:unknown,max=95):raw is string {
  return typeof raw==="string"&&raw.length>0&&raw.length<=max&&
    raw===raw.trim()&&!/[\u0000-\u001f\u007f<>]/.test(raw);
}
/**
 * Optional, merchant-authored Shopify description evidence. This is marketing
 * copy for Amazon VALIDATION_PREVIEW only, NOT a manufacturer technical spec.
 * Never derive GTIN, materials, origin, compliance, or pricing from this text.
 * Unsafe/ambiguous HTML simply omits these optional attributes.
 */
function merchantDescription(raw:unknown,identity?:{sku:string;productTitle:string;shopifyVendor:string}):{product_description?:string;model_number?:string;bullet_point?:string;closure_laces?:true}{
  if(typeof raw!=="string"||raw.length<60||raw.length>8000||
     /<\s*(?:script|style|iframe|object|embed|svg|form|input|textarea)\b/i.test(raw)||
     /<[^>]*$/.test(raw))return {};
  // Shopify's rich text editor stores otherwise identical labelled <li>
  // entries as either <li>Label: value</li> or <li><p>Label: value</p></li>.
  // Only these two exact structures are accepted, and any unmatched/duplicate
  // label makes its field fail closed (no guesswork from surrounding prose).
  const listLines=[...raw.matchAll(/<li>\s*([\s\S]*?)\s*<\/li>/gi)].map(match=>{
    const inner=match[1].trim();
    const paragraph=/^<p>\s*([^<>]*)\s*<\/p>$/i.exec(inner);
    return paragraph?paragraph[1].trim():/^[^<>]+$/.test(inner)?inner:null;
  });
  const countLabel=(label:string):number=>
    [...raw.matchAll(new RegExp("(?:^|>)\\s*"+label+"\\s*:","gi"))].length;
  const codes=listLines.filter((line):line is string=>
    typeof line==="string"&&/^Codice modello\s*:/i.test(line))
    .map(line=>/^Codice modello:\s*([A-Za-z0-9][A-Za-z0-9._/-]{0,59})$/i.exec(line))
    .filter((m):m is RegExpExecArray=>m!==null);
  const modelNames=listLines.filter((line):line is string=>
    typeof line==="string"&&/^Modello\s*:/i.test(line))
    .map(line=>/^Modello:\s*([^<>]{4,100})$/i.exec(line))
    .filter((m):m is RegExpExecArray=>m!==null);
  const codeNumber=countLabel("Codice modello")===1&&codes.length===1?
    codes[0][1]:undefined;
  const modelBullet=countLabel("Modello")===1&&modelNames.length===1?
    modelNames[0][1].trim():undefined;
  const bulletPoint=safeText(modelBullet,100)&&
    !/&(?:#\w+|\w+);/.test(modelBullet)?modelBullet:undefined;
  const closureLines=listLines.filter((line):line is string=>
    typeof line==="string"&&/^Chiusura\b/i.test(line));
  const closureLaces=closureLines.length===1&&
    [...raw.matchAll(/(?:^|>)\s*Chiusura\b/gi)].length===1&&
    /^Chiusura con lacci$/i.test(closureLines[0]);
  const description=raw.replace(/<br\s*\/?>/gi,". ")
    .replace(/<\/(?:p|li|h[1-6]|div)>/gi,". ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"').replace(/&#39;/gi,"'")
    .replace(/\s+/g," ").trim();
  if(description.length<60||description.length>2000||
     /[\u0000-\u001f\u007f<>]/.test(description)||
     /&(?:#\w+|\w+);/.test(description))return {};
  // A narrowly scoped merchant-copy fallback for the Shopify Hyper D-4006
  // style: model appears in BOTH an exact title/SKU and free-text body, while
  // technical bullet and laces appear as explicit, unambiguous HTML list lines.
  // Marketing evidence for Amazon VALIDATION_PREVIEW only; NEVER manufacturer,
  // material composition, origin, GPSR, retail price or live publication proof.
  const dSeries=identity?.shopifyVendor==="4B12"?
    /^4B12_HYPER_(D[0-9]{4})_(?:3[4-9]|4[0-9]|50)_EU$/.exec(identity.sku):null;
  const dCode=dSeries?.[1]??"";
  const dDisplay=dCode?dCode[0]+"-"+dCode.slice(1):"";
  const names=[...description.matchAll(/\b[DU]-?[0-9]{4}\b/gi)]
    .map(m=>m[0].toUpperCase().replace("-",""));
  const modelConsistent=dCode.length>0&&
    identity?.productTitle.toLowerCase()==="sneaker hyper-"+dCode.toLowerCase()&&
    new RegExp("\\bSneaker\\s+4B12\\s+Hyper\\s+"+dDisplay+"\\b","i").test(description)&&
    new RegExp("\\bmodello\\s+"+dDisplay+"\\b","i").test(description)&&
    names.length>=2&&names.every(m=>m===dCode);
  const technicalHeader=/<h3>\s*Caratteristiche tecniche\s*<\/h3>/i.test(raw);
  const technicalBullet=listLines.filter(line=>line==="Suola platform effetto vintage");
  const technicalLaces=listLines.filter(line=>line==="Lacci brillanti");
  const supportingLaces=listLines.filter(line=>line==="Lacci con finitura brillante");
  const dSource=modelConsistent&&technicalHeader&&
    technicalBullet.length===1&&technicalLaces.length===1&&
    supportingLaces.length===1&&
    closureLines.length===0&&!/\b(?:velcro|zip|cerniera|fibbia)\b/i.test(description);
  return {product_description:description,
    ...(codeNumber?{model_number:codeNumber}:dSource?{model_number:dDisplay}:{}),
    ...(bulletPoint?{bullet_point:bulletPoint}:dSource?{bullet_point:technicalBullet[0]}:{}),
    ...(closureLaces?{closure_laces:true as const}:dSource?{closure_laces:true as const}:{})};
}
/**
 * Merchant-authored model-specific composition for Royal Classic Pro-Keds.
 * This is strict exact-product HTML extraction for Amazon validation previews.
 * It is NOT a supplier certificate, GPSR attestation or live-write permission.
 */
function proKedsComposition(raw:unknown,identity:{sku:string;productTitle:string;shopifyVendor:string}):Row {
  if(identity.shopifyVendor!=="Pro-Keds"||typeof raw!=="string"||
     raw.length<500||raw.length>8000||!/^Royal Classic [A-Za-z/ ]{3,65}$/.test(identity.productTitle))
    return {};
  const codes=/^PROKEDS_(RC426SL[MW])_(SL|LL|LG|SG)_([A-Z]{2}[0-9]{5})_(?:3[5-9]|4[0-9]|50)$/.exec(identity.sku);
  if(!codes)return {};
  const labels=new Map<string,string>();
  for(const m of raw.matchAll(/<li>\s*<strong>([A-Za-zÀ-ÿ ]{3,35}):<\/strong>\s*([^<>]{1,120})<\/li>/gi)){
    const key=m[1].trim().toLowerCase(),val=m[2].trim();
    if(labels.has(key))return {};
    labels.set(key,val);
  }
  const code=codes[1],materialCode=codes[2],colorCode=codes[3];
  const male=code.endsWith("M");
  const gender=male?"Uomo":"Donna";
  const color=identity.productTitle.slice("Royal Classic ".length);
  const outer=labels.get("tomaia"),sole=labels.get("suola");
  const availableOuters=new Map<string,string>([
    ["SL","83% suede, 17% pelle"],
    ["LL","100% pelle"],
    ["LG","73% pelle, 22% suede, 5% tessuto glitter"],
    ["SG","83% suede, 12% pelle, 5% tessuto glitter"]
  ]);
  if(labels.get("modello")!=="Royal Classic"||
     labels.get("genere")!==gender||labels.get("colore")!==color||
     labels.get("codice modello")!==code||labels.get("codice materiale")!==materialCode||
     labels.get("codice colore")!==colorCode||outer!==availableOuters.get(materialCode)||
     sole!=="100% gomma")return {};
  const composition=/<p><strong>Composizione:<\/strong>\s*([^<>]{70,380})<\/p>/i.exec(raw)?.[1];
  const normalize=(x:string)=>x.toLowerCase().replace(/,\s*|\s+e\s+/g," ").replace(/\s+/g," ").trim();
  const outerFromComposition=composition?.match(/^Tomaia\s+([^;]+);\s*fodera\s+/i)?.[1];
  if(!outer||!composition||!outerFromComposition||
     normalize(outerFromComposition)!==normalize(outer)||
     !/;\s*fodera 50% pelle, 15% microfibra, 35% materiale tessile;\s*soletta interna 100% tessuto;\s*suola esterna 100% gomma\./i.test(composition))
    return {};
  return {source:"SHOPIFY_PROKEDS_ROYAL_CLASSIC_EXACT_HTML",
    model_number:code,model_bullet:"Royal Classic",outer,
    inner:"50% pelle, 15% microfibra, 35% materiale tessile",
    sole:"Gomma",merchant_gender:gender};
}
/**
 * Sourced outsole material for SHOES VALIDATION_PREVIEW only.
 * A retailer's explicit description is not a supplier laboratory report.
 * Do not extrapolate other materials, water resistance, shaft or GPSR.
 */
function merchantExplicitSole(raw:unknown):Row{
  if(typeof raw!=="string"||raw.length<60||raw.length>14000||
     /<\s*(?:script|style|iframe|object|embed|svg|form)\b/i.test(raw))
    return {};
  const text=raw.replace(/<[^>]*>/g," ").replace(/&amp;/gi,"&")
    .replace(/&nbsp;/gi," ").replace(/\s+/g," ").trim();
  if(text.length<60||/\b(?:suola (?:in|di) (?:pelle|cuoio)|suola esterna in cuoio)\b/i.test(text))
    return {};
  const mixed=/\bsuola\s+(?:esterna\s+)?(?:in\s+)?EVA\s*(?:&|e)\s*gomma\b/i.test(text);
  const rubber=/\b(?:suola\s+(?:esterna\s+)?(?:in|di)\s+gomma|fondo\s+in\s+gomma|battistrada\s+in\s+gomma)\b/i.test(text);
  if(mixed===rubber)return {};
  return {source:"MERCHANT_EXPLICIT_SHOPIFY_SOLE_TEXT",
    value:mixed?"EVA e gomma":"Gomma"};
}
/** Marketing category hints explicitly visible in Shopify description.
 * They are optional preview-only labels, NOT factory or GPSR attestations.
 */
function merchantExplicitShoeStyle(raw:unknown):Row{
  if(typeof raw!=="string"||raw.length<60||raw.length>14000||
     /<\s*(?:script|style|iframe|object|embed|svg|form)\b/i.test(raw))
    return {};
  const text=raw.replace(/<[^>]*>/g," ").replace(/&amp;/gi,"&")
    .replace(/&nbsp;/gi," ").replace(/\s+/g," ").trim();
  if(text.length<60)return {};
  const casual=/\b(?:stile|look|outfit|abbigliamento)\s+(?:\w+\s+){0,2}casual\b|\bcasual\s+(?:urbano|premium|lifestyle)\b/i.test(text);
  const laces=!/\b(?:velcro|zip|cerniera|fibbia)\b/i.test(text)&&
    /\b(?:chiusura con lacci|lacci\s+(?:trek|in cotone|a contrasto|assicurano))\b/i.test(text);
  const low=/\b(?:sneakers? basse|sneaker low-top|profilo basso)\b/i.test(text)&&
    !/\b(?:high-top|alta alla caviglia|stivaletto)\b/i.test(text);
  if(!casual&&!laces&&!low)return {};
  return {source:"SHOPIFY_EXPLICIT_SHOE_STYLE_DESCRIPTION",
    ...(casual?{casual:true}:{}),...(laces?{closure_laces:true}:{}),
    ...(low?{low_top:true}:{})};
}
function fail(reason:string):{ok:false;reason:string}{
  return {ok:false,reason};
}
type Expected=Readonly<{
  sku:string;variantId:string;productTitle:string;shopifyVendor:string;amazonBrand:string;
}>;
export async function readAmazonShoesPrivateShopifyValues(
  expected:Expected,env:MareBusinessShopifyEnv,
  deps:{queryShopify?:typeof shopifyGraphQL}={},
):Promise<Row>{
  if(!expected||!safeText(expected.sku,120)||!SKU.test(expected.sku)||
     !GID.test(expected.variantId)||!safeText(expected.productTitle,200)||
     !safeText(expected.shopifyVendor,100)||!safeText(expected.amazonBrand,100))
    return fail("source_identity_invalid");
  const identity=resolveAmazonListingBrand(expected.shopifyVendor);
  if(!identity||identity.amazon_brand!==expected.amazonBrand)
    return fail("amazon_brand_mapping_unverified");
  let result:Row;
  try {
    result=obj(await(deps.queryShopify??shopifyGraphQL)(
      env,QUERY,{variantId:expected.variantId}));
  } catch {return fail("shopify_private_fields_unavailable");}
  const variant=obj(result.productVariant),product=obj(variant.product);
  if(variant.id!==expected.variantId||variant.sku!==expected.sku||
     product.status!=="ACTIVE"||product.productType!=="Sneakers"||
     product.title!==expected.productTitle||product.vendor!==expected.shopifyVendor)
    return fail("shopify_identity_changed");
  const connection=obj(product.metafields),page=obj(connection.pageInfo);
  if(page.hasNextPage!==false||!Array.isArray(connection.nodes)||connection.nodes.length>20)
    return fail("shopify_metafields_incomplete");
  const fields=new Map<string,string>();
  for(const item of connection.nodes){
    const field=obj(item),key=field.key;
    if(field.namespace!=="amazon_ptd_shoes"||
       typeof key!=="string"||
       !["amazon_brand","model_name","color","target_gender","model_number",
         "age_range_description","country_of_origin","manufacturer"].includes(key)||
       field.type!=="single_line_text_field"||fields.has(key))
      return fail("shopify_metafields_unverified");
    if(typeof field.value!=="string")return fail("shopify_metafields_unverified");
    fields.set(key,field.value);
  }
  // An explicit Shopify Amazon metafield has priority. Without one, permit
  // ONLY the exact merchant-confirmed listing-brand mapping resolved above.
  // This is label evidence, not Amazon seller-brand authorization.
  if(fields.has("amazon_brand")?
     fields.get("amazon_brand")!==expected.amazonBrand:
     identity.source==="MERCHANT_CONFIRMED_MAPPING"?
       identity.amazon_brand!==expected.amazonBrand:
       expected.shopifyVendor!==expected.amazonBrand)
    return fail("shopify_brand_field_mismatch");
  const modelSource=obj(product.fallbackModel);
  const model=fields.has("model_name")?fields.get("model_name"):
    modelSource.type==="single_line_text_field"?modelSource.value:undefined;
  if(!safeText(model,80))return fail("shopify_pilot_model_or_color_missing");
  let color:unknown=fields.get("color");
  let sourceColor="product.amazon_ptd_shoes.color";
  if(!fields.has("color")){
    const direct=obj(product.fallbackColorText),ref=obj(product.fallbackColorRef);
    const directValue=direct.type==="single_line_text_field"&&
      safeText(direct.value,80)?direct.value:undefined;
    const colorGid=ref.type==="metaobject_reference"&&
      typeof ref.value==="string"&&COLOR_GID.test(ref.value)?ref.value:undefined;
    let referencedValue:string|undefined;
    if(colorGid){
      let colorResult:Row;
      try{colorResult=obj(await(deps.queryShopify??shopifyGraphQL)(
        env,COLOR_QUERY,{colorId:colorGid}));
      }catch{return fail("shopify_color_source_unavailable");}
      const meta=obj(colorResult.metaobject);
      const names=Array.isArray(meta.fields)?meta.fields.filter(f=>obj(f).key==="name"):[];
      const name=obj(names[0]);
      if(meta.id!==colorGid||meta.type!=="product_feature_color"||
         names.length!==1||name.type!=="single_line_text_field"||
         !safeText(name.value,80)||meta.displayName!==name.value)
        return fail("shopify_color_reference_unverified");
      referencedValue=name.value;
    }
    if(directValue&&referencedValue&&directValue!==referencedValue)
      return fail("shopify_color_sources_conflict");
    color=directValue??referencedValue;
    sourceColor=directValue?"product.agentic.color":"product.features.color.metaobject.name";
  }
  if(!safeText(color,80))return fail("shopify_pilot_model_or_color_missing");
  // Gender must be explicit merchant-maintained metadata, never inferred from
  // marketing copy, navigation tags, imagery or shoe size.
  let rawGender:unknown=fields.get("target_gender");
  if(!fields.has("target_gender")){
    const structured=obj(product.fallbackGender);
    if(structured.type==="list.single_line_text_field"&&typeof structured.value==="string"){
      try{
        const values=JSON.parse(structured.value);
        if(Array.isArray(values)&&values.length===1&&typeof values[0]==="string")
          rawGender=values[0];
      }catch{ /* no inference */ }
    }
  }
  const targetGender=rawGender==="Donna"?"female":
    rawGender==="Uomo"?"male":rawGender==="Unisex"?"unisex":undefined;
  // InventoryItem countryCodeOfOrigin is a merchant-maintained inventory value.
  // It is never inferred from brand, EAN, HS code, photos or description and
  // is ONLY used for Amazon VALIDATION_PREVIEW, not GPSR/manufacturer attestation.
  const shopifyOrigin=obj(variant.inventoryItem).countryCodeOfOrigin;
  const amazonOrigin=fields.get("country_of_origin");
  const validOrigin=(v:unknown):v is string=>
    typeof v==="string"&&/^[A-Z]{2}$/.test(v);
  if(fields.has("country_of_origin")&&!validOrigin(amazonOrigin))
    return fail("shopify_amazon_origin_invalid");
  if(shopifyOrigin!==null&&shopifyOrigin!==undefined&&!validOrigin(shopifyOrigin))
    return fail("shopify_inventory_origin_invalid");
  if(validOrigin(amazonOrigin)&&validOrigin(shopifyOrigin)&&amazonOrigin!==shopifyOrigin)
    return fail("shopify_origin_sources_conflict");
  const countryOfOrigin=validOrigin(amazonOrigin)?amazonOrigin:
    validOrigin(shopifyOrigin)?shopifyOrigin:undefined;
  // Google Shopping age is a merchant-declared catalog hint, never a medical,
  // manufacturer or GPSR claim. Only an exact adult value is supported in
  // non-publishing VALIDATION_PREVIEW; unknown/child values are not inferred.
  const ageSource=obj(variant.googleAgeGroup);
  const explicitAdultAge=fields.has("age_range_description")?
    fields.get("age_range_description")==="adult":
    ageSource.type==="single_line_text_field"&&ageSource.value==="adult";
  // EU shoe size must come from the actual variant option, never from SKU text.
  // For a unitless "Taglia: 41", require a separately declared Shopify EU
  // sizing-system metafield; no assumptions about US/UK sizes.
  const selections=variant.selectedOptions;
  const declaredSystem=obj(variant.googleSizeSystem);
  const euDeclared=declaredSystem.type==="single_line_text_field"&&
    declaredSystem.value==="EU";
  let selectedSize:string|undefined;
  let sizeNeedsSystemEvidence=false;
  if(Array.isArray(selections)&&selections.length===1){
    const option=obj(selections[0]);
    if(option.name==="Numero"&&typeof option.value==="string"){
      const match=/^([34][0-9]|50) EU$/.exec(option.value);
      if(match)selectedSize=match[1];
    }else if(option.name==="Taglia"&&typeof option.value==="string"&&euDeclared){
      const match=/^([34][0-9]|50)$/.exec(option.value);
      if(match){selectedSize=match[1];sizeNeedsSystemEvidence=true;}
    }
  }
  // Pilot-specific sizing bridge for the 4B12 PlayNew D2045 women's range.
  // The brand's PlayNew family is sold in regular width; "medium" is a
  // merchant review assumption, NOT a manufacturer-certified shoe width.
  // Do not propagate this guess to other models/brands.
  const playNewPilot=expected.shopifyVendor==="4B12"&&
    expected.productTitle==="PlayNew D-2045 White/Bronze"&&
    /^4B12_PLAYNEW_D2045_(?:37|38|39|40)_EU$/.test(expected.sku)&&
    targetGender==="female"&&typeof selectedSize==="string";
  const descriptionEvidence=merchantDescription(product.descriptionHtml,expected);
  const proKeds=proKedsComposition(product.descriptionHtml,expected);
  const merchantSole=merchantExplicitSole(product.descriptionHtml);
  const styleEvidence=merchantExplicitShoeStyle(product.descriptionHtml);
  // Catalog compare-at is list-price evidence, not an Amazon sell price.
  const comparison=variant.compareAtPrice,now=variant.price;
  const priceFormat=/^[0-9]{1,5}\.[0-9]{2}$/;
  const listPrice=(typeof comparison==="string"&&priceFormat.test(comparison)&&
    typeof now==="string"&&priceFormat.test(now)&&
    Number(comparison)>=Number(now)&&Number(comparison)>0)?
    Number(comparison):undefined;
  return {ok:true,model_name:model,color,...descriptionEvidence,
    ...(styleEvidence.source?{merchant_shoes_style:styleEvidence}:{}),
    ...(merchantSole.source?{merchant_shoes_sole:merchantSole}:{}),
    ...(proKeds.source?{merchant_shoes_composition:proKeds,
      model_number:descriptionEvidence.model_number??proKeds.model_number,
      bullet_point:descriptionEvidence.bullet_point??proKeds.model_bullet}:{}),
    ...(listPrice!==undefined?{shopify_list_price_eur:listPrice}:{}),
    catalog_style:"Sneaker",
    ...(typeof variant.price==="string"?{shopify_snapshot_price:variant.price}:{}),
    // Only explicitly entered merchant manufacturer; NOT a GPSR claim.
    ...(safeText(fields.get("manufacturer"),100)?{
      merchant_manufacturer_name:fields.get("manufacturer")
    }:{}),
    ...(playNewPilot?{pilot_assumptions:["EU_REGULAR_WIDTH_MEDIUM","ADULT_FROM_WOMENS_DEPARTMENT","AMAZON_NUMERIC_SIZE_LABEL_REVIEW"]}:{}),
    // PlayNew D2045 style evidence for the four exact Shopify variants (37-40): retail size-independent materials cross-checked with
    // https://www.loggishop.com/products/4b12-playnew-d2045-white-bronze
    // and https://stimm.com/collections/scarpe-da-donna/products/4b12sneakers-in-pelle-playnew-white-bronze
    // RETAILER descriptions, NOT manufacturer-certified materials/GPSR.
    ...(playNewPilot?{
      pilot_brand_operator:{name:"Medusa s.r.l.",source:"OFFICIAL_4B12_CONTACTS_NOT_GPSR"},
      // Dry-run SKU37-40 pilot ONLY. Package data are
      // provisional shoe-box estimates, NOT measured or manufacturer values.
      // Do not propagate to other styles or claim GPSR compliance.
      pilot_commercial_assumptions:{
        source:"MERCHANT_REVIEW_PROVISIONAL_PLAYNEW_D2045",
        lifestyle:"Casual",style:"Sneaker",leather_type:"Pelle scamosciata",
        shaft_height_cm:6,height_map:"low-top",strap_type:"no-strap",
        water_resistance_level:"not_water_resistant",batteries_required:false,
        package_weight_kg:1.2,package_length_cm:34,package_width_cm:23,package_height_cm:13
      },

      ...(variant.price==="179.10"&&variant.compareAtPrice==="199.00"?{pilot_list_price_eur:199}:{}),
      pilot_materials:{
        outer:"Pelle e suede", inner:"Pelle e spugna", sole:"Gomma",
        source:"RETAILER_EXACT_MODEL_AND_GTIN_REVIEW"
      }
    }:{}),
    ...(explicitAdultAge||playNewPilot?{age_range_description:"adult"}:{}),
    ...(countryOfOrigin?{country_of_origin:countryOfOrigin}:{}),
    ...(targetGender?{target_gender:targetGender}:{}),
    ...(selectedSize?{footwear_size:{
      size:playNewPilot?"numeric_"+selectedSize:selectedSize,size_class:"numeric",size_system:"eu_footwear_size_system",
      ...(playNewPilot?{age_group:"adult",gender:"women",width:"medium"}:{}),
    }}:{}),
    verified_paths:[fields.has("amazon_brand")?"product.amazon_ptd_shoes.amazon_brand":identity.source==="MERCHANT_CONFIRMED_MAPPING"?"merchant_confirmed_vendor_brand_mapping":"product.vendor",
      fields.has("model_name")?"product.amazon_ptd_shoes.model_name":"product.custom.marketplace_model_name",
      sourceColor,
      ...(targetGender?[fields.has("target_gender")?"product.amazon_ptd_shoes.target_gender":"product.custom.navigation_gender"]:[]),
      ...(countryOfOrigin?[fields.has("country_of_origin")?
        "product.amazon_ptd_shoes.country_of_origin":"variant.inventoryItem.countryCodeOfOrigin"]:[]),
      ...(explicitAdultAge?[fields.has("age_range_description")?
        "product.amazon_ptd_shoes.age_range_description":"variant.mm-google-shopping.age_group"]:[]),
      ...(selectedSize?["variant.selectedOptions",...(sizeNeedsSystemEvidence?["variant.mm-google-shopping.size_system"]:[])]:[]),
      ...(descriptionEvidence.product_description?["product.descriptionHtml"]:[]),
      ...(proKeds.source?["product.descriptionHtml.ProKedsStructuredComposition"]:[]),
      ...(merchantSole.source?["product.descriptionHtml.ExplicitSoleMaterial"]:[]),
      ...(styleEvidence.source?["product.descriptionHtml.ExplicitShoeStyle"]:[])],
    draft_values_review_only:true,public_storefront_access_used:false,
    product_created:false,ready_for_publication:false};
}
