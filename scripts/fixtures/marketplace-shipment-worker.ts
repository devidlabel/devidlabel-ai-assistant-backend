import worker from "../../src/worker-v4.ts";

// Synthetic provider responses only. All outbound requests are intercepted.
const GID="gid://shopify/Order/9201", OID="123-1234567-1234567";
const LID="gid://shopify/LineItem/9202", ITEM="SYNTHETIC_AMAZON_ITEM";
const TRACKING="SYNTHETIC_PRIVATE_TRACKING_CANARY";
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{
  status,headers:{"Content-Type":"application/json"}
});
let mode="",metrics:Record<string,number>;
globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const req=input instanceof Request?input:new Request(input,init);
  const url=new URL(req.url);
  if(url.origin==="https://api.amazon.com"&&url.pathname==="/auth/o2/token"){
    metrics.token_requests++;
    if(req.method!=="POST")throw new Error("UNEXPECTED_TOKEN_METHOD");
    const body=new URLSearchParams(await req.text());
    if(body.get("grant_type")!=="refresh_token"||body.get("refresh_token")!=="SYNTHETIC_REFRESH_CANARY"||
       body.get("client_id")!=="SYNTHETIC_CLIENT"||body.get("client_secret")!=="SYNTHETIC_SECRET_CANARY")
      throw new Error("UNEXPECTED_LWA_REQUEST");
    return json({access_token:"SYNTHETIC_ACCESS_CANARY"});
  }
  if(url.origin==="https://sellingpartnerapi-eu.amazon.com"){
    metrics.amazon_reads++;
    if(req.method!=="GET"){metrics.provider_mutations++;throw new Error("AMAZON_MUTATION_FORBIDDEN");}
    if(url.pathname!=="/orders/2026-01-01/orders/"+OID||
       url.searchParams.get("includedData")!=="FULFILLMENT,PACKAGES"||
       [...url.searchParams.keys()].length!==1||req.redirect!=="manual"||
       req.headers.get("x-amz-access-token")!=="SYNTHETIC_ACCESS_CANARY")
      throw new Error("UNEXPECTED_AMAZON_READ");
    if(mode==="amazon_http403")return json({errors:[{message:"SYNTHETIC_PRIVATE_ERROR_CANARY"}]},403);
    if(mode==="amazon_redirect")return new Response(null,{status:302,headers:{Location:"https://untrusted.invalid/CANARY"}});
    const now=Date.now();
    const packageRow:Record<string,unknown>={
      packageReferenceId:"SYNTHETIC_PACKAGE",carrier:"Synthetic carrier",
      trackingNumber:mode==="different_tracking"?"SYNTHETIC_OTHER_TRACKING_CANARY":TRACKING,
      shipTime:new Date(now-60_000).toISOString(),packageStatus:{status:"DELIVERED"},
      packageItems:[{orderItemId:ITEM,quantity:1}],
      shipFromAddress:{name:"SYNTHETIC_PRIVATE_NAME_CANARY",addressLine1:"SYNTHETIC_PRIVATE_ADDRESS_CANARY"}
    };
    if(mode==="missing_tracking")delete packageRow.trackingNumber;
    const order:Record<string,unknown>={
      orderId:mode==="wrong_order"?"321-7654321-7654321":OID,
      createdTime:new Date(now-3_600_000).toISOString(),
      lastUpdatedTime:new Date(now-30_000).toISOString(),
      salesChannel:{channelName:"AMAZON",marketplaceId:mode==="wrong_market"?"APJ6JRA9NG5V4":"A1PA6795UKMFR9"},
      fulfillment:{fulfilledBy:"MERCHANT",fulfillmentStatus:"SHIPPED"},
      orderItems:[{orderItemId:ITEM,quantityOrdered:1,product:{
        sellerSku:"SYNTHETIC_SKU",customizedUrl:"https://private.invalid/CANARY"},
        fulfillment:{quantityFulfilled:1,quantityUnfulfilled:0,shipping:{giftMessage:"SYNTHETIC_PRIVATE_GIFT_CANARY"}}}],
      packages:[packageRow],buyer:{buyerEmail:"SYNTHETIC_PRIVATE_EMAIL_CANARY"},
      recipient:{name:"SYNTHETIC_PRIVATE_RECIPIENT_CANARY"}
    };
    if(mode==="missing_packages")delete order.packages;
    return json({order});
  }
  if(url.origin==="https://synthetic.myshopify.com"){
    metrics.shopify_reads++;
    if(req.method!=="POST"||url.pathname!=="/admin/api/2026-01/graphql.json"||
       req.headers.get("X-Shopify-Access-Token")!=="SYNTHETIC_SHOPIFY_CANARY")
      throw new Error("UNEXPECTED_SHOPIFY_REQUEST");
    const body=await req.json() as {query?:string;variables?:{id?:string}};
    if(/\bmutation\b/i.test(body.query||"")){metrics.provider_mutations++;throw new Error("SHOPIFY_MUTATION_FORBIDDEN");}
    if(body.variables?.id!==GID)throw new Error("WRONG_SHOPIFY_SELECTOR");
    const order={id:GID,sourceName:"amazon",sourceIdentifier:OID,app:{name:"Channable"},
      customAttributes:[{key:"Amazon Order ID",value:OID}]};
    if(body.query?.includes("MareChannableImportedAmazonOrder"))return json({data:{order:{
      ...order,lineItems:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{
        id:LID,sku:"SYNTHETIC_SKU",quantity:1,currentQuantity:1,variant:{id:"gid://shopify/ProductVariant/9203"}
      }]}
    }}});
    if(body.query?.includes("MareChannableMarketplaceFulfillments"))return json({data:{order:{
      ...order,displayFulfillmentStatus:"FULFILLED",fulfillments:[{
        id:"gid://shopify/Fulfillment/9204",status:mode==="failed_shopify"?"FAILURE":"SUCCESS",displayStatus:"CONFIRMED",
        trackingInfo:[{company:"Synthetic carrier",number:TRACKING},...(mode==="multitracking"?[
          {company:"Synthetic carrier",number:"SYNTHETIC_EXTRA_TRACKING_CANARY"}
        ]:[])],
        fulfillmentLineItems:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{
          id:"gid://shopify/FulfillmentLineItem/9205",quantity:1,lineItem:{id:LID,sku:"SYNTHETIC_SKU"}
        }]}
      }]
    }}});
    throw new Error("UNEXPECTED_SHOPIFY_QUERY");
  }
  metrics.unmocked_requests++;
  throw new Error("UNMOCKED_NETWORK_FORBIDDEN");
};

export default {async fetch(req:Request,env:Record<string,unknown>,ctx:ExecutionContext){
  mode=req.headers.get("x-fixture-mode")||"";
  metrics={amazon_reads:0,shopify_reads:0,token_requests:0,provider_mutations:0,storage_writes:0,unmocked_requests:0};
  const runtimeEnv={...env,SHOPIFY_TOKENS_KV:{
    get:async()=>null,put:async()=>{metrics.storage_writes++;throw new Error("STORAGE_WRITE_FORBIDDEN");},
    delete:async()=>{metrics.storage_writes++;throw new Error("STORAGE_DELETE_FORBIDDEN");}
  }};
  if(mode==="unconfigured")delete runtimeEnv.AMAZON_SP_API_REFRESH_TOKEN;
  const response=await worker.fetch(req,runtimeEnv as never,ctx);
  let result:unknown;try{result=await response.json();}catch{result={non_json:true};}
  return json({status:response.status,result,metrics},response.status);
}};
