import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
const built = await build({entryPoints:["src/mare-business-amazon-price-bounds-repair.ts"],bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {prepareAmazonPriceBoundsRepair:prepare,executeAmazonPriceBoundsRepair:execute} = await import("data:text/javascript;base64," + Buffer.from(built.outputFiles[0].text).toString("base64"));
const markets={IT:"APJ6JRA9NG5V4",DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"};
const env={AMAZON_SP_API_SELLER_ID:"A123456789",AMAZON_OFFER_PREVIEW_ENABLED:"true"};
const item={marketplace:"IT",sku:"MC2_TEST_001_S",asin:"B0TEST0001",ean:"8057338520504"};
const request={items:[item]};
const json=x=>new Response(JSON.stringify(x),{status:200,headers:{"content-type":"application/json"}});
function fixture(options={}){
 const target=options.item??item, market=markets[target.marketplace];
 const offers=[{marketplace_id:market,audience:"ALL",currency:"EUR",
  our_price:[{schedule:[{value_with_tax:110}]}],
  minimum_seller_allowed_price:[{schedule:[{value_with_tax:110}]}],
  maximum_seller_allowed_price:[{schedule:[{value_with_tax:100}]}],
  start_at:{value:"2026-01-01"},map_price:[{schedule:[{value_with_tax:99}]}]},
 {marketplace_id:market,audience:"B2B",currency:"EUR",our_price:[{schedule:[{value_with_tax:90}]}],custom:{preserve:true}}];
 let listing={sku:target.sku,summaries:[{marketplaceId:market,asin:target.asin,productType:"SHIRT"}],
  offers:[{marketplaceId:market,offerType:"B2C",audience:{value:"ALL"},price:{amount:"110.00",currencyCode:"EUR"}}],
  fulfillmentAvailability:[{fulfillmentChannelCode:"DEFAULT",quantity:3}],
  attributes:{purchasable_offer:structuredClone(offers),private_attr:[{value:"PRIVATE CONTACT"}]}};
 const source={shop:{currencyCode:"EUR"},productVariants:{pageInfo:{hasNextPage:false},nodes:[{
  id:"gid://shopify/ProductVariant/1",sku:target.sku,barcode:target.ean,price:"90.00",compareAtPrice:"100.00",inventoryQuantity:4,
  product:{id:"gid://shopify/Product/1",vendor:target.sku.startsWith("SPR_")?"Sprayground":"MC2 Saint Barth",status:"ACTIVE"}}]}};
 const catalog={numberOfResults:1,items:[{asin:target.asin,identifiers:[{marketplaceId:market,identifiers:[{identifierType:"EAN",identifier:target.ean}]}]}]};
 const calls=[],checkpoints=[];let previews=0,live=0,shopReads=0;
 const deps={token:async()=>"mock-token",shopify:async(_env,q,vars)=>{
   shopReads++;assert(q.includes("compareAtPrice"));assert.equal(vars.query,'sku:"'+target.sku+'" OR barcode:"'+target.ean+'"');
   return structuredClone(source);
  },fetch:async(url,init)=>{
   const u=new URL(url);assert.equal(u.origin,"https://sellingpartnerapi-eu.amazon.com");assert.equal(init.redirect,"manual");
   assert.equal(u.searchParams.get("marketplaceIds"),market);calls.push({url:u.toString(),method:init.method});
   if(init.method==="GET")return json(u.pathname.includes("/catalog/")?catalog:listing);
   assert.equal(init.method,"PATCH");const body=JSON.parse(init.body);
   assert.equal(body.productType,"SHIRT");assert.equal(body.patches.length,1);
   assert.equal(body.patches[0].path,"/attributes/purchasable_offer");
   const expected=structuredClone(offers);expected[0].maximum_seller_allowed_price[0].schedule[0].value_with_tax=110;
   assert.deepEqual(body.patches[0].value,expected,"complete offer, other audience, fields and minimum preserved");
   assert(!init.body.includes("fulfillment_availability"));assert(!init.body.includes("PRIVATE"));
   if(u.searchParams.has("mode")){
    assert.equal(u.searchParams.get("mode"),"VALIDATION_PREVIEW");previews++;
    if(options.driftAfterPreview&&previews===2)source.productVariants.nodes[0].compareAtPrice="101.00";
    return json({sku:target.sku,status:options.previewReject?"INVALID":"VALID",issues:options.previewIssues??[]});
   }
   live++;
   assert.equal(checkpoints.at(-1).processed.at(-1).status,"WRITE_ATTEMPT_STARTED","durable checkpoint precedes live request");
   if(options.networkThrow)throw Error("PRIVATE TOKEN");
   if(options.badAck)return json({sku:target.sku,status:"ACCEPTED",issues:[]});
   if(!options.staleReadback)listing.attributes.purchasable_offer=body.patches[0].value;
   return json({sku:target.sku,status:"ACCEPTED",submissionId:"SUB-123",issues:options.liveIssues??[]});
  }};
 return {deps,source,listing,catalog,offers,calls,checkpoints,checkpoint:async x=>checkpoints.push(structuredClone(x)),
  stats:()=>({previews,live,shopReads})};
}
let tests=0;
for(const marketplace of Object.keys(markets)){
 const req={items:[{...item,marketplace}]},f=fixture({item:req.items[0]});
 const plan=await prepare(req,env,f.deps);
 assert.equal(f.stats().live,0);assert.equal(plan.items[0].target_cents,11000);
 assert(!JSON.stringify(plan).includes("PRIVATE"));assert(!JSON.stringify(plan).includes("purchasable_offer"));
 const r=await execute(plan,env,f.checkpoint,f.deps);
 assert.equal(r.maximum_readback_verified,1);assert.equal(r.live_submissions,1);
 assert.equal(r.buyable_verified,false);assert.equal(r.price_changed,false);assert.equal(r.minimum_changed,false);
 assert.equal(f.stats().live,1);assert.equal(f.stats().previews,2);tests++;
}
for(const bad of [
 {items:[]},{items:Array(101).fill(item)},{items:[item,item]},
 {items:[{...item,marketplace:"UK"}]},{items:[{...item,sku:"KWAY_TEST_S"}]},
 {items:[{...item,ean:"8057338520505"}]},{items:[{...item,sku:"MC2_PEA0001_00446I_S"}]},
 {items:[{...item,target_price:110}]},{items:[item],fingerprint:"forged"},
 {items:[item,{...item,sku:"MC2_TEST_001_M"}]}
]){
 const f=fixture();await assert.rejects(()=>prepare(bad,env,f.deps),/price_bounds_repair/);assert.equal(f.calls.length,0);tests++;
}
const failures=[
 f=>f.source.productVariants.nodes.push(structuredClone(f.source.productVariants.nodes[0])),
 f=>f.source.productVariants.pageInfo.hasNextPage=true,
 f=>f.source.productVariants.nodes[0].inventoryQuantity=0,
 f=>f.source.productVariants.nodes[0].product.vendor="Other",
 f=>f.source.productVariants.nodes[0].product.status="DRAFT",
 f=>f.source.shop.currencyCode="USD",
 f=>f.source.productVariants.nodes[0].compareAtPrice=null,
 f=>f.catalog.numberOfResults=2,
 f=>f.catalog.items[0].asin="B0OTHER001",
 f=>f.catalog.items[0].identifiers[0].identifiers[0].identifier="1234567890128",
 f=>f.listing.fulfillmentAvailability[0].quantity=0,
 f=>f.listing.summaries[0].asin="B0OTHER001",
 f=>f.listing.offers[0].price.amount="109.00",
 f=>f.listing.offers[0].offerType="B2B",
 f=>f.listing.offers[0].price.currencyCode="USD",
 f=>delete f.listing.attributes.purchasable_offer[0].maximum_seller_allowed_price,
 f=>f.listing.attributes.purchasable_offer[0].minimum_seller_allowed_price[0].schedule[0].value_with_tax=99,
 f=>f.listing.attributes.purchasable_offer[0].maximum_seller_allowed_price[0].schedule[0].value_with_tax=110,
 f=>f.listing.attributes.purchasable_offer[0].maximum_seller_allowed_price[0].schedule.push({value_with_tax:120}),
 f=>f.listing.attributes.purchasable_offer[0].maximum_seller_allowed_price[0].schedule[0].start_at="2026-11-16",
 f=>f.listing.attributes.purchasable_offer.push(structuredClone(f.listing.attributes.purchasable_offer[0])),
];
for(const change of failures){const f=fixture();change(f);await assert.rejects(()=>prepare(request,env,f.deps),/price_bounds_repair/);assert.equal(f.stats().live,0);tests++;}
{
 const f=fixture({previewReject:true});await assert.rejects(()=>prepare(request,env,f.deps),/preview_rejected/);assert.equal(f.stats().live,0);tests++;
}
for(const change of [f=>f.source.productVariants.nodes[0].price="91.00",f=>f.listing.attributes.purchasable_offer[1].custom.preserve=false,f=>f.listing.fulfillmentAvailability[0].quantity=2]){
 const f=fixture(),p=await prepare(request,env,f.deps);change(f);
 const r=await execute(p,env,f.checkpoint,f.deps);assert.equal(r.blocked_count,1);
 assert.equal(r.blocked_before_write[0].reason,"price_bounds_repair_source_drift");assert.equal(f.stats().live,0);tests++;
}
{
 const f=fixture({driftAfterPreview:true}),p=await prepare(request,env,f.deps);
 const r=await execute(p,env,f.checkpoint,f.deps);assert.equal(r.blocked_count,1);assert.equal(f.stats().live,0);tests++;
}
for(const option of ["networkThrow","badAck"]){
 const f=fixture({[option]:true}),p=await prepare(request,env,f.deps);
 await assert.rejects(()=>execute(p,env,f.checkpoint,f.deps),/reconciliation_required/);
 assert.equal(f.stats().live,1);assert.equal(f.checkpoints.at(-1).status,"RECONCILIATION_REQUIRED");
 assert.equal(f.checkpoints.at(-1).buyable_verified,false);assert(!JSON.stringify(f.checkpoints).includes("PRIVATE"));
 tests++;
}
{
 const f=fixture({staleReadback:true}),p=await prepare(request,env,f.deps);
 const r=await execute(p,env,f.checkpoint,f.deps);
 assert.equal(r.status,"SUBMITTED_WITH_PENDING_READBACK");assert.equal(r.pending_readback,1);
 assert.equal(r.maximum_readback_verified,0);assert.equal(r.live_submissions,1);
 assert.equal(r.processed[0].submission_reference,"SUB-123");assert.equal(f.stats().live,1);tests++;
}
for(const uncertain of [false,true]){
 const second={...item,sku:"MC2_SECOND_002_M",asin:"B0TEST0002",ean:"1234567890128"};
 const third={...item,sku:"MC2_THIRD_003_M",asin:"B0TEST0003",ean:"4006381333931"};
 const fs=[fixture({staleReadback:true}),fixture({item:second,networkThrow:uncertain}),fixture({item:third})];
 const items=[item,second,third],allCheckpoints=[];
 const deps={token:async()=>"mock-token",shopify:(env,q,v)=>fs[items.findIndex(i=>v.query.includes(i.sku))].deps.shopify(env,q,v),
  fetch:(url,init)=>{const u=new URL(url);const n=items.findIndex(i=>u.pathname.endsWith(i.sku)||u.searchParams.get("identifiers")===i.ean);return fs[n].deps.fetch(url,init);}};
 const checkpoint=async r=>{allCheckpoints.push(structuredClone(r));for(const f of fs)f.checkpoints.push(structuredClone(r));};
 const p=await prepare({items},env,deps);
 if(uncertain){
  await assert.rejects(()=>execute(p,env,checkpoint,deps),/reconciliation_required/);
  assert.equal(fs[2].stats().live,0);assert.equal(allCheckpoints.at(-1).processed[0].submission_reference,"SUB-123");
 }else{
  const r=await execute(p,env,checkpoint,deps);assert.equal(r.live_submissions,3);assert.equal(r.pending_readback,1);
  assert.equal(r.maximum_readback_verified,2);assert.equal(r.buyable_verified,false);
 }
 assert.equal(fs[0].stats().live,1);assert.equal(fs[1].stats().live,1);tests++;
}
for(const severity of ["WARNING","INFO"]){
 const f=fixture({previewIssues:[{code:"100708",severity}],liveIssues:[{code:"100708",severity}]}),p=await prepare(request,env,f.deps);
 const r=await execute(p,env,f.checkpoint,f.deps);assert.equal(r.live_submissions,1);tests++;
}
for(const issues of [[{code:"100708",severity:"ERROR"}],[{code:"100708",severity:"UNKNOWN"}],[{code:"100708"}],[null]]){
 const f=fixture({previewIssues:issues});await assert.rejects(()=>prepare(request,env,f.deps),/preview_rejected/);assert.equal(f.stats().live,0);tests++;
}
for(const stage of ["prepare","execute"]){
 const second={...item,sku:"MC2_SECOND_002_M",asin:"B0TEST0002",ean:"1234567890128"};
 const fs=[fixture({staleReadback:true}),fixture({item:second})],items=[item,second];
 const deps={token:async()=>"mock-token",shopify:(env,q,v)=>fs[items.findIndex(i=>v.query.includes(i.sku))].deps.shopify(env,q,v),
  fetch:(url,init)=>{const u=new URL(url);return fs[items.findIndex(i=>u.pathname.endsWith(i.sku)||u.searchParams.get("identifiers")===i.ean)].deps.fetch(url,init);}};
 const checkpoint=async r=>{for(const f of fs)f.checkpoints.push(structuredClone(r));};
 if(stage==="prepare")fs[1].source.productVariants.nodes[0].inventoryQuantity=0;
 const p=await prepare({items},env,deps);
 if(stage==="execute")fs[1].source.productVariants.nodes[0].price="91.00";
 if(stage==="prepare"){assert.equal(p.ready_count,1);assert.equal(p.blocked_before_write.length,1);assert.equal(p.requested_items,2);}
 const r=await execute(p,env,checkpoint,deps);
 assert.equal(r.live_submissions,1);assert.equal(r.blocked_count,1);assert.equal(r.requested_items,2);
 assert.equal(fs[0].stats().live,1);assert.equal(fs[1].stats().live,0);tests++;
}
const router=await readFile("src/mare-business-mcp.ts","utf8"),cap=await readFile("src/mare-business-capabilities.ts","utf8");
assert(router.includes('if (plan.result_summary?.provider_write_attempted === true) throw new Error("price_bounds_repair_reconciliation_required")'));
assert(router.includes('request = await prepareAmazonPriceBoundsRepair(request, env)'));
assert(router.includes('plan.result_summary = progress;\n      await storePlan(plan, env);'));
assert(cap.includes('id:"amazon.eu.price_bounds.repair.batch"'));
console.log(`Amazon price bounds repair: ${tests} focused scenarios passed; immutable router registration checked`);
