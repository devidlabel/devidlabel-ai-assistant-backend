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
        material:{type:"array"},manufacturer:{type:"array"}},
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
      if(options.sneakersFallback){
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
        assert.equal(u.searchParams.get("itemName"),"Cappello A Pescatora Buffalo");
        data={productTypes:[
          {name:"HAT",displayName:"Hat",marketplaceIds:[MARKET_ID]},
          {name:"SHOES",displayName:"Shoes",marketplaceIds:[MARKET_ID]},
        ]};
      }
    }else if(u.pathname==="/definitions/2020-09-01/productTypes/HAT" ||
      (options.sneakersFallback && u.pathname==="/definitions/2020-09-01/productTypes/SHOES")){
      assert.equal(u.searchParams.get("requirements"),"LISTING");
      assert.equal(u.searchParams.get("requirementsEnforced"),"ENFORCED");
      assert.equal(u.searchParams.get("parentageLevel"),"NONE");
      assert.equal(u.searchParams.get("sellerId"),"A1234567891234");
      data={
        productType:u.pathname.endsWith("/SHOES")?"SHOES":"HAT",requirements:"LISTING",requirementsEnforced:"ENFORCED",
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
assert.equal(details.attribute_gap_report,undefined,"Non-SHOES schemas must not inherit the footwear gap report");
assert.deepEqual(details.required_attribute_names,["brand","item_name","manufacturer","material"]);
assert.equal(details.conditional_requirements_detected,true);
assert.equal(details.parentage_level,"NONE");
assert.equal(details.schema_enforced,true);
assert.equal(details.schema_checksum_verified,false);
assert.equal(details.full_schema_validated,false);
assert.equal(details.provider_mutations,0);
assert.equal(details.validation_preview_sent,false);
assert.equal(schemaEvents.length,3);
assert.deepEqual(schemaEvents.map(x=>x.auth),[true,true,false]);
assert.equal(JSON.stringify(details).includes("signature=mock"),false);

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
