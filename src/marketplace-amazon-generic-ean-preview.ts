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
const PRODUCT_TYPES=new Set(["SOCKS","HANDBAG","SHIRT","COAT","HAT","BOOT","BACKPACK","COSMETIC_CASE","STORAGE_BAG","SWEATER","SWEATSHIRT","SCARF","TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"]);
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
const PRIVATE_QUERY='query GenericEanValidationEvidence($variantId:ID!){productVariant(id:$variantId){id sku barcode price compareAtPrice selectedOptions{name value} inventoryItem{countryCodeOfOrigin} product{id title description productType vendor status amazonPtd:metafield(namespace:"custom",key:"amazon_product_attributes"){type value} fabric:metafield(namespace:"marketplace",key:"fabric_composition"){type value} bullets:metafield(namespace:"marketplace",key:"bullet_points"){type value} colorRef:metafield(namespace:"features",key:"color"){type value} model:metafield(namespace:"custom",key:"marketplace_model_name"){type value} gender:metafield(namespace:"custom",key:"navigation_gender"){type value}}}}';

/** Source-scoped product evidence for Refrigiwear and K-Way.
 * Brand, SKU and source Product GID must match. Explicit commercial/category
 * inferences are not product-label, supplier, factory or GPSR attestations.
 * Origin remains a separate InventoryItem declaration; parcels are not items.
 */
export function refrigiwearEvidenceAttrs(product:Row,variant:Row,sku:string,pt:string,
  marketplace:string,marketId:string,available:string[],ptdAlphaTokens:Row={},
  ptdTechnicalShapes:Row={}):Row{
  const isRefrigiwear=sku.startsWith("RFR_")&&product.vendor==="Refrigiwear";
  const isKway=sku.startsWith("KWAY_")&&product.vendor==="K-Way";
  if(!isRefrigiwear&&!isKway)return {};
  // Only a product-ID-bound merchant dossier may enrich K-Way accessories.
  // The generic EAN pilot remains preview-only; the source is NOT a GPSR approval.
  const commonTypes=["COAT","HAT","SHIRT","BACKPACK","SCARF","SWEATER","SWEATSHIRT",
    "HANDBAG","COSMETIC_CASE","STORAGE_BAG"];
  const accessoryTypes=["TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"];
  if(!(commonTypes.includes(pt)||(isKway&&accessoryTypes.includes(pt))))return {};
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
  const safeText=(s:unknown):string|undefined=>
    typeof s==="string"&&s.length>1&&s.length<250&&
      !/[\u0000-\u001f<>]/.test(s)?s:undefined;
  const val=(name:string)=>safeText(fields[name]);
  const attrs:Row={};
  const set=(name:string,value:unknown)=>{
    if(available.includes(name))attrs[name]=value;
  };
  if(!Object.hasOwn(MARKET_LOCALE,marketplace))return {};
  const locale=MARKET_LOCALE[marketplace as Market];
  const text=(value:string)=>[{value,language_tag:locale,marketplace_id:marketId}];
  // Model-group K-Way bullets: the exact ACTIVE Shopify product description
  // must contain every emitted sentence, and the original custom dossier
  // must explicitly bind it to this Product GID and manufacturer model.
  // Reuses one verified source across all size variants, not arbitrary copy.
  if(isKway&&marketplace==="IT"&&
     ["COAT","SWEATER","SWEATSHIRT","SHIRT","HAT","SCARF"].includes(pt)){
    const bulletRaw=fields.bullet_point;
    const proof=obj(obj(fields.field_provenance).bullet_point);
    const model=val("model_number");
    if(Array.isArray(bulletRaw)&&bulletRaw.length>=1&&bulletRaw.length<=5&&
       proof.status==="DOCUMENTED_EXACT_LIVE_SHOPIFY_DESCRIPTION_SUBSTRINGS"&&
       proof.source_product_id===product.id&&
       proof.source_model===model&&
       proof.source_field==="product.description"&&
       proof.source_quoted_substrings===true&&
       typeof model==="string"&&/^K[0-9]{4}[A-Z0-9]{2}$/.test(model)&&
       sku.startsWith("KWAY_"+model)&&
       /^[_ .-]/.test(sku.slice(5+model.length))&&
       typeof product.description==="string"&&
       bulletRaw.every(x=>typeof x==="string"&&
          x.length>=12&&x.length<=220&&safeText(x)===x&&
          (product.description as string).includes(x))&&
       new Set(bulletRaw).size===bulletRaw.length){
      set("bullet_point",bulletRaw.map(value=>({
        value,language_tag:locale,marketplace_id:marketId
      })));
    }
  }

  // Navigation may intentionally contain several storefront audiences. Use
  // the independently recorded product department without changing that facet
  // or overriding an existing single-value merchant gender.
  const navigationGender=genderFromMerchant(product.gender);
  const departmentSource=obj(obj(fields.field_provenance).department);
  const departmentGender:Record<string,string>={Uomo:"male",Donna:"female",Unisex:"unisex"};
  const department=val("department");
  const documentedGender=department&&Object.hasOwn(departmentGender,department)?
    departmentGender[department]:undefined;
  if(isKway&&navigationGender.ok&&!navigationGender.value&&documentedGender&&
     departmentSource.status==="DOCUMENTED_LIVE_SHOPIFY_METAOBJECT"&&
     departmentSource.source_product_id===product.id)
    set("target_gender",[{value:documentedGender,marketplace_id:marketId}]);
  const operator=val("manufacturer_brand_operator");
  const commercialSource=obj(fields.manufacturer_commercial_source);
  // The official seller/brand owner supports this explicitly recorded
  // commercial inference. It does not verify a factory, label or GPSR role.
  const commercialManufacturer=isKway&&operator==="K-Way S.p.A."&&
    fields.manufacturer_status===
      "COMMERCIAL_BRAND_MANUFACTURER_INFERRED_FROM_OFFICIAL_BRAND_SOURCE"&&
    commercialSource.source_type==="OFFICIAL_BRAND_OWNER_SELLER"&&
    commercialSource.brand==="K-Way"&&
    typeof commercialSource.source_url==="string"&&
    /^https:\/\/www\.k-way\.com\/(?:(?:it|en)\/)?pages\/(?:general-terms-and-conditions-of-sale|faq)\/?$/.test(commercialSource.source_url);
  if(commercialManufacturer)set("manufacturer",text(operator));
  // Standard is an explicit, source-traced catalog inference, never derived
  // from fit_type. A per-market value overrides it; an exposed PTD enum wins
  // on spelling/case, and a conflicting enum leaves the attribute absent.
  const special=val("special_size_type");
  const inferredStandard=isKway&&special==="Standard"&&
    fields.special_size_type_status==="INFERRED_STANDARD_ADULT_CATALOG_SIZING";
  if((marketplace==="IT"&&pt!=="HAT")||inferredStandard){
    const marketSizes=obj(fields.special_size_type_by_market);
    let selected=Object.hasOwn(marketSizes,marketplace)?safeText(marketSizes[marketplace]):special;
    const valueShape=obj(obj(obj(ptdTechnicalShapes.special_size_type).items).properties).value;
    const tokens=obj(valueShape).enum;
    if(selected&&Array.isArray(tokens)){
      const wanted=selected;
      selected=tokens.find(x=>x===wanted)??tokens.find(x=>
        typeof x==="string"&&x.toLowerCase()===wanted.toLowerCase());
    }
    if(selected)set("special_size_type",pt==="HAT"?
      [{value:selected,marketplace_id:marketId}]:text(selected));
  }
  // Values must exist in the product dossier. No inference is made here from
  // a title, category name or a missing battery/hazard field.
  if(fields.batteries_required===false)
    set("batteries_required",[{value:false,marketplace_id:marketId}]);
  // Keep batteries_included in the source dossier: the deployed publisher
  // does not accept that output attribute. If Amazon
  // requires it, the unchanged VALID/zero-ERROR gate still blocks live writes.
  const dg=val("supplier_declared_dg_hz_regulation");
  if(dg&&(marketplace==="IT"||(isKway&&dg==="not_applicable")))
    set("supplier_declared_dg_hz_regulation",[{value:dg,marketplace_id:marketId}]);
  const descriptiveFabric=isKway?kwayDescriptiveFabric(fields,product.id):undefined;
  // Exact merchant-linked official product page proof: a URL alone cannot
  // certify manufacturer/GPSR/origin. It only authorizes descriptive color
  // and official list price when product style, SKU and title agree.
  const officialUrl=val("official_product_source_url");
  const officialStyle=val("official_product_style_code");
  const officialMatch=isKway&&!!officialUrl&&!!officialStyle&&
    /^https:\/\/www\.k-way\.com\/it\/products\/[a-z0-9-]{12,180}$/.test(officialUrl)&&
    /^K[0-9]{4}[A-Z]{2}$/.test(officialStyle)&&
    sku.slice(5).startsWith(officialStyle)&&
    officialUrl.includes(officialStyle.toLowerCase());
  // Only manufacturer-stated official MSRP, not Shopify seller price or
  // stock. A product-bound official proof can fill an absent compare-at,
  // but must never override a legitimate existing Shopify list price.
  const list=typeof variant.compareAtPrice==="string"?
    Number(variant.compareAtPrice):NaN;
  const officialMsrp=fields.official_msrp_eur;
  const attestedMsrp=officialMatch&&typeof officialMsrp==="number"&&
    Number.isFinite(officialMsrp)&&officialMsrp>=5&&officialMsrp<=5000?
    officialMsrp:NaN;
  const effectiveList=Number.isFinite(list)&&list>0&&list<10000?
    list:attestedMsrp;
  if((marketplace==="IT"||isKway)&&Number.isFinite(effectiveList))
    set("list_price",[{currency:"EUR",value_with_tax:effectiveList,
      marketplace_id:marketId}]);
  // Cross-market preview: emit only market-neutral values backed by the exact
  // dossier. Italian descriptive text is NOT translated into DE/FR/ES.
  // Commercial brand names and explicit standard-size tokens are handled above.
  if(marketplace!=="IT"){
    const water=val("water_resistance_level");
    const levels:Record<string,string>={
      "Idrorepellente":"water_repellent",
      "Resistente all'acqua":"water_resistant",
      "Impermeabile":"waterproof",
      "Non idrorepellente":"not_water_resistant"
    };
    if(water&&levels[water])set("water_resistance_level",[
      {value:levels[water],marketplace_id:marketId}]);
    // Merchant-declared generic parcel defaults, not dimensions of the item.
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
    // Optional product-source translations are taken only from this market's
    // dictionary. Missing translations never fall back to Italian fields.
    if(isKway&&fields.localized_marketplace_fields_status===
       "MODEL_GROUP_TRANSLATION_FROM_PRODUCT_SOURCE"){
      const localized=obj(obj(fields.localized_marketplace_fields)[marketplace]);
      const localVal=(name:string)=>safeText(localized[name]);
      if(pt==="WAIST_PACK"&&officialMatch&&sku.split("_")[1]===officialStyle){
        for(const key of ["model_number","part_number"]){
          const code=val(key);
          if(code&&code===officialStyle)set(key,text(code));
        }
        const translatedMaterial=localVal("material");
        if(val("material")&&translatedMaterial)set("material",text(translatedMaterial));
      }
      // K-Way EU DUFFEL_BAG: exact Shopify-model evidence, translated factual
      // compartment label, merchant model code, and documented item dimensions.
      // Do not substitute package measurements or derive nominal capacity.
      if(pt==="DUFFEL_BAG"){
        const model=val("model_number"), part=val("part_number");
        const original=val("compartment_description");
        const evidence=obj(obj(fields.field_provenance).compartment_description);
        const translation=obj(fields.localized_compartment_description_provenance);
        const translated=localVal("compartment_description");
        const sameModel=!!model&&/^K[0-9]{4}[A-Z0-9]{2}$/.test(model)&&
          sku.startsWith("KWAY_"+model)&&
          /^[_ .-]/.test(sku.slice(5+model.length));
        const exactProduct=sameModel&&
          evidence.status==="DOCUMENTED_EXACT_SHOPIFY_PRODUCT_DESCRIPTION"&&
          evidence.source_product_id===product.id&&
          evidence.source_model===model&&evidence.source_field==="product.description";
        if(exactProduct){
          if(part===model){
            set("model_number",text(model!));
            set("part_number",text(part!));
          }
          const localMaterial=localVal("material");
          if(val("material")&&localMaterial)set("material",text(localMaterial));
          const dimensions=obj(fields.item_dimensions_cm);
          const dimensionSchema=obj(ptdTechnicalShapes.item_length_width_height);
          if(dimensionSchema.type==="array"&&
             ["height","width","depth"].every(key=>
               typeof dimensions[key]==="number"&&
               Number.isFinite(dimensions[key])&&
               (dimensions[key] as number)>0&&(dimensions[key] as number)<500)){
            set("item_length_width_height",[{
              length:{value:dimensions.width,unit:"centimeters"},
              width:{value:dimensions.depth,unit:"centimeters"},
              height:{value:dimensions.height,unit:"centimeters"},
              marketplace_id:marketId
            }]);
          }
          const schema=obj(ptdTechnicalShapes.compartment);
          const item=obj(schema.items),parts=obj(item.properties);
          const description=obj(parts.description),descItem=obj(description.items);
          const descFields=obj(descItem.properties);
          if(original&&translated&&
             translation.status==="TRANSLATED_FROM_EXACT_SHOPIFY_PRODUCT_DESCRIPTION"&&
             translation.source_product_id===product.id&&
             translation.source_model===model&&
             translation.source_sku===sku&&
             Array.isArray(translation.translations)&&
             translation.translations.includes(marketplace)&&
             schema.type==="array"&&item.type==="object"&&
             description.type==="array"&&descItem.type==="object"&&
             obj(descFields.value).type==="string"&&
             Object.hasOwn(descFields,"language_tag")&&
             Object.hasOwn(parts,"marketplace_id"))
            set("compartment",[{description:[{value:translated,language_tag:locale}],
              marketplace_id:marketId}]);
        }
      }
      // Localized copy is explicitly stored in this product/model dossier.
      // Missing or invalid locale content never falls back to Italian copy.
      const contentSource=obj(fields.localized_product_content_source);
      const sourceModel=val("model_number");
      if(fields.localized_product_content_status===
           "MODEL_GROUP_LOCALIZED_COPY_FROM_PRODUCT_DOSSIER"&&
         contentSource.source_type==="SHOPIFY_PRODUCT_DOSSIER_LOCALIZED_FACTS"&&
         typeof product.id==="string"&&contentSource.source_product_id===product.id&&
         sourceModel&&/^K[0-9]{4}[A-Z0-9]{2}$/.test(sourceModel)&&
         contentSource.source_model===sourceModel){
        const description=safeItalianDescription(localized.product_description);
        const bullets=verifiedMarketplaceBullets({type:"list.single_line_text_field",
          value:JSON.stringify(localized.bullet_point)});
        if(description)set("product_description",text(description));
        if(bullets.ok&&bullets.values.length)set("bullet_point",
          bullets.values.map(value=>({value,language_tag:locale,marketplace_id:marketId})));
      }
      for(const field of ["item_type_name","department","age_range_description",
          "care_instructions","style","weave_type","fit_type","lining_description","strap_type"]){
        const value=localVal(field);
        if(value)set(field,text(value));
      }
      const closure=localVal("closure"),outer=localVal("outer_material");
      if(closure)set("closure",[{type:[{value:closure,language_tag:locale}],marketplace_id:marketId}]);
      if(outer)set("outer",[{material:[{value:outer,language_tag:locale}],marketplace_id:marketId}]);
      if(["HANDBAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"].includes(pt)){
        const inner=localVal("inner_material"),sizeInfo=localVal("size_info");
        if(inner)set("inner",[{material:[{value:inner,language_tag:locale}],marketplace_id:marketId}]);
        if(sizeInfo)set("size_info",[{display_name:[{value:sizeInfo,language_tag:locale}],marketplace_id:marketId}]);
      }
      const fabric=localVal("fabric_type"),canonical=val("fabric_type");
      if(fabric&&canonical&&(
          validKwayFabricTranslation(canonical,fabric,marketplace)||
          (descriptiveFabric&&validKwayDescriptorTranslation(descriptiveFabric,fabric,marketplace))))
        set("fabric_type",text(fabric));
    }
    return attrs;
  }
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
  // Do not invent 100%-sum fiber composition for a documented technical
  // fleece. Accept exact merchant descriptive prose only when the original
  // live Shopify description, source Product ID and the dossier agree.
  const fabricProof=obj(obj(fields.field_provenance).fabric_type);
  const sourceDescription=typeof product.description==="string"?product.description:"";
  const rfrDescriptiveFabric=isRefrigiwear&&
    fields.fabric_type_kind==="TEXTILE_DESCRIPTION_WITHOUT_COMPOSITION_PERCENTAGES"&&
    fields.fabric_type_status==="DOCUMENTED_SHOPIFY_PRODUCT_DESCRIPTION"&&
    fabricProof.status==="DOCUMENTED_SHOPIFY_PRODUCT_DESCRIPTION"&&
    fabricProof.source_product_id===product.id&&
    fabricProof.source_field==="description"&&
    fabricProof.no_composition_percentages===true&&
    !!fabric&&typeof fabricProof.source_text==="string"&&
    fabric.toLocaleLowerCase("it")===fabricProof.source_text.toLocaleLowerCase("it")&&
    sourceDescription.toLocaleLowerCase("it").includes(
      fabric.toLocaleLowerCase("it"));
  if(fabric&&(validatedRefrigiwearFabric(fabric)||rfrDescriptiveFabric||
     (isKway&&(validatedKwayLayeredFabric(fabric)||descriptiveFabric))))
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
  if(["BACKPACK","HANDBAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"].includes(pt)&&typeof n==="number"&&
     Number.isInteger(n)&&n>=1&&n<=15)
    set("number_of_compartments",[{value:n,marketplace_id:marketId}]);
  // Amazon's DUFFEL_BAG "compartment" is a localized description array,
  // not an integer count. Only emit source-traced exact-product prose and
  // only when the live PTD exposes the verified nested wire shape.
  if(isKway&&pt==="DUFFEL_BAG"){
    const compartmentText=val("compartment_description");
    const evidence=obj(obj(fields.field_provenance).compartment_description);
    const schema=obj(ptdTechnicalShapes.compartment);
    const entry=obj(schema.items), entryFields=obj(entry.properties);
    const descriptions=obj(entryFields.description);
    const descriptionEntry=obj(descriptions.items);
    const descriptionFields=obj(descriptionEntry.properties);
    if(compartmentText&&
       evidence.status==="DOCUMENTED_EXACT_SHOPIFY_PRODUCT_DESCRIPTION"&&
       evidence.source_product_id===product.id&&
       evidence.source_model===fields.model_number&&
       typeof fields.model_number==="string"&&
       sku.startsWith("KWAY_"+fields.model_number)&&
       /^[_ .-]/.test(sku.slice(5+fields.model_number.length))&&
       evidence.source_field==="product.description"&&
       schema.type==="array"&&entry.type==="object"&&
       descriptions.type==="array"&&descriptionEntry.type==="object"&&
       obj(descriptionFields.value).type==="string"&&
       Object.hasOwn(descriptionFields,"language_tag")&&
       Object.hasOwn(entryFields,"marketplace_id")){
      set("compartment",[{description:[{value:compartmentText,language_tag:locale}],
        marketplace_id:marketId}]);
    }
  }
  const pockets=fields.number_of_pockets;
  if(isKway&&["HANDBAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"].includes(pt)&&typeof pockets==="number"&&
     Number.isInteger(pockets)&&pockets>=0&&pockets<=30)
    set("number_of_pockets",[{value:pockets,marketplace_id:marketId}]);
  const inner=val("inner_material");
  if(isKway&&["HANDBAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"].includes(pt)&&inner)
    set("inner",[{material:[{value:inner,language_tag:locale}],
      marketplace_id:marketId}]);
  const sizeInfo=val("size_info");
  if(isKway&&["HANDBAG","TOTE_BAG","DUFFEL_BAG","WAIST_PACK","WALLET"].includes(pt)&&sizeInfo)
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
  // The source dossier describes the physical item, not its shipping carton.
  // For the K-Way IT shopper/duffel, documented L/H/P measurements correspond
  // to length/height/depth; map P to Amazon's item width. Never copy this to
  // item_package_dimensions, and never transform ambiguous Ferimy measurements.
  if(isKway&&["TOTE_BAG","DUFFEL_BAG"].includes(pt)&&
     ["height","width","depth"].every(x=>
       typeof size3[x]==="number"&&Number.isFinite(size3[x])&&
       (size3[x] as number)>0&&(size3[x] as number)<500)){
    set("item_length_width_height",[{
      length:{value:size3.width,unit:"centimeters"},
      width:{value:size3.depth,unit:"centimeters"},
      height:{value:size3.height,unit:"centimeters"},
      marketplace_id:marketId
    }]);
  }
  // Preserve the separate legacy label-attested path. A public brand contact
  // without the explicit commercial inference above remains insufficient.
  if(operator&&(
      (isKway&&fields.manufacturer_status===
        "PRODUCT_MANUFACTURER_ROLE_VERIFIED_FROM_OFFICIAL_PRODUCT_LABEL")||
      (!isKway&&fields.manufacturer_status===
        "LEGAL_BRAND_OPERATOR_PUBLICLY_VERIFIED_NOT_FACTORY_OF_ORIGIN")))
    set("manufacturer",text(operator));
  for(const field of ["model_number","part_number"]){
    const value=val(field);
    if(value)set(field,text(value));
  }
  const outer=val("outer_material");
  if(outer)set("outer",[{material:[{value:outer,language_tag:locale}],
    marketplace_id:marketId}]);
  const officialColor=val("color");
  if(officialMatch&&officialColor&&
     typeof product.title==="string"&&product.title.endsWith(officialColor))
    set("color",[{value:officialColor,marketplace_id:marketId}]);
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
  if(size&&!inferredStandard)set("special_size_type",[{value:"Standard",
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
  return attrs;
}

/** Source-scoped K-Way two-shell construction: both fabrics are 100% in
 * their respective panels. Never flatten this into one percentage blend.
 * The caller additionally requires an exact Product ID and verified evidence.
 */
export function validatedKwayLayeredFabric(value:string):boolean{
  return value==="Shell A: 100% Nylon; Shell B: 100% Poliestere";
}

// Canonical material words are shared by quantified compositions and separate
// unquantified descriptions. Rayon remains distinct from viscose.
const KWAY_FABRIC_WORDS:Record<string,Record<string,string[]>>={
  nylon:{DE:["Nylon"],FR:["Nylon"],ES:["Nylon","Nailon"]},
  cotone:{DE:["Baumwolle"],FR:["Coton"],ES:["Algodón"]},
  poliestere:{DE:["Polyester"],FR:["Polyester"],ES:["Poliéster"]},
  elastan:{DE:["Elasthan"],FR:["Élasthanne"],ES:["Elastano"]},
  acrilico:{DE:["Acryl","Polyacryl"],FR:["Acrylique"],ES:["Acrílico"]},
  poliammide:{DE:["Polyamid"],FR:["Polyamide"],ES:["Poliamida"]},
  poliuretano:{DE:["Polyurethan"],FR:["Polyuréthane"],ES:["Poliuretano"]},
  viscosa:{DE:["Viskose"],FR:["Viscose"],ES:["Viscosa"]},
  lana:{DE:["Wolle"],FR:["Laine"],ES:["Lana"]},
  rayon:{DE:["Rayon"],FR:["Rayonne"],ES:["Rayón"]},
  misto:{DE:["Mischgewebe"],FR:["Tissu mélangé"],ES:["Tejido mixto"]},
  tessuto:{DE:["Gewebe"],FR:["Tissu"],ES:["Tejido"]},
  pile:{DE:["Fleece"],FR:["Polaire"],ES:["Polar","Forro polar"]},
  "lana merino":{DE:["Merinowolle"],FR:["Laine mérinos"],ES:["Lana merina"]}
};
const fabricWord=(value:string)=>value.normalize("NFC").toLowerCase();
function kwayDescriptorParts(value:string):string[]{
  const parts=fabricWord(value).split(" e ");
  return parts.length<=3&&parts.every(x=>Object.hasOwn(KWAY_FABRIC_WORDS,x))?parts:[];
}
function kwayDescriptiveFabric(fields:Row,productId:unknown):string|undefined{
  const value=fields.fabric_type,source=obj(fields.fabric_type_source);
  if(typeof value!=="string"||value.length>120||!kwayDescriptorParts(value).length||
     fields.fabric_type_status!=="INFERRED_USER_AUTHORIZED"||
     fields.fabric_type_kind!=="TEXTILE_DESCRIPTION_WITHOUT_COMPOSITION_PERCENTAGES"||
     source.source_product_id!==productId||
     !["SHOPIFY_PRODUCT_FIELD","OFFICIAL_PRODUCT_PAGE"].includes(String(source.source_type))||
     typeof source.source_field!=="string"||source.source_field.length<2||source.source_field.length>120||
     typeof source.source_descriptor!=="string"||
     fabricWord(source.source_descriptor)!==fabricWord(value))return undefined;
  return value;
}
function validKwayDescriptorTranslation(source:string,translated:string,market:string):boolean{
  const joins:Record<string,string>={DE:" und ",FR:" et ",ES:" y "};
  const parts=kwayDescriptorParts(source),join=joins[market];
  if(!parts.length||!join)return false;
  const targets=fabricWord(translated).split(join);
  return targets.length===parts.length&&parts.every((word,i)=>
    KWAY_FABRIC_WORDS[word]?.[market]?.some(x=>fabricWord(x)===targets[i]));
}
function validKwayFabricTranslation(source:string,translated:string,market:string):boolean{
  if(validatedKwayLayeredFabric(source)){
    const labels:Record<string,string>={DE:"Schicht",FR:"Couche",ES:"Capa"};
    const label=labels[market];
    const parts=translated.split("; ");
    return !!label&&parts.length===2&&parts[0].startsWith(label+" A: ")&&
      parts[1].startsWith(label+" B: ")&&
      validKwayFabricTranslation("100% Nylon",parts[0].slice(label.length+4),market)&&
      validKwayFabricTranslation("100% Poliestere",parts[1].slice(label.length+4),market);
  }
  // The original complete composition must pass the existing 100% validator.
  // Compare each percentage and corresponding material, not merely the total.
  if(!validatedRefrigiwearFabric(source))return false;
  const canonical=source.split(", "),localized=translated.split(", ");
  return canonical.length===localized.length&&canonical.every((part,i)=>{
    const a=/^([1-9][0-9]{0,2})% (.+)$/.exec(part);
    const b=/^([1-9][0-9]{0,2}) ?% (.+)$/.exec(localized[i]);
    return !!a&&!!b&&a[1]===b[1]&&validKwayDescriptorTranslation(a[2],b[2],market);
  });
}

/** Only source-backed percentages in the existing Shopify evidence metafield.
 * Validate the complete 100% composition without inventing, normalizing or
 * dropping components. The source must still be verified before writing it.
 */
export function validatedRefrigiwearFabric(value:string):boolean{
  if(typeof value!=="string"||value.length>120)return false;
  const parts=value.split(", ");
  if(parts.length<1||parts.length>3)return false;
  const allowed=new Set(["Nylon","Cotone","Poliestere","Elastan","Acrilico","Poliammide","Poliuretano","Viscosa","Lana","Rayon"]);
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
// This validates text shape only; callers bind canonical IT or explicit localized copy.
function safeItalianDescription(raw:unknown):string|undefined{
  if(typeof raw!=="string")return undefined;
  const value=raw.trim();
  return value.length>=30&&value.length<=2000&&
    !/[\u0000-\u001f\u007f<>]/.test(value)?value:undefined;
}
// Validate explicit typed bullet lists; callers establish product and locale provenance.
// Amazon bullet arrays are capped at five for this pilot.
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
  // Research admits this digit-leading token only for the unique same-schema
  // pair 3x_l / 3XL. Do not broaden other sizes (e.g. the ambiguous XXL tokens).
  const mapped=typeof fromPtd==="string"&&
    (/^[a-z][a-z0-9_]{0,63}$/.test(fromPtd)||
      (option.size==="XXXL"&&fromPtd==="3x_l"))?
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
/** Verify the Standard adult profile against the dossier for this product and market. */
function kwayStandardAdultSize(product:Row,sku:string,marketplace:Market):boolean{
  const mf=obj(product.amazonPtd);
  if(!sku.startsWith("KWAY_")||
     product.vendor!=="K-Way"||typeof product.id!=="string"||
     mf.type!=="json"||typeof mf.value!=="string")return false;
  let dossier:Row;
  try{dossier=obj(JSON.parse(mf.value));}catch{return false;}
  const fields=obj(dossier.amazon_ptd_evidence),overrides=obj(fields.special_size_type_by_market);
  return dossier.source_product_id===product.id&&
    fields.source_scope==="K-WAY_PRODUCT_VERIFIED_BY_MERCHANT"&&
    fields.special_size_type==="Standard"&&
    fields.special_size_type_status==="INFERRED_STANDARD_ADULT_CATALOG_SIZING"&&
    fields.age_range_description==="Adulto"&&
    (!Object.hasOwn(overrides,marketplace)||overrides[marketplace]==="Standard");
}
function blocked(marketplace:string,sku:string,productType:string,reason:string):Row{
  return {ok:false,status:"BLOCKED_PREVIEW",marketplace,sku,product_type:productType,reason,
    preview_only:true,provider_mutations:0,product_created:false,can_publish:false,
    listing_write_enabled:false,channable_handoff_performed:false,
    brand_authorization_proven:false,gpsr_compliance_proven:false,
    full_schema_validated:false};
}

/**
 * Source-grounded apparel evidence for Colmar Originals and Ecoalf.
 * Never infers origin, GPSR contacts, physical package size or weight.
 * Facts originate from the exact live Shopify product, its selected variant
 * and the Amazon brand/manufacturer labels verified on current catalog items.
 * This is an Amazon VALIDATION_PREVIEW candidate, NOT an approval to publish.
 */
export function merchantMultibrandEvidenceAttrs(
  product:Row,variant:Row,sku:string,pt:string,marketplace:string,
  marketId:string,available:string[],research:Row={}
):Row{
  const isColmar=sku.startsWith("COL_")&&
    ["Colmar","Colmar Originals"].includes(String(product.vendor));
  const isEco=sku.startsWith("ECO_")&&product.vendor==="Ecoalf";
  if((!isColmar&&!isEco)||marketplace!=="IT"||!Array.isArray(available))return {};
  const desc=typeof product.description==="string"?product.description:"";
  const title=typeof product.title==="string"?product.title:"";
  if(!desc||desc.length>12000||!title||title.length>200)return {};
  const attrs:Row={};
  const allowed=new Set(available);
  const text=(value:string)=>[{value,language_tag:"it_IT",marketplace_id:marketId}];
  const set=(name:string,value:unknown)=>{
    if(allowed.has(name)&&value!==undefined)attrs[name]=value;
  };
  const plain=(s:string)=>s.replace(/\s+/g," ").trim();
  const candidate=(value:unknown,max=160):string|undefined=>
    typeof value==="string"&&value.trim().length>=2&&value.trim().length<=max&&
    !/[\u0000-\u001f<>]/.test(value)?plain(value):undefined;
  const originalModel=desc.match(/\bModello:\s*([A-Za-z0-9][A-Za-z0-9 .'-]{1,50}?)(?=\s+Genere:|\s+Colore:|\s+Codice|$)/i)?.[1];
  const model=candidate(originalModel,60);
  if(model)set("model_name",[{value:model,marketplace_id:marketId}]);
  const genderField=desc.match(/\bGenere:\s*(Uomo|Donna|Unisex)\b/i)?.[1];
  const gender=genderField||title.match(/\b(Uomo|Donna|Unisex)\b/i)?.[1];
  if(gender){
    const department=gender.charAt(0).toUpperCase()+gender.slice(1).toLowerCase();
    set("department",text(department));
    set("age_range_description",text("Adulto"));
  }
  const color=desc.match(/\bColore:\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ -]{1,45}?)(?=\s+Codice|\s+Stagione|$)/i)?.[1];
  if(candidate(color,46))set("color",text(plain(color!)));
  // Colmar catalogue descriptors are derived from this exact merchant SKU,
  // its Shopify title/options, and (when populated) its variant inventory origin.
  // No seller logistics preset, product specification, hazmat, or GPSR value is
  // inferred from model names or similar products.
  if(isColmar){
    const matchCode=/^COL_([A-Za-z0-9]{3,20})_[A-Za-z0-9]{2,8}_[A-Za-z0-9]{1,5}_[A-Za-z0-9]{1,8}$/.exec(sku);
    if(matchCode){
      set("model_name",[{value:matchCode[1],marketplace_id:marketId}]);
      set("model_number",[{value:matchCode[1],marketplace_id:marketId}]);
    }
    // Only literal colour endings already present in the merchant's exact
    // product title; never infer the colour from an unverified SKU colour code.
    const allowedColors=[
      "Blu Navy Tofu Brick","Marrakech Tofu Navy","Blu Navy Multicolor",
      "Marrakech Multicolor","Grigio Street","Beige Marrakech",
      "Bianco Tofu","Tofu Marrakech","Blu Navy","Nero"
    ];
    const exactColor=allowedColors.find(value=>title.endsWith(" "+value));
    if(exactColor)set("color",text(exactColor));
    const variantOrigin=obj(variant.inventoryItem).countryCodeOfOrigin;
    // Shopify InventoryItem countryCodeOfOrigin is a variant-level merchant
    // declaration, not evidence of where a brand's other garments are made.
    const supportedOrigin=new Set(["IT","CN","TR","RO","PT","ES","FR","DE",
      "BG","PL","TN","MA","BD","VN","IN","PK","ID","KH","MM","EG","AL",
      "MD","UA","GR","CZ","SK","HU","SI","HR","LT","LV","EE","GB","US"]);
    if(typeof variantOrigin==="string"&&supportedOrigin.has(variantOrigin)){
      set("country_of_origin",[{value:variantOrigin,marketplace_id:marketId}]);
    }else if(variantOrigin===null||variantOrigin===undefined||variantOrigin===""){
      // 2026-11-26 explicit merchant declaration: Colmar stock for this store
      // is Made in China. This is merchant-provided provenance, not inferred
      // from the Italian brand address; never override a conflicting variant.
      set("country_of_origin",[{value:"CN",marketplace_id:marketId}]);
    }
    // Merchant explicitly approved standardized FBM packing on 2026-11-26.
    // These are shipment-box/mailer allowances chosen by the seller, not
    // measured garment dimensions or manufacturer-provided factory weights.
    // Apply only to Colmar ordinary apparel/accessory classes for which the
    // merchant has authorized this fulfilment preset, and never to Ecoalf.
    const colmarPacking:Record<string,{length:number;width:number;height:number;weight:number}>={
      COAT:{length:58,width:42,height:18,weight:1.8},
      SWEATER:{length:40,width:32,height:10,weight:0.9},
      SWEATSHIRT:{length:42,width:35,height:12,weight:1.2},
      SHIRT:{length:38,width:30,height:7,weight:0.6},
      HAT:{length:35,width:25,height:12,weight:0.5},
      SCARF:{length:38,width:28,height:8,weight:0.6},
      HANDBAG:{length:50,width:38,height:18,weight:1.5}
    };
    const packing=colmarPacking[pt];
    if(packing){
      set("item_package_dimensions",[{
        length:{value:packing.length,unit:"centimeters"},
        width:{value:packing.width,unit:"centimeters"},
        height:{value:packing.height,unit:"centimeters"},
        marketplace_id:marketId
      }]);
      set("item_package_weight",[{value:packing.weight,unit:"kilograms",
        marketplace_id:marketId}]);
      // Garments and standard non-electronic bags here have no intrinsic
      // batteries/chemicals. Seller declaration for this scoped Colmar
      // non-hazardous apparel cohort.
      set("supplier_declared_dg_hz_regulation",[
        {value:"not_applicable",marketplace_id:marketId}]);
    }
    if(["SWEATER","SWEATSHIRT","SCARF"].includes(pt)){
      set("weave_type",text("Maglia"));
    }else if(["COAT","SHIRT","HAT","HANDBAG"].includes(pt)){
      set("weave_type",text("Tessuto"));
    }
    // General clothing style is a seller catalogue classification, not an
    // unverified waterproof performance or supplier claim.
    if(["COAT","SWEATER","SWEATSHIRT","SHIRT","HAT","HANDBAG"].includes(pt))
      set("style",text("Casual"));
    if(pt==="HAT"&&/_UNICA$/.test(sku)){
      // For headwear Amazon uses its own size field. Only emit when one-size
      // is actually indicated by the merchant SKU/Shopify variant.
      const opt=Array.isArray(variant.selectedOptions)?
        variant.selectedOptions.map(obj):[];
      const headSize=opt.find(o=>typeof o.name==="string"&&
        ["taglia","size"].includes(o.name.toLowerCase()))?.value;
      if(headSize==="Unica"||headSize==="UNICA"||headSize==="Taglia unica"){
        const shape=obj(obj(research.ptd_size_shapes).headwear_size);
        const item=obj(shape.items),props=obj(item.properties);
        const systems=obj(props.size_system).enum;
        const classes=obj(props.size_class).enum;
        const tokenSet=obj(research.ptd_alpha_size_tokens).headwear_size;
        const mandatory=item.required;
        if(shape.type==="array"&&item.type==="object"&&
           Array.isArray(systems)&&systems.includes("as6")&&
           Array.isArray(classes)&&classes.includes("alpha")&&
           Array.isArray(mandatory)&&
           ["size","size_class","size_system"].every(x=>mandatory.includes(x))&&
           Array.isArray(tokenSet)&&tokenSet.includes("one_size"))
          set("headwear_size",[{
            size:"one_size",size_class:"alpha",size_system:"as6",
            marketplace_id:marketId}]);
      }
    }
    const optionSize=Array.isArray(variant.selectedOptions)?
      variant.selectedOptions.map(obj).find(o=>
        typeof o.name==="string"&&["taglia","size"].includes(o.name.toLowerCase()))?.value:undefined;
    if(typeof optionSize==="string"&&
       ((/^(3[6-9]|4[0-9]|5[0-9]|60)$/.test(optionSize)&&pt==="COAT")||
        (["SWEATER","SWEATSHIRT","SHIRT"].includes(pt)&&/^(XXS|XS|S|M|L|XL|XXL|XXXL)$/.test(optionSize))||
        (pt==="HAT"&&["Unica","UNICA","Taglia unica"].includes(optionSize)))&&
       (sku.endsWith("_"+optionSize)||
         (pt==="HAT"&&sku.endsWith("_UNICA")))&&
       /\b(?:Uomo|Donna)\b/.test(title)){
      set("special_size_type",text("Standard"));
    }
    // Additional merchant-exact garment descriptions beyond the narrow
    // "chiusura frontale con zip" path below.
    if(/\b(?:chiusura\s+a\s+doppia\s+zip|zip\s+frontale\s+a\s+doppio\s+cursore)\b/i.test(desc)){
      set("closure",[{type:[{value:"Zip",language_tag:"it_IT"}],
        marketplace_id:marketId}]);
    }
    if(/\bvestibilit[aà]\s+regular\b/i.test(desc))
      set("fit_type",text("Regular"));
  }
  if(isColmar)set("manufacturer",text("COLMAR"));
  if(isEco)set("manufacturer",text("Ecoalf"));
  // Official Ecoalf AW26 specification is common to the exact documented
  // Mountain/Contraste sock models (not every Ecoalf sock).
  // https://ecoalf.com/it/products/mountain-calze-unisex-medio-grigio-melange-aw26
  // https://ecoalf.com/it/products/contraste-calze-alto-uomo-arancione-bruciato-aw26
  // https://ecoalf.com/it/products/contraste-calze-basso-donna-bianco-sporco-aw26
  const ecoSockAW26=isEco&&pt==="SOCKS"&&
    /^ECO_(?:MCUACSXMOUNT0697W26|MCMACSXCONTH0697W26|MCWACSXCONTL0697W26)_[A-Za-z0-9_]+$/.test(sku);
  if(ecoSockAW26){
    const origin=obj(variant.inventoryItem).countryCodeOfOrigin;
    if(origin===undefined||origin===null||origin==="ES"){
      set("country_of_origin",[{value:"ES",marketplace_id:marketId}]);
    }
    const documentedFabric="30% poliammide riciclata / 30% lana riciclata / "+
      "30% TENCEL Lyocell / 10% cashmere riciclato";
    set("fabric_type",text(documentedFabric));
    // Unisex Mountain and gender-specific Contraste socks are knitted
    // accessories. These values are merchant classifications, not an
    // unverified supplier claim about a particular fabric treatment.
    set("weave_type",text("Maglia"));
    set("style",text(sku.includes("MOUNT")?"Sportivo":"Casual"));
    set("special_size_type",text("Standard"));
    // Seller-controlled FBM mailer preset, NOT product dimensions, factory
    // product weight or a measured supplier package. Conservative shipment
    // allowance selected for the lightweight AW26 sock group only.
    set("item_package_dimensions",[{
      length:{value:25,unit:"centimeters"},
      width:{value:18,unit:"centimeters"},
      height:{value:4,unit:"centimeters"},
      marketplace_id:marketId
    }]);
    set("item_package_weight",[{
      value:0.2,unit:"kilograms",marketplace_id:marketId
    }]);
    // No batteries, liquids or chemical contents in ordinary textile socks.
    // Seller non-hazardous goods classification for these exact sock models.
    set("supplier_declared_dg_hz_regulation",[{
      value:"not_applicable",marketplace_id:marketId
    }]);
    set("outer",[{material:[{value:documentedFabric,language_tag:"it_IT"}],
      marketplace_id:marketId}]);
    const explicitGender=desc.match(/\bGenere:\s*(Uomo|Donna|Unisex)\b/i)?.[1];
    const targetGender=explicitGender?.toLowerCase()==="uomo"?"male":
      explicitGender?.toLowerCase()==="donna"?"female":
      explicitGender?.toLowerCase()==="unisex"?"unisex":undefined;
    if(targetGender)set("target_gender",[{value:targetGender,marketplace_id:marketId}]);
    // Preserve numeric EU ranges only when the actual Amazon LISTING PTD
    // explicitly accepts as6/numeric, size_to and the required keys.
    const sel=Array.isArray(variant.selectedOptions)?
      variant.selectedOptions.map(obj):[];
    const sizeOpts=sel.filter(o=>typeof o.name==="string"&&
      ["taglia","size"].includes(o.name.toLowerCase()));
    const sizeRaw=sizeOpts.length===1?sizeOpts[0].value:null;
    const interval=typeof sizeRaw==="string"?
      /^([3-4][0-9])\s*[-–]\s*([3-4][0-9])$/.exec(sizeRaw):null;
    const schema=obj(obj(research.ptd_size_shapes).apparel_size);
    const shape=obj(schema.items),properties=obj(shape.properties);
    const systems=obj(properties.size_system).enum;
    const classes=obj(properties.size_class).enum;
    const required=shape.required;
    const bodyTokens=obj(properties.body_type).enum;
    const heightTokens=obj(properties.height_type).enum;
    const regularProfile=Array.isArray(bodyTokens)&&bodyTokens.includes("regular")&&
      Array.isArray(heightTokens)&&heightTokens.includes("regular");
    const strictShape=research.ptd_size_shapes_are_read_only===true&&
      research.ptd_size_shapes_not_schema_validation===true&&
      research.ptd_size_mapping_not_performed===true&&
      schema.type==="array"&&shape.type==="object"&&
      Array.isArray(systems)&&systems.length===1&&systems[0]==="as6"&&
      Array.isArray(classes)&&classes.includes("numeric")&&
      obj(properties.size_to).type==="string"&&
      Array.isArray(required)&&["size","size_class","size_system"].every(
        field=>required.includes(field));
    if(interval&&strictShape){
      const lower=Number(interval[1]),upper=Number(interval[2]);
      const originalRange=interval[1]+"-"+interval[2];
      if(lower>=30&&upper<=49&&lower<upper&&upper-lower<=12){
        // Amazon IT SOCKS rejects exact 36-40 / 41-46 numeric interval values
        // with 99022/90004205, even when both conditional qualifiers exist.
        // Only use its LIVE PTD alpha labels, not an invented arbitrary token.
        const alphaTokens=obj(research.ptd_alpha_size_tokens).apparel_size;
        const curatedAlpha=originalRange==="41-46"?"l":
          ["36-40","36-41"].includes(originalRange)?"m":undefined;
        const alphaAllowed=curatedAlpha&&classes.includes("alpha")&&
          Array.isArray(alphaTokens)&&alphaTokens.includes(curatedAlpha);
        if(typeof curatedAlpha==="string"&&alphaAllowed){
          set("apparel_size",[{
            size:curatedAlpha,size_class:"alpha",size_system:"as6",
            ...(regularProfile?{body_type:"regular",height_type:"regular"}:{}),
            marketplace_id:marketId
          }]);
          // Expose the exact manufacturer size range to buyers even when
          // Amazon displays its permitted M/L alpha size labels.
          set("bullet_point",[{
            value:"Taglia europea riportata dal produttore: "+originalRange+
              " (corrispondenza taglia Amazon "+curatedAlpha.toUpperCase()+").",
            language_tag:"it_IT",marketplace_id:marketId
          }]);
        }else{
          set("apparel_size",[{
            size:interval[1],size_to:interval[2],
            size_class:"numeric",size_system:"as6",
            ...(regularProfile?{body_type:"regular",height_type:"regular"}:{}),
            marketplace_id:marketId
          }]);
        }
      }
    }
  }
  const productType=candidate(product.productType,90);
  if(productType)set("item_type_name",text(productType));
  // Choose the main outer fabric, never concatenate separate lining/filling.
  const match=desc.match(/(?:Tessuto principale|Tessuto esterno e fodera|Esterno e fodera|Esterno)\s*:?\s*(100\s*%\s*(?:poliammide|cotone|poliestere|nylon|lana|viscosa|acrilico|elastan))\b/i);
  if(match){
    const mainFabric=plain(match[1]).replace(/\s*%\s*/,"% ");
    set("fabric_type",text(mainFabric));
    set("outer",[{material:[{value:mainFabric,language_tag:"it_IT"}],
      marketplace_id:marketId}]);
  }
  // Only the documented principal OUTER shell composition may feed Amazon
  // fabric_type/outer. Secondary panels, linings and down filling are kept
  // separate, not added to the shell blend. The percentage total must be 100.
  if(isColmar){
    const normalized=plain(desc).replace(
      /composizione(?=(?:Esterno|Tessuto|\d{1,3}\s*%))/gi,"composizione ");
    const marker=/(?:\bEsterno, secondo tessuto esterno e fodera|\bEsterno(?: principale| e fodera)?|\bTessuto (?:esterno(?: e fodera)?|principale))\s*:?\s*/i.exec(normalized);
    const sweaterSection=pt==="SWEATER"||pt==="SWEATSHIRT";
    const standalone=sweaterSection?
      /\bMateriali e composizione\s+(?=\d{1,3}\s*%)/i.exec(normalized):null;
    const source=marker||standalone;
    if(source){
      const raw=normalized.slice(source.index+source[0].length).split(/[.;]/,1)[0].trim();
      if(raw.length>=8&&raw.length<=160&&/^\d{1,3}\s*%/.test(raw)){
        const fibers: {percent:number;name:string}[]=[];
        const fiberRe=/(\d{1,3})\s*%\s*(lana vergine|poliammide|poliestere|elastan|cotone|lana|acrilico|viscosa|nylon|cashmere)/gi;
        let item:RegExpExecArray|null;
        while((item=fiberRe.exec(raw))!==null){
          fibers.push({percent:Number(item[1]),name:item[2].toLowerCase()});
        }
        const rest=raw.replace(fiberRe,"").replace(/[\s,;\/+\-]/g,"").replace(/e/g,"");
        if(fibers.length>=1&&fibers.length<=4&&rest===""&&
           fibers.every(x=>x.percent>0&&x.percent<=100)&&
           fibers.reduce((n,x)=>n+x.percent,0)===100){
          const shell=fibers.map(x=>x.percent+"% "+x.name).join(" / ");
          set("fabric_type",text(shell));
          set("outer",[{material:[{value:shell,language_tag:"it_IT"}],
            marketplace_id:marketId}]);
        }
      }
    }
  }
  if(/\bidrorepellente\b/i.test(desc))
    set("water_resistance_level",[{value:"water_resistant",marketplace_id:marketId}]);
  if(isColmar&&/\bimpermeabile\b/i.test(desc)&&
     !/\bnon\s+impermeabile\b/i.test(desc))
    set("water_resistance_level",[{value:"waterproof",marketplace_id:marketId}]);
  // Conservative seller default: do not claim water-resistance performance
  // absent an exact Shopify/official claim. Scoped to Colmar apparel COAT /
  // SWEATER; a positive water claim always overrides this non-claim baseline.
  if(isColmar&&["COAT","SWEATER"].includes(pt)&&
     !Object.hasOwn(attrs,"water_resistance_level")&&
     !/\b(?:idrorepellente|impermeabile|waterproof)\b/i.test(desc))
    set("water_resistance_level",[{value:"not_water_resistant",
      marketplace_id:marketId}]);
  // Do not assert water resistance when the exact merchant description
  // contains no supporting statement.
  if(/\bchiusura(?:\s+frontale)?\s+(?:con|a)\s+(?:doppia\s+)?zip\b/i.test(desc)||
     (isColmar&&/\bzip a doppio cursore\b/i.test(desc)))
    set("closure",[{type:[{value:"Zip",language_tag:"it_IT"}],
      marketplace_id:marketId}]);
  if(isColmar&&/\bchiusura(?:\s+frontale)?\s+con\s+bottoni\b/i.test(desc))
    set("closure",[{type:[{value:"Bottoni",language_tag:"it_IT"}],
      marketplace_id:marketId}]);
  if(/\b(casual|urbano)\b/i.test(desc))set("style",text("Casual"));
  if(/\bsportivo\b/i.test(desc))set("style",text("Sportivo"));
  if(["COAT","HAT","SHIRT","SWEATER","SWEATSHIRT","SCARF","SOCKS"].includes(pt))
    set("batteries_required",[{value:false,marketplace_id:marketId}]);
  // Source-neutral care advice is a direction to inspect the sewn-in label,
  // not a fabricated claim about permitted washing temperature.
  if(["COAT","HAT","SHIRT","SWEATER","SWEATSHIRT","SCARF","SOCKS"].includes(pt))
    set("care_instructions",text("Seguire le indicazioni riportate sull'etichetta"));
  const compare=typeof variant.compareAtPrice==="string"?
    Number(variant.compareAtPrice):NaN;
  if(Number.isFinite(compare)&&compare>0&&compare<10000)
    set("list_price",[{currency:"EUR",value_with_tax:compare,marketplace_id:marketId}]);
  // Product-description sentences are merchant-provided factual marketing copy.
  // Shopify strips HTML separators, so sentence boundaries can be adjacent
  // (e.g. "indossare.Perfetta"). Keep the literal source sentences intact.
  const bullets=desc.split(/[.!?](?=\s|[A-ZÀ-Ý])/).map(x=>plain(x))
    .filter(x=>x.length>=45&&x.length<=200);
  if(bullets.length)set("bullet_point",bullets.slice(0,3).map(value=>({
    value,language_tag:"it_IT",marketplace_id:marketId})));
  else if(isColmar&&desc.length>=45){
    // Short merchant descriptions: shorten existing literal source copy;
    // no generated claims or borrowing details from related garments.
    const value=plain(desc).slice(0,180).replace(/\s+\S*$/,"").trim();
    if(value.length>=45)set("bullet_point",text(value));
  }
  // The size disclosure must follow merchant bullets: the generic bullet
  // source mapper above would otherwise overwrite the size-specific bullet.
  if(ecoSockAW26){
    const options=Array.isArray(variant.selectedOptions)?
      variant.selectedOptions.map(obj):[];
    const size=options.find(o=>typeof o.name==="string"&&
      ["taglia","size"].includes(o.name.toLowerCase()))?.value;
    if(typeof size==="string"&&["36-40","36-41","41-46"].includes(size)){
      const original=Array.isArray(attrs.bullet_point)?attrs.bullet_point:[];
      set("bullet_point",[...original.slice(0,3),{
        value:"Taglia europea riportata nella variante Shopify: "+size+".",
        language_tag:"it_IT",marketplace_id:marketId
      }]);
    }
  }
  // Ecoalf's official AW26 Black Maka jacket lists the model's exact
  // technical shell and commercial specifications. Apply only to Black
  // 319 model code/season/size variants of the same live Shopify product.
  // https://ecoalf.com/it/products/maka-giacca-donna-nero-aw26
  const officialMaka=isEco&&pt==="COAT"&&product.title==="Giacca Maka Black"&&
    /^ECO_MCWGAJKMAKA00255W26_319_(XS|S|M|L|XL)$/.test(sku);
  if(officialMaka){
    // The 58% UTO + 42% textile-to-textile polyester blend sums to 100%
    // recycled polyester; do not combine the lining or FELLEX filling.
    const shell="100% Poliestere riciclato";
    set("fabric_type",text(shell));
    set("outer",[{material:[{value:shell,language_tag:"it_IT"}],
      marketplace_id:marketId}]);
    set("weave_type",text("Tessuto tecnico"));
    set("water_resistance_level",[{value:"waterproof",marketplace_id:marketId}]);
    set("closure",[{type:[{value:"Zip e bottoni",language_tag:"it_IT"}],
      marketplace_id:marketId}]);
    set("style",text("Tecnico"));
    set("special_size_type",text("Standard"));
    set("care_instructions",text("Non lavare"));
    // Seller FBM mailer envelope (45 x 35 x 12 cm), not a manufacturer
    // item dimension. Shipping allowance 1.10 kg includes the verified
    // 0.85 kg jacket + packing material reserve.
    set("item_package_dimensions",[{
      length:{value:45,unit:"centimeters"},
      width:{value:35,unit:"centimeters"},
      height:{value:12,unit:"centimeters"},
      marketplace_id:marketId
    }]);
    set("item_package_weight",[{value:1.1,unit:"kilograms",
      marketplace_id:marketId}]);
    set("supplier_declared_dg_hz_regulation",[{
      value:"not_applicable",marketplace_id:marketId
    }]);
  }
  return attrs;
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
      !(pt==="COAT"&&sku.startsWith("RFR_")&&shop.brand==="Refrigiwear"&&
        research.product_type_discovery_source==="AMAZON_KEYWORDS_REFRIGIWEAR_COAT")&&
      !(pt==="COAT"&&sku.startsWith("KWAY_")&&brand==="K-Way"&&
        research.product_type_discovery_source==="AMAZON_KEYWORDS_KWAY_COAT"))||
     !eanValid(ean as string)||
     (shop.upc!==null&&shop.upc!==undefined)||
     typeof title!=="string"||!title.trim()||title.length>200||
     typeof brand!=="string"||!brand.trim()||brand.length>100||
     !Number.isSafeInteger(shop.shopify_available)||(shop.shopify_available as number)<0||
     ((shop.shopify_available as number)===0&&
      !(sku.startsWith("RFR_")&&shop.brand==="Refrigiwear")&&
      !(sku.startsWith("KWAY_")&&brand==="K-Way"))||
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
  const multibrandEvidence=merchantMultibrandEvidenceAttrs(p,v,sku,pt,marketplace,
    AMAZON_EU_MARKETPLACES[marketplace],research.available_schema_attribute_names as string[],research);
  // Amazon IT 99022 requires both conditional adult Standard qualifiers for
  // Ecoalf Maka Black AW26. Match only the official exact-model source dossier,
  // live Shopify age group, vendor, color and known size SKU; never generalize.
  const ecoMakaAdultStandard=marketplace==="IT"&&pt==="COAT"&&
    p.vendor==="Ecoalf"&&p.title==="Giacca Maka Black"&&
    /^ECO_MCWGAJKMAKA00255W26_319_(XS|S|M|L|XL)$/.test(sku)&&
    obj((multibrandEvidence.special_size_type as Row[]|undefined)?.[0]).value==="Standard"&&
    obj((multibrandEvidence.age_range_description as Row[]|undefined)?.[0]).value==="Adulto";
  const sizeShape=obj(obj(research.ptd_size_shapes)[pt==="SHIRT"?"shirt_size":"apparel_size"]);
  const sizeProps=obj(obj(sizeShape.items).properties);
  // German 99022 previews require both qualifiers for adult alpha sweatshirts.
  const usesStandardProfile=marketplace==="FR"||marketplace==="ES"||
    (marketplace==="DE"&&pt==="SWEATSHIRT"&&merchantSize.value?.size_class==="alpha");
  const regularFit=(marketplace==="IT"||(usesStandardProfile&&kwayStandardAdultSize(p,sku,marketplace)))&&
    ["COAT","SHIRT","SWEATER","SWEATSHIRT"].includes(pt)&&
    (sku.startsWith("RFR_")||sku.startsWith("KWAY_")||ecoMakaAdultStandard||
      (sku.startsWith("COL_")&&p.vendor==="Colmar Originals"&&
       ((merchantSize.value?.size_class==="numeric"&&pt==="COAT")||
        (merchantSize.value?.size_class==="alpha"&&
         ["SWEATER","SWEATSHIRT","SHIRT"].includes(pt)))))&&
    merchantSize.attribute===(pt==="SHIRT"?"shirt_size":"apparel_size")&&merchantSize.value&&
    Array.isArray(obj(sizeProps.body_type).enum)&&
    (obj(sizeProps.body_type).enum as string[]).includes("regular")&&
    Array.isArray(obj(sizeProps.height_type).enum)&&
    (obj(sizeProps.height_type).enum as string[]).includes("regular");
  // Amazon's live PTD wire token for merchant IT 48 can be "numeric_48"
  // rather than the display label "48". Use only a uniquely verified exact
  // enum/enumNames pair returned by this marketplace's fresh PTD research.
  // Only Colmar numeric apparel, never global numeric or EU cross-market.
  const numericDisplay=merchantSize.value?.size;
  const numericToken=typeof numericDisplay==="string"?
    obj(obj(research.ptd_numeric_size_label_tokens).apparel_size)[numericDisplay]:
    undefined;
  const mappedColmarNumeric=sku.startsWith("COL_")&&
    p.vendor==="Colmar Originals"&&marketplace==="IT"&&
    merchantSize.attribute==="apparel_size"&&
    merchantSize.value?.size_class==="numeric"&&
    typeof numericDisplay==="string"&&/^[2-6][0-9]$/.test(numericDisplay)&&
    typeof numericToken==="string"&&
    numericToken==="numeric_"+numericDisplay;
  const canonicalSize=mappedColmarNumeric?
    {...merchantSize.value,size:numericToken}:merchantSize.value;
  const mappedSize=regularFit?{...canonicalSize,
    body_type:"regular",height_type:"regular"}:canonicalSize;
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
      research.available_schema_attribute_names as string[],obj(research.ptd_alpha_size_tokens),
      obj(research.ptd_technical_shapes)),
    ...multibrandEvidence,
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
    if(["90004205","90248","99022"].includes(issue.code)&&
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
         !/\b\d{7,}\b/.test(value)&&
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

