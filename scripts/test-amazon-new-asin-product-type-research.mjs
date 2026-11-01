import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["src/marketplace-amazon-new-asin-research.ts"],
  bundle: true, format: "esm", platform: "neutral",
  write: false, logLevel: "silent",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const research = mod.researchAmazonNewAsinProductType;
const SKU = "GOB_105-0216 RED_Taglia unica";
const EAN = "7427277372563";
const MARKET_ID = "APJ6JRA9NG5V4";
const req = {marketplace:"IT",sku:SKU};
const env = {AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const fixed = Date.parse("2026-10-19T13:00:00.000Z");

function shopify(overrides = {}) {
  return {
    ok:true, truncated:false, complete_variant_pagination:true,
    inline_product_count:1,product_count:1,
    products:[{
      title:"Cappello A Pescatora Buffalo",
      status:"ACTIVE",vendor:"Goorin Bros.",
      product_type:"Cappelli e berretti",media_count:4,
      variants:[{
        sku:SKU,barcode:EAN,
        inventory_quantity:3,inventory_tracked:true,
        inventory_levels_complete:true,
        id:"gid://shopify/ProductVariant/52513605583189",price:"24.95",
      }],
    }],
    ...overrides,
  };
}
function listing(state = "VERIFIED_ABSENT") {
  return {ok:true,marketplace:"IT",provider_mutations:0,can_change_stock:false,results:[{sku:SKU,state}]};
}
function match(state = "NO_EXACT_MATCH") {
  const noMatch=state==="NO_EXACT_MATCH";
  return {ok:true,result:{
    marketplace:"IT",complete:true,identifiers:[
      {ean:EAN,state,exact_match_count:noMatch?0:1,asins:noMatch?[]:["B012345678"]},
    ],
  }};
}
const schema={
  type:"object", properties:{
    attributes:{type:"object",
      properties:{item_name:{type:"array"},brand:{type:"array"},externally_assigned_product_identifier:{type:"array"},
        material:{type:"array"},manufacturer:{type:"array"},
        department:{type:"array",items:{type:"object",properties:{
          value:{type:"string",enum:["mens","womens"]}},required:["value"]}},
        fabric_type:{type:"array",items:{type:"object",properties:{
          material:{type:"string"}}}},
        headwear_size:{type:"array",items:{type:"object",properties:{
          size:{type:"object",properties:{value:{type:"string",enum:["One Size","M","L"]}}},
          size_class:{type:"string",enum:["alpha","numeric"]}},
          required:["size"]}},
        footwear_size:{type:"array",items:{type:"object",properties:{
          size:{type:"string"},size_system:{type:"string",enum:["eu"]},
          size_class:{type:"string",enum:["numeric"]},
          marketplace_id:{type:"string"}},
          required:["size","size_system","size_class"]}}},
      required:["item_name","brand","material","manufacturer"],
    },
  },
  allOf:[{if:{properties:{attributes:{properties:{material:{}}}}},then:{properties:{attributes:{required:["manufacturer"]}}}}],
};
function fakeFetch(events, options={}) {
  return async (url, init) => {
    assert.equal(init.method,"GET");
    assert.equal(init.redirect,"manual");
    assert.ok(init.signal);
    const u=new URL(url);
    events.push({url:u.toString(),auth:Object.hasOwn(init.headers,"x-amz-access-token")});
    let data;
    if(u.pathname==="/definitions/2020-09-01/productTypes"){
      assert.equal(u.searchParams.get("marketplaceIds"),MARKET_ID);
      if(options.refrigiwearCoat){
        if(u.searchParams.has("keywords")){
          assert.equal(u.searchParams.get("keywords"),"coat");
          assert.equal(u.searchParams.get("itemName"),null);
          data={productTypes:[{name:options.noCoatKeyword?"BLANKET":"COAT",
            displayName:"Type",marketplaceIds:[MARKET_ID]}]};
        }else{
          assert.equal(u.searchParams.get("itemName"),"Speed Jacket Black");
          data={productTypes:[{name:"BLANKET",displayName:"Wrong type",
            marketplaceIds:[MARKET_ID]}]};
        }
      }else if(options.socksProduct && u.searchParams.has("keywords")){
        assert.equal(u.searchParams.get("keywords"),"socks");
        assert.equal(u.searchParams.get("searchLocale"),"en_US");
        assert.equal(u.searchParams.get("itemName"),null);
        data={productTypes:options.noSockKeyword?
          [{name:"PANTS",displayName:"Pants",marketplaceIds:[MARKET_ID]}]:
          [{name:"SOCKS",displayName:"Socks",marketplaceIds:[MARKET_ID]}]};
      }else if(options.sneakersFallback){
        if(u.searchParams.has("keywords")){
          assert.equal(u.searchParams.get("itemName"),null);
          assert.equal(u.searchParams.get("keywords"),"shoes");
          assert.equal(u.searchParams.get("searchLocale"),"en_US");
          data={productTypes: options.noShoeKeyword
            ? [{name:"SPEAKERS",displayName:"Speakers",marketplaceIds:[MARKET_ID]}]
            : [{name:"SHOES",displayName:"Shoes",marketplaceIds:[MARKET_ID]},
               {name:"DRINK_FLAVORED",displayName:"Drink",marketplaceIds:[MARKET_ID]}]};
        }else{
          assert.equal(u.searchParams.get("itemName"),"PlayNew D-2026 White/Bordeaux");
          data={productTypes:[{name:"SPEAKERS",displayName:"Speakers",marketplaceIds:[MARKET_ID]}]};
        }
      }else{
        assert.equal(u.searchParams.get("itemName"),options.socksProduct?
          "Calza Lunga Uomo Jacquard Zig Zag Con Cashmere Espresso":
          options.bootProduct?"Stivale test EU":"Cappello A Pescatora Buffalo");
        data=options.socksProduct?{productTypes:[
          {name:options.socksRecommendedType||"PANTS",displayName:"Wrong category",marketplaceIds:[MARKET_ID]},
        ]}:{productTypes:options.bootProduct?[
          {name:"BOOT",displayName:"Boot",marketplaceIds:[MARKET_ID]},
        ]:[
          {name:"HAT",displayName:"Hat",marketplaceIds:[MARKET_ID]},
          {name:"SHOES",displayName:"Shoes",marketplaceIds:[MARKET_ID]},
        ]};
      }
    }else if(u.pathname==="/definitions/2020-09-01/productTypes/HAT" ||
      (options.bootProduct && u.pathname==="/definitions/2020-09-01/productTypes/BOOT") ||
      (options.sneakersFallback && u.pathname==="/definitions/2020-09-01/productTypes/SHOES") ||
      (options.refrigiwearCoat && u.pathname==="/definitions/2020-09-01/productTypes/COAT")){
      assert.equal(u.searchParams.get("requirements"),"LISTING");
      assert.equal(u.searchParams.get("requirementsEnforced"),"ENFORCED");
      assert.equal(u.searchParams.get("parentageLevel"),"NONE");
      assert.equal(u.searchParams.get("sellerId"),"A1234567891234");
      data={
        productType:u.pathname.split("/").at(-1),requirements:"LISTING",requirementsEnforced:"ENFORCED",
        marketplaceIds:[MARKET_ID],
        schema:{link:{resource:options.evilUrl||"https://valid-schema.s3.eu-west-1.amazonaws.com/ptd.json?signature=mock",verb:"GET"},checksum:"abcd1234"},
        productTypeVersion:{version:"2026.10",latest:true},
      };
    }else if(u.hostname==="valid-schema.s3.eu-west-1.amazonaws.com"){
      assert.equal(Object.hasOwn(init.headers,"x-amz-access-token"),false);
      data=options.rootSchema ? {
        type:"object",
        required:["brand","country_of_origin","item_name"],
        properties:{brand:{type:"array"},country_of_origin:{type:"array"},
          item_name:{type:"array"},material:{type:"array"}},
        allOf:[{if:{properties:{material:{}}},then:{required:["material"]}}],
      } : schema;
    }else throw new Error("Unexpected request: "+url);
    const schemaGet = u.hostname === "valid-schema.s3.eu-west-1.amazonaws.com";
    return new Response(schemaGet && options.schemaRaw !== undefined ? options.schemaRaw : JSON.stringify(data),{
      status:schemaGet ? (options.schemaStatus || 200) : 200,
      headers:{"content-type":schemaGet ? (options.schemaMime ?? "application/json") : "application/json"},
    });
  };
}
function deps(events=[], overrides={}) {
  return {
    clock:()=>fixed,
    readShopify:async args=>{
      assert.equal(args.persist_artifacts,false);
      assert.equal(args.max_products,50);
      assert.ok(args.query.includes('sku:"'+SKU+'"') ||
        args.query.includes('barcode:"'+EAN+'"'));
      return shopify();
    },
    readListing:async()=>listing(),
    readCatalogMatch:async()=>match(),
    getAccessToken:async()=>"mock-access-token",
    fetch:fakeFetch(events),
    ...overrides,
  };
}
const events=[];
const discovered=await research(req,env,deps(events));
assert.equal(discovered.ok,true);
assert.equal(discovered.status,"PRODUCT_TYPE_SELECTION_REQUIRED");
assert.equal(discovered.candidate_count,2);
assert.deepEqual(discovered.product_type_candidates.map(x=>x.name),["HAT","SHOES"]);
assert.equal(discovered.provider_mutations,0);
assert.equal(discovered.read_only,true);
assert.equal(discovered.can_publish,false);
assert.equal(discovered.ean_absence_not_catalog_absence_proof,true);
assert.equal(events.length,1);
const schemaEvents=[];
const details=await research({...req,product_type:"HAT"},env,deps(schemaEvents));
assert.equal(details.ok,true);
assert.equal(details.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(details.attribute_gap_report.report_status,"GAPS_REQUIRE_REVIEW");
assert.equal(details.attribute_gap_report.product_type,"HAT");
assert.deepEqual(details.attribute_gap_report.required_status_counts,{SOURCE_VERIFIED:2,MISSING:2});
assert.deepEqual(details.attribute_gap_report.attributes.filter(x=>x.status==="MISSING").map(x=>x.attribute),["manufacturer","material"]);
assert.equal(details.attribute_gap_report.conditional_requirements[0].status,"CONDITIONAL_UNRESOLVED");
assert.equal(details.attribute_gap_report.ready_for_validation_preview,false);
assert.equal(details.attribute_gap_report.ready_for_publication,false);
assert.deepEqual(details.required_attribute_names,["brand","item_name","manufacturer","material"]);
assert.equal(details.conditional_requirements_detected,true);
assert.equal(details.parentage_level,"NONE");
assert.equal(details.schema_enforced,true);
assert.equal(details.schema_checksum_verified,false);
assert.equal(details.full_schema_validated,false);
assert.equal(details.ptd_size_shapes_are_read_only,true);
assert.equal(details.ptd_size_shapes_not_schema_validation,true);
assert.equal(details.ptd_size_mapping_not_performed,true);
assert.equal(details.ptd_size_shapes.headwear_size.type,"array");
assert.deepEqual(details.ptd_size_shapes.headwear_size.items.properties.size.properties.value.enum,["One Size","M","L"]);
assert.equal(details.ptd_size_shapes.manufacturer,undefined);
assert.equal(details.ptd_technical_shapes_read_only,true);
assert.equal(details.ptd_technical_shapes_no_values_supplied,true);
assert.deepEqual(details.ptd_technical_shapes.department.items.properties.value.enum,["mens","womens"]);
assert.equal(details.ptd_technical_shapes.fabric_type.items.properties.material.type,"string");
assert.equal(details.ptd_technical_shapes.manufacturer.type,"array");
assert.equal(details.ptd_technical_shapes.headwear_size,undefined);
assert.equal(JSON.stringify(details.ptd_technical_shapes).includes("signature="),false);
assert.equal(JSON.stringify(details.ptd_size_shapes).includes("signature="),false);
const bootEvents=[];
const boot=await research({...req,product_type:"BOOT"},env,deps(bootEvents,{
  readShopify:async args=>{
    assert.equal(args.persist_artifacts,false);
    const p=shopify();
    p.products[0].title="Stivale test EU";
    p.products[0].product_type="Stivaletti e stivali";
    return p;
  },
  fetch:fakeFetch(bootEvents,{bootProduct:true}),
}));
assert.equal(boot.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(boot.ptd_size_shapes_are_read_only,true);
assert.equal(boot.ptd_size_mapping_not_performed,true);
assert.deepEqual(boot.ptd_size_shapes.footwear_size.items.required,
  ["size","size_system","size_class"]);
assert.deepEqual(boot.ptd_size_shapes.footwear_size.items.properties.size_system.enum,["eu"]);
assert.equal(boot.can_publish,false);
assert.equal(boot.provider_mutations,0);
assert.equal(bootEvents.length,3);

assert.equal(details.provider_mutations,0);
assert.equal(details.validation_preview_sent,false);
assert.equal(schemaEvents.length,3);
assert.deepEqual(schemaEvents.map(x=>x.auth),[true,true,false]);
assert.equal(JSON.stringify(details).includes("signature=mock"),false);

// Wrong item-name taxonomy requires a second, positive PTD keyword match.
const coatSku="RFR_G05708_XT3792_G06000_S";
function coatDeps(events,noCoatKeyword=false,quantity=3){
  const source=shopify();
  source.products[0].title="Speed Jacket Black";
  source.products[0].vendor="Refrigiwear";
  source.products[0].product_type="Giacche e cappotti";
  source.products[0].variants[0].sku=coatSku;
  source.products[0].variants[0].inventory_quantity=quantity;
  return deps(events,{
    readShopify:async()=>source,
    readListing:async()=>({ok:true,marketplace:"IT",provider_mutations:0,can_change_stock:false,results:[{
      sku:coatSku,state:"VERIFIED_ABSENT"}]}),
    fetch:fakeFetch(events,{refrigiwearCoat:true,noCoatKeyword}),
  });
}
const coatEvents=[];
const coatResult=await research({marketplace:"IT",sku:coatSku,product_type:"COAT"},
  env,coatDeps(coatEvents));
assert.equal(coatResult.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(coatResult.product_type_discovery_source,"AMAZON_KEYWORDS_REFRIGIWEAR_COAT");
assert.equal(coatEvents.length,4);
assert.deepEqual(coatEvents.map(x=>x.auth),[true,true,true,false]);
const zeroCoat=await research({marketplace:"IT",sku:coatSku,product_type:"COAT"},
  env,coatDeps([],false,0));
assert.equal(zeroCoat.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(zeroCoat.shopify.shopify_available,0);
const negativeCoat=await research({marketplace:"IT",sku:coatSku,product_type:"COAT"},
  env,coatDeps([],false,-1));
assert.equal(negativeCoat.status,"BLOCKED_SHOPIFY");
const genericZero=shopify();
genericZero.products[0].variants[0].inventory_quantity=0;
const otherBrandZero=await research(req,env,deps([],{
  readShopify:async()=>genericZero}));
assert.equal(otherBrandZero.status,"BLOCKED_SHOPIFY");
const badCoat=await research({marketplace:"IT",sku:coatSku,product_type:"COAT"},
  env,coatDeps([],true));
assert.equal(badCoat.status,"BLOCKED_DEFINITIONS");
assert.equal(badCoat.blocker,"refrigiwear_coat_keyword_not_recommended");

// A real 12-digit UPC-A is read as UPC, never padded or relabeled as EAN.
const upc="195029073057",upcEvents=[];
const upcSource=shopify();
upcSource.products[0].variants[0].barcode=upc;
const upcMatch={ok:true,result:{marketplace:"IT",complete:true,
  identifiers:[{upc,state:"NO_EXACT_MATCH",exact_match_count:0,asins:[]}]}};
const upcResult=await research(req,env,deps(upcEvents,{
  readShopify:async args=>{
    assert.equal(args.persist_artifacts,false);
    assert.ok(args.query.includes('sku:"'+SKU+'"')||args.query.includes('barcode:"'+upc+'"'));
    return upcSource;
  },
  readCatalogMatch:async args=>{
    assert.deepEqual(args,{marketplace:"IT",identifier_type:"UPC",identifiers:[upc]});
    return upcMatch;
  },
}));
assert.equal(upcResult.ok,true);
assert.equal(upcResult.status,"PRODUCT_TYPE_SELECTION_REQUIRED");
assert.equal(upcResult.shopify.ean,null);
assert.equal(upcResult.shopify.upc,upc);
assert.equal(upcResult.shopify.identifier_type,"UPC");
assert.equal(upcResult.upc_match_state,"NO_EXACT_MATCH");
assert.equal(upcResult.ean_match_state,undefined);
assert.equal(upcResult.can_publish,false);
const brokenUpc=shopify();
brokenUpc.products[0].variants[0].barcode="195029073050";
let matchCalls=0;
const invalidUpc=await research(req,env,deps([],{
  readShopify:async()=>brokenUpc,
  readCatalogMatch:async()=>{matchCalls++;throw Error("must not call");},
}));
assert.equal(invalidUpc.status,"BLOCKED_SHOPIFY");
assert.equal(matchCalls,0);

const s3MimeEvents=[];
const s3MimeResult=await research({...req,product_type:"HAT"},env,deps(s3MimeEvents,{
  fetch:fakeFetch(s3MimeEvents,{schemaMime:"application/octet-stream"}),
}));
assert.equal(s3MimeResult.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(s3MimeResult.provider_mutations,0);
assert.equal(s3MimeEvents.length,3);

const unusualS3MimeEvents=[];
const unusualS3Mime=await research({...req,product_type:"HAT"},env,deps(unusualS3MimeEvents,{
  fetch:fakeFetch(unusualS3MimeEvents,{schemaMime:"application/x-amz-json"}),
}));
assert.equal(unusualS3Mime.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(unusualS3Mime.provider_mutations,0);

const invalidS3JsonEvents=[];
const invalidS3Json=await research({...req,product_type:"HAT"},env,deps(invalidS3JsonEvents,{
  fetch:fakeFetch(invalidS3JsonEvents,{schemaMime:"application/x-amz-json",schemaRaw:"<html>not a schema</html>"}),
}));
assert.equal(invalidS3Json.status,"BLOCKED_DEFINITIONS");
assert.equal(invalidS3Json.schema_download_diagnostic,"provider_invalid_json");
assert.equal(invalidS3Json.provider_mutations,0);

const s3DeniedEvents=[];
const s3Denied=await research({...req,product_type:"HAT"},env,deps(s3DeniedEvents,{
  fetch:fakeFetch(s3DeniedEvents,{schemaStatus:403}),
}));
assert.equal(s3Denied.status,"BLOCKED_DEFINITIONS");
assert.equal(s3Denied.blocker,"product_type_schema_unavailable");
assert.equal(s3Denied.schema_download_diagnostic,"provider_http_403");
assert.equal(JSON.stringify(s3Denied).includes("signature=mock"),false);
assert.equal(s3DeniedEvents.length,3);

const rootSchemaEvents=[];
const rootSchemaResult=await research({...req,product_type:"HAT"},env,deps(rootSchemaEvents,{
  fetch:fakeFetch(rootSchemaEvents,{rootSchema:true,schemaMime:"application/x-amz-json"}),
}));
assert.equal(rootSchemaResult.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.deepEqual(rootSchemaResult.required_attribute_names,["brand","country_of_origin","item_name"]);
assert.equal(rootSchemaResult.schema_attribute_structure,"TOP_LEVEL_ATTRIBUTES");
assert.equal(rootSchemaResult.static_required_set_declared,true);
assert.equal(rootSchemaResult.schema_attribute_count,4);
assert.equal(rootSchemaResult.conditional_requirements_detected,true);
assert.equal(rootSchemaResult.full_schema_validated,false);
assert.equal(rootSchemaResult.provider_mutations,0);
assert.deepEqual(rootSchemaResult.ptd_size_shapes,{});
assert.equal(rootSchemaResult.ptd_size_mapping_not_performed,true);
assert.equal(rootSchemaEvents.length,3);

// Live regression: Amazon item-name PTD has called PlayNew a SPEAKERS product.
// Shopify Sneakers activates a strictly read-only keyword recheck; unrelated
// title matches can never be selected as valid footwear product types.
function sneakerDeps(events, opts={}) {
  return deps(events,{
    readShopify:async args=>{
      assert.equal(args.persist_artifacts,false);
      assert.ok(args.query.includes('sku:"'+SKU+'"') ||
        args.query.includes('barcode:"'+EAN+'"'));
      const catalog=shopify();
      catalog.products[0].product_type="Sneakers";
      catalog.products[0].title="PlayNew D-2026 White/Bordeaux";
      return catalog;
    },
    fetch:fakeFetch(events,{sneakersFallback:true,...opts}),
  });
}
const sneakerEvents=[];
const sneakerDiscovery=await research(req,env,sneakerDeps(sneakerEvents));
assert.equal(sneakerDiscovery.status,"PRODUCT_TYPE_SELECTION_REQUIRED");
assert.deepEqual(sneakerDiscovery.product_type_candidates.map(x=>x.name),["SHOES"]);
assert.equal(sneakerDiscovery.product_type_discovery_source,"AMAZON_KEYWORDS_SHOPIFY_SNEAKERS");
assert.equal(sneakerDiscovery.title_category_conflict_detected,true);
assert.equal(sneakerDiscovery.can_publish,false);
assert.equal(sneakerDiscovery.provider_mutations,0);
assert.equal(sneakerEvents.length,2);
assert.ok(sneakerEvents.every(x=>x.auth));
const sneakerSchemaEvents=[];
const sneakerSchema=await research({...req,product_type:"SHOES"},env,sneakerDeps(sneakerSchemaEvents));
assert.equal(sneakerSchema.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(sneakerSchema.attribute_gap_report.report_status,"GAPS_REQUIRE_REVIEW");
assert.equal(sneakerSchema.ptd_shapes_are_read_only,true);
assert.equal(sneakerSchema.ptd_shapes_are_not_schema_validation,true);
assert.equal(typeof sneakerSchema.ptd_attribute_shapes,"object");
assert.equal(sneakerSchema.ptd_attribute_shapes.item_name,undefined);
assert.equal(sneakerSchema.ptd_attribute_shapes.manufacturer.type,"array");
assert.equal(JSON.stringify(sneakerSchema).includes("signature=mock"),false);
assert.equal(details.ptd_attribute_shapes,undefined,"Non-sneaker PTD must not expose SHOES shapes");
assert.equal(sneakerSchema.attribute_gap_report.product_type,"SHOES");
assert.equal(sneakerSchema.attribute_gap_report.required_attribute_count,4);
assert.equal(sneakerSchema.attribute_gap_report.required_status_counts.SOURCE_VERIFIED,2);
assert.equal(sneakerSchema.attribute_gap_report.required_status_counts.MISSING,2);
assert.equal(sneakerSchema.attribute_gap_report.conditional_requirements[0].status,"CONDITIONAL_UNRESOLVED");
assert.equal(sneakerSchema.attribute_gap_report.ready_for_validation_preview,false);
assert.equal(sneakerSchema.attribute_gap_report.ready_for_publication,false);
assert.equal(sneakerSchema.attribute_gap_report.provider_mutations,0);

assert.equal(sneakerSchema.product_type,"SHOES");
assert.equal(sneakerSchema.product_type_discovery_source,"AMAZON_KEYWORDS_SHOPIFY_SNEAKERS");
assert.equal(sneakerSchema.full_schema_validated,false);
assert.equal(sneakerSchema.provider_mutations,0);
assert.equal(sneakerSchemaEvents.length,4);
const invalidSneakerType=await research({...req,product_type:"SPEAKERS"},env,sneakerDeps([]));
assert.equal(invalidSneakerType.blocker,"product_type_not_in_marketplace_recommendations");
const sneakerNoFootwear=await research(req,env,sneakerDeps([],{noShoeKeyword:true}));
assert.equal(sneakerNoFootwear.status,"BLOCKED_DEFINITIONS");
assert.equal(sneakerNoFootwear.blocker,"sneakers_footwear_type_not_recommended");
assert.equal(sneakerNoFootwear.provider_mutations,0);

// Regression: Red Sox actual Shopify category Calze must not map to PANTS
// just because Amazon itemName discovery suggests trousers.
const socksEvents=[];
const socksDeps=deps(socksEvents,{
  readShopify:async()=>{
    const x=shopify();x.products[0].product_type="Calze";
    x.products[0].title="Calza Lunga Uomo Jacquard Zig Zag Con Cashmere Espresso";
    return x;
  },
  fetch:fakeFetch(socksEvents,{socksProduct:true}),
});
const socks=await research(req,env,socksDeps);
assert.equal(socks.ok,true);
assert.equal(socks.status,"PRODUCT_TYPE_SELECTION_REQUIRED");
assert.deepEqual(socks.product_type_candidates.map(x=>x.name),["SOCKS"]);
assert.equal(socks.product_type_discovery_source,"AMAZON_KEYWORDS_SHOPIFY_SOCKS");
assert.equal(socks.title_category_conflict_detected,true);
assert.equal(socks.can_publish,false);
assert.equal(socksEvents.length,2);
const sockPants=await research({...req,product_type:"PANTS"},env,socksDeps);
assert.equal(sockPants.ok,false);
assert.equal(sockPants.blocker,"product_type_not_in_marketplace_recommendations");
assert.equal(sockPants.provider_mutations,0);
const sockShoesEvents=[];
const sockShoes=await research(req,env,deps(sockShoesEvents,{
  readShopify:async()=>{
    const p=shopify();
    p.products[0].product_type="Calze";
    p.products[0].title="Calza Lunga Uomo Jacquard Zig Zag Con Cashmere Espresso";
    return p;
  },
  fetch:fakeFetch(sockShoesEvents,{socksProduct:true,socksRecommendedType:"SHOES"}),
}));
assert.equal(sockShoes.status,"PRODUCT_TYPE_SELECTION_REQUIRED");
assert.deepEqual(sockShoes.product_type_candidates.map(x=>x.name),["SOCKS"]);
assert.equal(sockShoes.can_publish,false);
const noSockEvents=[];
const noSock=await research(req,env,deps(noSockEvents,{
  readShopify:async()=>{
    const p=shopify();p.products[0].product_type="Calze";
    p.products[0].title="Calza Lunga Uomo Jacquard Zig Zag Con Cashmere Espresso";
    return p;
  },
  fetch:fakeFetch(noSockEvents,{socksProduct:true,noSockKeyword:true}),
}));
assert.equal(noSock.status,"BLOCKED_DEFINITIONS");
assert.equal(noSock.blocker,"socks_product_type_not_recommended");
assert.equal(noSock.provider_mutations,0);
const sockDirectEvents=[];
const sockDirect=await research(req,env,deps(sockDirectEvents,{
  readShopify:async()=>{
    const p=shopify();p.products[0].product_type="Calze";
    p.products[0].title="Calza Lunga Uomo Jacquard Zig Zag Con Cashmere Espresso";
    return p;
  },
  fetch:fakeFetch(sockDirectEvents,{socksProduct:true,socksRecommendedType:"SOCKS"}),
}));
assert.equal(sockDirect.status,"PRODUCT_TYPE_SELECTION_REQUIRED");
assert.deepEqual(sockDirect.product_type_candidates.map(x=>x.name),["SOCKS"]);
assert.equal(sockDirect.product_type_discovery_source,"AMAZON_ITEM_NAME_SOCKS");
assert.equal(sockDirectEvents.length,1);

const invalidType=await research({...req,product_type:"BAG"},env,deps());
assert.equal(invalidType.status,"BLOCKED_DEFINITIONS");
assert.equal(invalidType.blocker,"product_type_not_in_marketplace_recommendations");

const matchedEvents=[];
const alreadyMatched=await research(req,env,deps(matchedEvents,{readCatalogMatch:async()=>match("EXACT_ONE")}));
assert.equal(alreadyMatched.status,"BLOCKED_MATCHING");
assert.equal(alreadyMatched.provider_mutations,0);
assert.equal(matchedEvents.length,0);

const existing=await research(req,env,deps([],{readListing:async()=>listing("PRESENT")}));
assert.equal(existing.status,"BLOCKED_AMAZON");

const duplicate=await research(req,env,deps([],{
  readShopify:async()=>({ ...shopify(),product_count:2,inline_product_count:2,products:[shopify().products[0],shopify().products[0]] }),
}));
assert.equal(duplicate.status,"BLOCKED_SHOPIFY");

const duplicateEan=await research(req,env,deps([],{
  readShopify:async args=>{
    if(args.query.startsWith("barcode:")){
      const source=shopify(),other=structuredClone(source.products[0]);
      other.variants[0].sku="OTHER_SKU";
      other.variants[0].id="gid://shopify/ProductVariant/99999";
      return {...source,product_count:2,inline_product_count:2,products:[source.products[0],other]};
    }
    return shopify();
  },
}));
assert.equal(duplicateEan.status,"BLOCKED_SHOPIFY");
assert.equal(duplicateEan.blocker,"ean_missing_or_duplicated_in_shopify");


const KWAY_SKU="KWAY_K2133FW_USY_S",KWAY_EAN="8056072266600";
function kwayDuplicateCatalog(oldStatus="UNLISTED",oldStock=0,oldEan=KWAY_EAN){
  const catalog=shopify(),main=catalog.products[0];
  main.vendor="K-Way";
  main.product_type="Giacche e cappotti";
  main.title="Speed Jacket Black";
  main.variants[0].sku=KWAY_SKU;
  main.variants[0].barcode=KWAY_EAN;
  const old=structuredClone(main);
  old.status=oldStatus;
  old.variants[0].id="gid://shopify/ProductVariant/999991";
  old.variants[0].inventory_quantity=oldStock;
  old.variants[0].barcode=oldEan;
  return {...catalog,product_count:2,inline_product_count:2,products:[main,old]};
}
async function checkKwayDuplicate(oldStatus,oldStock,oldEan=KWAY_EAN,activeStock=3){
  const events=[];
  return research({marketplace:"IT",sku:KWAY_SKU,product_type:"COAT"},env,deps(events,{
    readShopify:async()=>{const c=kwayDuplicateCatalog(oldStatus,oldStock,oldEan);
      c.products[0].variants[0].inventory_quantity=activeStock;return c;},
    readListing:async()=>({ok:true,marketplace:"IT",provider_mutations:0,
      can_change_stock:false,results:[{sku:KWAY_SKU,state:"VERIFIED_ABSENT"}]}),
    readCatalogMatch:async()=>({ok:true,result:{marketplace:"IT",complete:true,
      identifiers:[{ean:KWAY_EAN,state:"NO_EXACT_MATCH",
        exact_match_count:0,asins:[]}]}}),
    fetch:fakeFetch(events,{refrigiwearCoat:true}),
  }));
}
const kwayStale=await checkKwayDuplicate("UNLISTED",0);
assert.equal(kwayStale.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(kwayStale.shopify.ean,KWAY_EAN);
assert.equal(kwayStale.product_type_discovery_source,"AMAZON_KEYWORDS_KWAY_COAT");
const kwayArchived=await checkKwayDuplicate("ARCHIVED",0);
assert.equal(kwayArchived.status,"REQUIREMENTS_REVIEW_REQUIRED");
const kwayZero=await checkKwayDuplicate("UNLISTED",0,KWAY_EAN,0);
assert.equal(kwayZero.status,"REQUIREMENTS_REVIEW_REQUIRED");
assert.equal(kwayZero.shopify.shopify_available,0);
const kwayNegative=await checkKwayDuplicate("UNLISTED",0,KWAY_EAN,-1);
assert.equal(kwayNegative.status,"BLOCKED_SHOPIFY");
for(const [status,quantity,barcode] of [
  ["ACTIVE",0,KWAY_EAN],["UNLISTED",1,KWAY_EAN],
  ["UNLISTED",0,"8056072266594"]]){
  const blockedKway=await checkKwayDuplicate(status,quantity,barcode);
  assert.equal(blockedKway.status,"BLOCKED_SHOPIFY");
}

const missingBarcode=await research(req,env,deps([],{
  readShopify:async()=>{const x=shopify();x.products[0].variants[0].barcode=null;return x;},
}));
assert.equal(missingBarcode.status,"BLOCKED_SHOPIFY");

const schemaEvilEvents=[];
const blockedSchema=await research({...req,product_type:"HAT"},env,deps(schemaEvilEvents,{
  fetch:fakeFetch(schemaEvilEvents,{evilUrl:"https://localhost/api/secrets"}),
}));
assert.equal(blockedSchema.status,"BLOCKED_DEFINITIONS");
assert.equal(blockedSchema.blocker,"product_type_schema_metadata_unverified");
assert.equal(schemaEvilEvents.length,2);

const failedCatalog=await research(req,env,deps([],{
  readCatalogMatch:async()=>({ok:false,result:{complete:false}}),
}));
assert.equal(failedCatalog.status,"BLOCKED_AMAZON");

for(const bad of [{...req,product_type:"../../secret"},{...req,extra:true},{...req,marketplace:"US"}]){
 await assert.rejects(()=>research(bad,env,deps()),/amazon_new_asin_invalid_request/);
}
const source=await (await import("node:fs/promises")).readFile("src/marketplace-amazon-new-asin-research.ts","utf8");
assert.equal(/method:\s*["'](?:PUT|POST|PATCH|DELETE)["']/.test(source),false);
assert.equal(/searchParams\.set\(["\x27]mode["\x27],\s*["\x27]VALIDATION_PREVIEW/.test(source),false);
console.log("Amazon new-ASIN PTD read-only research tests passed.");
