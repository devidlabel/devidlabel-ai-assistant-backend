import assert from "node:assert/strict";
import {build} from "esbuild";
const compiled=await build({entryPoints:["src/mare-business-amazon-it-season-audit.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {readAmazonItSeasonalStockAudit:read}=await import(
 "data:text/javascript;base64,"+Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const target="gid://shopify/Metaobject/421462409557";
const ids=["SPR_910B9351NSZ","MC2_ALI0026_00192M","MC2_JUDE002 00311E_Taglia unica","KWAY_K8116XW WMR","SPR_910B8666NSZ"];
const seasonBy={
 [ids[0]]:target,[ids[1]]:target,[ids[2]]:"gid://shopify/Metaobject/299394662741",
 [ids[3]]:target,[ids[4]]:target
};
const brandBy={ [ids[0]]:"Sprayground",[ids[1]]:"MC2 Saint Barth",
 [ids[2]]:"MC2 Saint Barth",[ids[3]]:"K-Way",[ids[4]]:"Sprayground"};
const single=(sku)=>({
 productVariants:{nodes:[{sku,inventoryQuantity:sku===ids[2]?1:2,
  product:{id:"gid://shopify/Product/11439776891221",vendor:brandBy[sku],status:"ACTIVE",
   season:{type:"metaobject_reference",value:seasonBy[sku]}}}],
 pageInfo:{hasNextPage:false}}
});
const listing=(sku)=>({
 sku,state:sku===ids[4]?"VERIFIED_ABSENT":"PRESENT",
 identity_state:"VERIFIED",fulfillment_state:"VERIFIED",observation_complete:true,
 current_fbm_quantity:sku===ids[1]?0:3,
 statuses:sku===ids[1]?["DISCOVERABLE"]:["DISCOVERABLE","BUYABLE"]
});
let amazonCalls=0;
const deps={
 readShopify:async(_env,query,vars)=>{
  assert.match(query,/metaobject_reference|season:metafield/);
  const sku=vars.skuQuery.slice(5,-1);assert.ok(ids.includes(sku));
  return single(sku);
 },
 readListings:async(query)=>{
  amazonCalls++;
  assert.equal(query.marketplace,"IT");
  return {ok:true,marketplace:"IT",complete_evidence:true,provider_mutations:0,
   observed_at:"2026-10-23T13:40:00.000Z",results:query.skus.map(listing)};
 }
};
const data=await read({skus:ids},{},deps);
assert.equal(data.ok,true);
assert.equal(data.provider_mutations,0);
assert.equal(data.can_change_inventory,false);
assert.equal(data.seasonal_schedule_verified,false);
assert.equal(amazonCalls,1);
assert.deepEqual(data.findings,{target_positive_buyable:1,target_other:1,target_absent:1,
 insufficient:0,out_of_scope:2});
assert.equal(data.results[0].finding,"TARGET_POSITIVE_BUYABLE_REQUIRES_CHANNABLE_RULE_REVIEW");
assert.equal(data.results[0].amazon_quantity,3);
assert.equal(data.results[1].finding,"TARGET_NOT_CURRENTLY_POSITIVE_BUYABLE");
assert.equal(data.results[2].finding,"OUT_OF_SCOPE");
assert.equal(data.results[3].finding,"OUT_OF_SCOPE");
assert.equal(data.results[4].finding,"SELLER_SKU_VERIFIED_ABSENT_NOT_ZERO");
assert.equal(data.results[4].amazon_quantity,null);
const fail=await read({skus:[ids[0]]},{},{
 ...deps,readShopify:async()=>({
 productVariants:{nodes:single(ids[0]).productVariants.nodes,pageInfo:{hasNextPage:true}}})
});
assert.equal(fail.results[0].finding,"INSUFFICIENT_EVIDENCE");
const failure=await read({skus:[ids[0]]},{},{
 ...deps,readListings:async()=>{throw Error("provider timeout");}
});
assert.equal(failure.ok,false);
assert.equal(failure.reason,"AMAZON_LISTING_READ_FAILED");
const ambiguous=await read({skus:[ids[0]]},{},{
 ...deps,readListings:async(q)=>({ok:true,marketplace:"IT",complete_evidence:true,
 provider_mutations:0,results:[listing(q.skus[0]),listing(q.skus[0])]})
});
assert.equal(ambiguous.ok,false);
assert.equal(ambiguous.safe_for_direct_writer,false);
for(const payload of [{skus:[]},{skus:[ids[0],ids[0]]},{skus:[ids[0]],write:true},
 {skus:["bad!"]},{skus:Array(9).fill("X")}])
 await assert.rejects(()=>read(payload,{},deps),/amazon_it_season_audit_invalid_request/);
console.log("PASS Amazon IT exact metaobject season audit: issue detection, exclusions, unknown and no stock writes");
