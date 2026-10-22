import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints:["src/marketplace-amazon-sneaker-state-classifier.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent",
});
const mod = await import("data:text/javascript;base64,"+Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const classify=mod.classifyAmazonSneakerSkuStates;
const S=[
  ["PUI_602_602_PANTHER_BAMBI_38_EU","8056631944864"],
  ["4B12_PLAYNEW_D2026_38_EU","8057270146725"],
  ["PROKEDS_RC426SLM_LL_WB00006_42","8058757592417"],
  ["BK70_108051-000016_38_EU","8052855362347"],
  ["FSA_TRAIL_SBL_10_VIOLET-LIME_38_EU",null],
];
const markets=["IT","DE","FR","ES"];
const baseRequest={skus:S.map(x=>x[0])};
const id=index=>"gid://shopify/ProductVariant/"+(100+index);
const getSku=key=>S.findIndex(([sku])=>sku===key);
const getEan=key=>S.findIndex(([,ean])=>ean===key);

function catalog(key,barcodeQuery=false,duplicate=false) {
  const i=barcodeQuery?getEan(key):getSku(key);
  assert.ok(i>=0);
  const makeProduct=(variantId,ean=key)=>({
    status:"ACTIVE",product_type:"Sneakers",vendor:"4B12",variants:[{id:variantId,sku:S[i][0],barcode:barcodeQuery?ean:S[i][1]}],
  });
  const p=[makeProduct(id(i))];
  if(duplicate&&barcodeQuery&&i===1) {
    const mode=duplicate===true?"UNLISTED_ZERO":duplicate;
    const stocked=mode==="UNLISTED_STOCK";
    p.push({status:mode==="ACTIVE"?"ACTIVE":"UNLISTED",variants:[{
      id:id(999),sku:"OTHER",barcode:key,
      inventory_quantity:stocked?1:0,
      available_for_sale:mode==="ACTIVE"||stocked||mode==="UNLISTED_AVAILABLE",
      inventory_tracked:mode!=="UNLISTED_UNTRACKED",
    }]});
  }
  return {ok:true,truncated:false,complete_variant_pagination:true,
    product_count:p.length,inline_product_count:p.length,products:p};
}
function shadow(state={}) {
  const results=S.map(([sku],i)=>({
    sku,shopify:{state:"VERIFIED",variant_id:id(i),source_unique_active_sku:true,available:1},
    amazon:Object.fromEntries(markets.map(m=>[m,
      (state[sku] || (i===0?"PRESENT":i===3?"UNKNOWN":"VERIFIED_ABSENT"))==="PRESENT"
        ?{state:"PRESENT",identity_state:"VERIFIED",asin:"B0HMPG6KM8",statuses:["BUYABLE"]}
        :{state:state[sku] || (i===3?"UNKNOWN":"VERIFIED_ABSENT"),identity_state:"UNKNOWN",asin:null,statuses:[]}
    ])),
  }));
  return {ok:true,results,read_only:true,provider_mutations:0,can_publish:false};
}
function deps(opts={}) {
  const calls=[];
  return {
    calls,
    readShadow:async request=>{
      calls.push(["shadow",request.skus.length]);
      return opts.shadowResult || shadow();
    },
    readShopify:async request=>{
      assert.equal(request.persist_artifacts,false);
      assert.equal(request.max_products,50);
      calls.push(["shopify",request.query]);
      const e=/^barcode:"([^"]+)"/.exec(request.query);
      const s=/^sku:"([^"]+)"/.exec(request.query);
      if(e) return catalog(e[1],true,opts.duplicate);
      if(s) return catalog(s[1],false,false);
      throw Error("Unrecognized Shopify request");
    },
    readMatch:async request=>{
      assert.deepEqual([...request.identifiers].sort(),S.slice(0,4).map(x=>x[1]).sort());
      calls.push(["amazon",request.marketplace]);
      return {ok:true,read_only:true,has_created_offer:false,result:{
        complete:opts.incompleteMarket!==request.marketplace,marketplace:request.marketplace,
        identifiers:request.identifiers.map(ean=>({
          ean,
          state:ean===S[0][1]||ean===S[1][1]?"EXACT_ONE":"NO_EXACT_MATCH",
          exact_match_count:ean===S[0][1]||ean===S[1][1]?1:0,
          asins:ean===S[0][1]?["B0HMPG6KM8"]:ean===S[1][1]?["B012345678"]:[],
        })),
      }};
    },
    clock:()=>Date.parse("2026-10-19T14:00:00Z"),
  };
}
const d=deps();
const result=await classify(baseRequest,{},d);
assert.equal(result.ok,true);
assert.equal(result.read_only,true);
assert.equal(result.provider_mutations,0);
assert.equal(result.can_publish,false);
assert.equal(result.creates_asins,false);
assert.equal(result.results.length,5);
for(const m of markets){
  assert.equal(result.results[0].markets[m].status,"SELLER_BUYABLE");
  assert.equal(result.results[1].markets[m].status,"EXISTING_ASIN_CANDIDATE");
  assert.equal(result.results[1].markets[m].catalog_candidate_asin,"B012345678");
  assert.equal(result.results[1].markets[m].is_publish_eligible,false);
  assert.equal(result.results[2].markets[m].status,"NEW_ASIN_RESEARCH_REQUIRED");
  assert.equal(result.results[3].markets[m].status,"RECHECK_REQUIRED");
  assert.equal(result.results[4].markets[m].status,"SHOPIFY_EAN_BLOCKED");
}
assert.equal(d.calls.filter(x=>x[0]==="amazon").length,4);
assert.equal(d.calls.filter(x=>x[0]==="shopify").length,9);

// Regression from live 22 Oct: 4B12 U-1035 size 42 has EAN in Shopify,
// but available=0. An out-of-stock variant is not an invalid/missing GTIN.
const zeroStockShadow=shadow();
zeroStockShadow.results[1].shopify.available=0;
const zeroDeps=deps({shadowResult:zeroStockShadow});
zeroDeps.readMatch=async request=>{
  assert.equal(request.identifiers.includes(S[1][1]),false,
    "No Amazon EAN lookup should run for an out-of-stock SKU");
  return {ok:true,read_only:true,has_created_offer:false,result:{
    complete:true,marketplace:request.marketplace,
    identifiers:request.identifiers.map(ean=>({
      ean,state:ean===S[0][1]?"EXACT_ONE":"NO_EXACT_MATCH",
      exact_match_count:ean===S[0][1]?1:0,
      asins:ean===S[0][1]?["B0HMPG6KM8"]:[],
    }))
  }};
};
const zeroResult=await classify(baseRequest,{},zeroDeps);
assert.equal(zeroResult.ok,true);
assert.equal(zeroResult.results[1].blocker,"shopify_available_zero");
assert.equal(zeroResult.results[1].ean_not_checked_due_to_zero_stock,true);
assert.equal(zeroResult.results[1].shopify_available,0);
for(const m of markets){
 assert.equal(zeroResult.results[1].markets[m].status,"SHOPIFY_OUT_OF_STOCK");
 assert.equal(zeroResult.results[1].markets[m].is_publish_eligible,false);
 assert.equal(zeroResult.counts[m].SHOPIFY_OUT_OF_STOCK,1);
}
assert.equal(zeroDeps.calls.some(([k,v])=>k==="shopify"&&v.includes(S[1][0])),false,
  "Do not make redundant Shopify Admin SKU/EAN reads for zero-stock variant");
assert.equal(zeroResult.provider_mutations,0);

const missing=deps({incompleteMarket:"ES"});
const missingResult=await classify(baseRequest,{},missing);
assert.equal(missingResult.results[1].markets.ES.status,"RECHECK_REQUIRED");
assert.equal(missingResult.results[0].markets.ES.status,"SELLER_BUYABLE");
assert.equal(missingResult.results[1].markets.IT.status,"EXISTING_ASIN_CANDIDATE");

// Historical unlisted, tracked and unavailable variants with confirmed zero
// stock may keep their EAN without blocking an ACTIVE SKU. No Shopify writes.
const retired=deps({duplicate:true});
const retiredResult=await classify(baseRequest,{},retired);
for(const m of markets){
  assert.equal(retiredResult.results[1].markets[m].status,"EXISTING_ASIN_CANDIDATE");
  assert.equal(retiredResult.results[1].markets[m].is_publish_eligible,false);
}
assert.equal(retiredResult.results[1].blocker,null);
assert.equal(retiredResult.provider_mutations,0);

// Fail closed for any still-sellable, stocked, untracked or unavailable-state-
// inconsistent second identity, even when the product status is UNLISTED.
for (const duplicate of ["ACTIVE","UNLISTED_STOCK","UNLISTED_AVAILABLE","UNLISTED_UNTRACKED"]) {
  const dresult=await classify(baseRequest,{},deps({duplicate}));
  for(const m of markets)assert.equal(dresult.results[1].markets[m].status,"SHOPIFY_EAN_BLOCKED");
  assert.equal(dresult.results[1].blocker,"shopify_ean_duplicated_or_incomplete");
}

const blocked=await classify(baseRequest,{},deps({shadowResult:{ok:true,results:[],read_only:true,provider_mutations:0,can_publish:false}}));
assert.equal(blocked.status,"BLOCKED_SHADOW");
await assert.rejects(()=>classify({skus:[S[0][0],S[0][0]]},{},deps()),/invalid_request/);
await assert.rejects(()=>classify({skus:[S[0][0]],publish:true},{},deps()),/invalid_request/);
await assert.rejects(()=>classify({skus:[]},{},deps()),/invalid_request/);
const fs=await import("node:fs/promises");
const source=await fs.readFile("src/marketplace-amazon-sneaker-state-classifier.ts","utf8");
assert.equal(/method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/.test(source),false);
console.log("Amazon read-only sneaker SKU/EAN/ASIN classifier tests passed.");
