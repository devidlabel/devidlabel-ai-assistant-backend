import assert from "node:assert/strict";
import { build } from "esbuild";

/** Offline read-only Orders v2026-01-01 tests with synthetic orders. */
const compiled=await build({
  entryPoints:["src/marketplace-amazon-orders-readonly.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"
});
const {readAmazonOrdersPilot}=await import("data:text/javascript;base64,"+
  Buffer.from(compiled.outputFiles[0].text).toString("base64"));
const env={
  AMAZON_SP_API_CLIENT_ID:"synthetic-client",
  AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",
  AMAZON_SP_API_SELLER_ID:"A123456789"
};
const marketplaceIds={IT:"APJ6JRA9NG5V4",FR:"A13V1IB3VIYZZH"};
const input={
  marketplaces:["IT","FR"],
  last_updated_after:"2026-10-18T08:00:00Z",
  last_updated_before:"2026-10-18T10:45:00Z",
  max_pages:3
};
const clock=()=>Date.parse("2026-10-18T11:00:00Z");
const order=(id,marketId=marketplaceIds.IT)=>({
  orderId:id,createdTime:"2026-10-18T08:25:00Z",
  lastUpdatedTime:"2026-10-18T09:00:00Z",
  salesChannel:{channelName:"AMAZON",marketplaceId:marketId},
  fulfillment:{fulfilledBy:"MERCHANT",fulfillmentStatus:"UNSHIPPED"},
  buyer:{buyerName:"SECRET_PERSON_CANARY",buyerEmail:"SECRET_EMAIL_CANARY"},
  recipient:{deliveryAddress:{addressLine1:"SECRET_ADDRESS_CANARY"}},
  orderItems:[
    {orderItemId:id+"_LINE_01",quantityOrdered:2,
      product:{sellerSku:"00Case-A  ",asin:"B0TEST0001"},
      fulfillment:{quantityFulfilled:0}},
    {orderItemId:id+"_LINE_02",quantityOrdered:1,
      product:{sellerSku:"TEST-B",asin:"B0TEST0002"}}
  ]
});
const a=order("SYNTH_ORDER_A");
const b=order("SYNTH_ORDER_B",marketplaceIds.FR);
delete b.orderItems[0].product.sellerSku;
delete b.fulfillment.fulfillmentStatus;
let mode="success",requests=[];
const original=globalThis.fetch;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,
  headers:{"content-type":"application/json"}});
function install(){
  requests=[];
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(String(url));
    requests.push({url:u.toString(),method:init.method,headers:init.headers});
    if(u.hostname==="api.amazon.com"){
      assert.equal(init.method,"POST");
      return json({access_token:"synthetic-token"});
    }
    assert.equal(u.pathname,"/orders/2026-01-01/orders");
    assert.equal(init.method,"GET");
    assert.equal(init.headers["x-amz-access-token"],"synthetic-token");
    assert.equal(u.searchParams.get("lastUpdatedAfter"),input.last_updated_after);
    assert.equal(u.searchParams.get("lastUpdatedBefore"),input.last_updated_before);
    assert.equal(u.searchParams.get("marketplaceIds"),
      marketplaceIds.IT+","+marketplaceIds.FR);
    assert.equal(u.searchParams.get("includedData"),"FULFILLMENT");
    assert.equal(u.searchParams.get("fulfilledBy"),"MERCHANT");
    assert.equal(u.searchParams.get("maxResultsPerPage"),"100");
    assert(!u.searchParams.has("buyer"));
    const pagination=u.searchParams.get("paginationToken");
    if(mode==="http403")return json({errors:[{code:"FORBIDDEN"}]},403);
    if(mode==="http429")return json({errors:[{code:"THROTTLED"}]},429);
    if(mode==="invalidJson")return new Response("not JSON",{status:200});
    if(mode==="nonMerchant")return json({orders:[{...a,fulfillment:{
      fulfilledBy:"AMAZON",fulfillmentStatus:"UNSHIPPED"}}]});
    if(mode==="badLine")return json({orders:[{...a,orderItems:[
      {...a.orderItems[0],quantityOrdered:1.5}
    ]}]});
    if(mode==="wrongMarket")return json({orders:[order("SYNTH_ORDER_Z","INVALID_MARKET")]});
    if(mode==="repeatToken")return json({orders:[],pagination:{nextToken:"repeating"}});
    if(mode==="outOfWindow")return json({orders:[{...a,lastUpdatedTime:"2026-10-18T10:50:00Z"}]});
    if(mode==="badPagination")return json({orders:[a],pagination:[]});
    if(mode==="empty")return json({orders:[]});
    if(mode==="conflict"){
      return pagination?json({orders:[{...a,lastUpdatedTime:"2026-10-18T09:12:00Z"}]}):
        json({orders:[a],pagination:{nextToken:"token-A"}});
    }
    if(mode==="success"){
      if(pagination){assert.equal(pagination,"token-A");return json({orders:[a]});}
      return json({orders:[a,b],pagination:{nextToken:"token-A"}});
    }
    throw new Error("invalid test mode");
  };
}
try{
  install();
  const result=await readAmazonOrdersPilot(input,env,clock);
  assert.equal(result.ok,true);
  assert.equal(result.read_only,true);
  assert.equal(result.order_count,2);
  assert.equal(result.complete_pagination,true);
  assert.equal(result.pages_read,2);
  assert.equal(result.importer_enabled,false);
  assert.equal(result.can_advance_checkpoint,false);
  assert.equal(result.identity_scope,"SELLER_ACCOUNT_PLUS_ORDER_ID");
  assert.equal(result.orders[0].items[0].seller_sku,"00Case-A  ");
  assert.equal(result.orders[0].line_count,2);
  assert.equal(result.orders[1].needs_enrichment,true);
  assert.equal(result.orders[1].items[0].mapping_status,"MISSING_SELLER_SKU");
  assert(!JSON.stringify(result).includes("SECRET_PERSON_CANARY"));
  assert(!JSON.stringify(result).includes("SECRET_EMAIL_CANARY"));
  assert(!JSON.stringify(result).includes("SECRET_ADDRESS_CANARY"));
  assert(requests.filter(x=>x.method!=="POST").every(x=>x.method==="GET"));

  const before=requests.length;
  for(const bad of [
    {...input,last_updated_before:"2026-10-18T10:59:00Z"},
    {...input,last_updated_after:input.last_updated_before},
    {...input,marketplaces:["IT","IT"]},
    {...input,max_pages:0},
    {...input,allow_write:true}
  ])await assert.rejects(()=>readAmazonOrdersPilot(bad,env,clock));
  assert.equal(requests.length,before,"invalid input must not send network requests");

  for(const [m,msg] of [
    ["nonMerchant","amazon_orders_wrong_fulfillment_route"],
    ["badLine","amazon_orders_invalid_line"],
    ["wrongMarket","amazon_orders_invalid_order_identity"],
    ["outOfWindow","amazon_orders_out_of_window"],
    ["badPagination","amazon_orders_invalid_pagination"],
    ["conflict","amazon_orders_inconsistent_duplicate"],
    ["repeatToken","amazon_orders_invalid_pagination"],
    ["http403","amazon_orders_http_403"],
    ["http429","amazon_orders_http_429"],
    ["invalidJson","amazon_orders_invalid_json"]
  ]){
    mode=m;install();
    await assert.rejects(()=>readAmazonOrdersPilot(input,env,clock),
      new RegExp(msg));
  }
  mode="success";install();
  await assert.rejects(()=>readAmazonOrdersPilot({...input,max_pages:1},env,clock),
    /amazon_orders_scan_incomplete_max_pages/);
  mode="empty";install();
  const none=await readAmazonOrdersPilot(input,env,clock);
  assert.equal(none.order_count,0);
  assert.equal(none.complete_pagination,true);
  assert.equal(none.can_advance_checkpoint,false);
  console.log("PASS read-only Amazon Orders v2026-01-01: bounded pagination, stable account order identity, SKU preservation, PII exclusion and no writes");
} finally {
  globalThis.fetch=original;
}
