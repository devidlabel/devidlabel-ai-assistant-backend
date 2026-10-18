import assert from "node:assert/strict";
import {build} from "esbuild";

/** Real reader module bundled; provider GraphQL replies are synthetic.
 * No remote Shopify reads or customer payloads in this suite.
 */
const bundled=await build({
  entryPoints:["src/marketplace-shopify-channable-amazon-adoption.ts"],
  platform:"neutral",bundle:true,format:"esm",write:false,logLevel:"silent"
});
const {readShopifyChannableAmazonAdoptionIndex}=await import(
  "data:text/javascript;base64,"+
  Buffer.from(bundled.outputFiles[0].text).toString("base64")
);
const ids={
  a:"101-2345678-1234567",b:"101-2345678-1234568"
};
const candidate=(gid,amazon,extra={})=>({
  id:"gid://shopify/Order/"+gid,createdAt:"2026-10-17T12:00:00Z",
  sourceName:"amazon",sourceIdentifier:null,app:{name:"Channable"},
  customAttributes:[{key:"Amazon Order ID",value:amazon},
    {key:"Private Seller Note",value:"PII_CANARY_MUST_NEVER_LEAK"}],
  ...extra
});
const a=candidate("1001",ids.a), b=candidate("1002",ids.b);
const other=candidate("1003",ids.a,{app:{name:"Unknown App"}});
const input={
  created_after:"2026-10-16T00:00:00Z",
  created_before:"2026-10-18T00:00:00Z",
  max_pages:3
};
const env={
  SHOPIFY_SHOP_DOMAIN:"synthetic-store.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN:"synthetic-access",
  SHOPIFY_API_VERSION:"2025-10"
};
let visits=[];
const reader=async(_env,query,vars)=>{
  visits.push(vars);
  assert.equal(vars.first,50);
  assert.equal(query.includes("customAttributes { key value }"),true);
  assert.equal(vars.query.includes("source_name:amazon"),true);
  if(vars.after==="cursor-page-1")
    return {orders:{nodes:[b,other],pageInfo:{hasNextPage:false,endCursor:null}}};
  assert.equal(vars.after,null);
  return {orders:{nodes:[a],pageInfo:{hasNextPage:true,endCursor:"cursor-page-1"}}};
};
const run=(response=reader,params=input)=>readShopifyChannableAmazonAdoptionIndex(params,env,response);
const result=await run();
assert.equal(result.ok,true);
assert.equal(result.read_only,true);
assert.equal(result.found_count,2);
assert.equal(result.unverified_count,1);
assert.equal(result.shopify_orders_scanned,3);
assert.equal(result.pagination_complete,true);
assert.equal(result.absence_proven,false);
assert.equal(result.safe_to_create_shopify_order,false);
assert.equal(result.order_importer_owner,"CHANNABLE");
assert.equal(result.found[0].amazon_order_id,ids.a);
assert.equal(result.found[1].shopify_order_gid,"gid://shopify/Order/1002");
assert.equal(result.unverified[0].reason,"unexpected_importing_app_or_source");
assert(!JSON.stringify(result).includes("PII_CANARY"));
assert.equal(visits.length,2);

const malformed=[
  [{...a,customAttributes:[]},"unverified"],
  [{...a,customAttributes:[{key:"Amazon Order ID",value:"bogus"}]},"unverified"],
  [{...a,customAttributes:[
    {key:"Amazon Order ID",value:ids.a},
    {key:"Amazon Order ID",value:ids.a}
  ]},"unverified"],
  [{...a,sourceName:"web"},"unverified"],
  [{...a,app:{name:"Other"}},"unverified"]
];
for(const [test] of malformed) {
  const x=await run(async()=>({orders:{
    nodes:[test],pageInfo:{hasNextPage:false,endCursor:null}
  }}));
  assert.equal(x.found_count,0);assert.equal(x.unverified_count,1);
  assert.equal(x.safe_to_create_shopify_order,false);
}
for(const [rows,err] of [
  [[a,candidate("1009",ids.a)],/shopify_adoption_duplicate_external_order/],
  [[a,candidate("1001",ids.b)],/shopify_adoption_order_reference_changed/],
  [[{...a,sourceIdentifier:"OTHER"}],/shopify_adoption_conflicting_source_identifier/],
  [[{...a,id:"invalid"}],/shopify_adoption_order_id_invalid/],
  [[{...a,createdAt:"2026-10-20T00:00:00Z"}],/shopify_adoption_outside_window/]
]){
  await assert.rejects(()=>run(async()=>({orders:{
    nodes:rows,pageInfo:{hasNextPage:false,endCursor:null}
  }})),err);
}
for(const [page,err] of [
  [{nodes:[a],pageInfo:{hasNextPage:true,endCursor:null}},/shopify_adoption_invalid_cursor/],
  [{nodes:[a],pageInfo:{hasNextPage:true,endCursor:"x"}},/shopify_adoption_incomplete_pagination/]
]) {
  await assert.rejects(()=>run(async()=>({orders:page}),
    {...input,max_pages:1}),err);
}
await assert.rejects(()=>run(reader,{...input,max_pages:0}),/invalid_pages/);
await assert.rejects(()=>run(reader,{...input,created_before:input.created_after}),/invalid_window/);
await assert.rejects(()=>run(reader,{...input,creation_mode:"live"}),/invalid_request/);
assert.equal(visits.length,2);

// Transport smoke: use the same Shopify GraphQL client as production, but
// mock only its HTTPS boundary, not a fabricated complete-reader response.
const original=globalThis.fetch;
let graphqlRequests=0;
try {
  globalThis.fetch=async(url,opts={})=>{
    const u=new URL(String(url));
    assert.equal(u.host,"synthetic-store.myshopify.com");
    assert.equal(u.pathname,"/admin/api/2025-10/graphql.json");
    assert.equal(opts.method,"POST");
    const body=JSON.parse(opts.body);
    assert(body.query.includes("MareChannableAmazonOrderIndex"));
    assert(body.variables.query.includes("source_name:amazon"));
    graphqlRequests++;
    return new Response(JSON.stringify({data:{orders:{
      nodes:[a,b],pageInfo:{hasNextPage:false,endCursor:null}
    }}}),{status:200,headers:{"content-type":"application/json"}});
  };
  const liveClient=await readShopifyChannableAmazonAdoptionIndex(input,env);
  assert.equal(liveClient.found_count,2);
  assert.equal(graphqlRequests,1);
  assert.equal(liveClient.safe_to_create_shopify_order,false);
}finally{
  globalThis.fetch=original;
}
console.log("PASS Shopify Channable Amazon order adoption: external custom attribute mapping, full pagination, conflicting references, Shopify transport, no PII or order write");
