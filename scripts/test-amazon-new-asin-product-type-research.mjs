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
      assert.equal(u.searchParams.get("itemName"),"Cappello A Pescatora Buffalo");
      assert.equal(u.searchParams.get("marketplaceIds"),MARKET_ID);
      data={productTypes:[
        {name:"HAT",displayName:"Hat",marketplaceIds:[MARKET_ID]},
        {name:"SHOES",displayName:"Shoes",marketplaceIds:[MARKET_ID]},
      ]};
    }else if(u.pathname==="/definitions/2020-09-01/productTypes/HAT"){
      assert.equal(u.searchParams.get("requirements"),"LISTING");
      assert.equal(u.searchParams.get("requirementsEnforced"),"ENFORCED");
      assert.equal(u.searchParams.get("parentageLevel"),"NONE");
      assert.equal(u.searchParams.get("sellerId"),"A1234567891234");
      data={
        productType:"HAT",requirements:"LISTING",requirementsEnforced:"ENFORCED",
        marketplaceIds:[MARKET_ID],
        schema:{link:{resource:options.evilUrl||"https://valid-schema.s3.eu-west-1.amazonaws.com/ptd.json?signature=mock",verb:"GET"},checksum:"abcd1234"},
        productTypeVersion:{version:"2026.10",latest:true},
      };
    }else if(u.hostname==="valid-schema.s3.eu-west-1.amazonaws.com"){
      assert.equal(Object.hasOwn(init.headers,"x-amz-access-token"),false);
      data=schema;
    }else throw new Error("Unexpected request: "+url);
    return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json"}});
  };
}
function deps(events=[], overrides={}) {
  return {
    clock:()=>fixed,
    readShopify:async args=>{
      assert.equal(args.persist_artifacts,false);
      assert.equal(args.max_products,50);
      assert.ok(args.query.includes('sku:"'+SKU+'"'));
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
assert.equal(/VALIDATION_PREVIEW/.test(source),false);
console.log("Amazon new-ASIN PTD read-only research tests passed.");
