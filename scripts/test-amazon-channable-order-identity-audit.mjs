import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const compiled=await build({entryPoints:["src/mare-business-amazon-channable-order-identity-audit.ts"],
 format:"esm",platform:"neutral",bundle:true,write:false,logLevel:"silent"});
const d=await mkdtemp(join(tmpdir(),"amazon-order-audit-")),file=join(d,"test.mjs");
await writeFile(file,compiled.outputFiles[0].text);
const {readAmazonChannableOrderIdentityAudit:read}=await import(pathToFileURL(file).href);
await rm(d,{recursive:true,force:true});
const input={
 marketplaces:["IT","DE","FR","ES"],
 amazon_updated_after:"2026-10-19T00:00:00.000Z",amazon_updated_before:"2026-10-21T23:59:00.000Z",
 shopify_created_after:"2026-10-19T00:00:00.000Z",shopify_created_before:"2026-10-21T23:59:00.000Z",
 amazon_max_pages:2,shopify_max_pages:3
};
const account="A36YZOXNITDU1N", market="APJ6JRA9NG5V4";
const oid=n=>"123-"+String(n).padStart(7,"0")+"-"+String(n+100).padStart(7,"0");
const order=(id,created,updated)=>({
 account_id:account,order_id:id,order_key:"amazon:"+account+":"+id,
 created_at:created,last_updated_at:updated,marketplace_id:market,
 fulfillment_owner:"MERCHANT",contains_customer_data:false
});
const amazon=(patch={})=>({
 ok:true,source:"amazon_spapi_orders_2026_01_01",read_only:true,
 account_id:account,identity_scope:"SELLER_ACCOUNT_PLUS_ORDER_ID",
 fulfilled_by:"MERCHANT",selected_marketplaces:input.marketplaces,
 last_updated_after:input.amazon_updated_after,last_updated_before:input.amazon_updated_before,
 complete_pagination:true,pages_read:1,zero_quantity_line_count:1,
 orders:[
  order(oid(1),"2026-10-18T12:00:00.000Z","2026-10-19T12:00:00.000Z"),
  order(oid(2),"2026-10-20T12:00:00.000Z","2026-10-20T12:00:00.000Z"),
  order(oid(3),"2026-10-20T13:00:00.000Z","2026-10-20T13:00:00.000Z"),
 ],order_count:3,...patch
});
const imported=(orderId,id)=>({
 amazon_order_id:orderId,shopify_order_gid:"gid://shopify/Order/"+id,
 shopify_created_at:"2026-10-20T15:00:00.000Z",
 source_name:"amazon",importing_app:"Channable",adoption_status:"FOUND_CHANNABLE"
});
const shopify=(patch={})=>({
 ok:true,source:"shopify_channable_amazon_order_signature",
 read_only:true,created_after:input.shopify_created_after,
 created_before:input.shopify_created_before,
 pagination_complete:true,order_importer_owner:"CHANNABLE",
 absence_proven:false,safe_to_create_shopify_order:false,
 found:[imported(oid(2),1000000001),imported(oid(5),1000000002)],
 found_count:2,unverified:[],unverified_count:0,pages_read:1,...patch
});
const dps=(ap=amazon(),sp=shopify())=>({
 amazon:async args=>{assert.deepEqual(args.marketplaces,input.marketplaces);return ap;},
 shopify:async args=>{assert.equal(args.max_pages,3);return sp;}
});
const result=await read(input,{},dps());
assert.equal(result.ok,true);
assert.equal(result.matched_amazon_order_ids,1);
assert.equal(result.amazon_orders_observed,3);
assert.equal(result.shopify_channable_orders_observed,2);
assert.equal(result.amazon_unmatched_created_outside_shopify_window,1);
assert.equal(result.amazon_unmatched_created_inside_shopify_window,1);
assert.equal(result.shopify_orders_not_in_amazon_updated_window,1);
assert.equal(result.amazon_zero_quantity_line_count,1);
assert.equal(result.missing_imports_proven,false);
assert.equal(result.shopify_order_creation_authorized,false);
assert.equal(result.current_importer_owner,"CHANNABLE");
assert.equal(result.provider_mutations,0);
assert.equal(result.customer_personal_data_returned,false);
assert(!JSON.stringify(result).includes(oid(2)));
assert(!JSON.stringify(result).includes("gid://shopify/Order"));
const perfect=await read(input,{},dps(
 amazon({orders:[order(oid(2),"2026-10-20T12:00:00.000Z","2026-10-20T12:00:00.000Z")],order_count:1,zero_quantity_line_count:0}),
 shopify({found:[imported(oid(2),1000000001)],found_count:1})
));
assert.equal(perfect.all_amazon_orders_confirmed_imported_in_selected_observation,true);
assert.equal(perfect.missing_imports_proven,false);
const failcases=[
 [amazon({complete_pagination:false}),shopify()],
 [amazon({orders:[amazon().orders[0],amazon().orders[0]]}),shopify()],
 [amazon(),shopify({pagination_complete:false})],
 [amazon(),shopify({found:[shopify().found[0],shopify().found[0]]})],
 [amazon({account_id:"AANOTHERSELLER"}),shopify()],
 [amazon({last_updated_after:"2026-10-18T00:00:00.000Z"}),shopify()],
 [amazon(),shopify({absence_proven:true})]
];
for(const [am,sh] of failcases){
 const r=await read(input,{},dps(am,sh));
 assert.equal(r.ok,false);
 assert.equal(r.status,"INCOMPLETE_READ_ONLY_AUDIT");
 assert.equal(r.missing_imports_proven,false);
 assert.equal(r.shopify_order_creation_authorized,false);
 assert.equal(r.counts_usable_for_missing_order_decisions,false);
}
const dead=await read(input,{},{
 amazon:async()=>{throw Error("provider private timeout")},
 shopify:async()=>shopify()
});
assert.equal(dead.ok,false);
assert.equal(dead.reason,"PROVIDER_READ_FAILED");
for(const bad of [
 {...input,marketplaces:[]},
 {...input,marketplaces:["ES","ES"]},
 {...input,amazon_updated_before:input.amazon_updated_after},
 {...input,shopify_max_pages:11},
 {...input,amazon_updated_after:"yesterday"},
 {...input,shopify_created_after:"2026-09-01T00:00:00Z"},
 {...input,unsafe_import:true},
])await assert.rejects(()=>read(bad,{},{
 amazon:async()=>{throw Error("should not run")},
 shopify:async()=>{throw Error("should not run")}
}));
console.log("PASS read-only Amazon/Channable order identity audit: time windows, duplicate-safe join, zero-quantity, privacy and fail-closed");
