import worker from "../../src/worker-v4.ts";

// Synthetic transports only; every unrecognized request is rejected.
const SELLER="SYNTHETICSELLER01",SKU="SYNTHETIC_STOCK_001",ASIN="B0TEST0001";
const MARKET_IDS:Record<string,string>={IT:"APJ6JRA9NG5V4",DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"};
const QUANTITIES:Record<string,number>={IT:3,DE:2,FR:0,ES:1};
const PRICES:Record<string,string>={IT:"39.90",DE:"41.90",FR:"42.90",ES:"43.90"};
const json=(data:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{
  status,headers:{"Content-Type":"application/json","x-amzn-requestid":"SYNTHETIC-REQUEST-001",...headers}
});
let mode="",metrics:Record<string,number>,paths:string[];
function unexpected(reason:string):never{metrics.unmocked_requests++;throw new Error(reason);}

globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const req=input instanceof Request?input:new Request(input,init),url=new URL(req.url);
  if(url.origin==="https://api.amazon.com"&&url.pathname==="/auth/o2/token"){
    metrics.token_requests++;
    if(req.method!=="POST")return unexpected("BAD_TOKEN_METHOD");
    const body=new URLSearchParams(await req.text());
    if(body.get("grant_type")!=="refresh_token"||body.get("refresh_token")!=="SYNTHETIC_REFRESH_CANARY"||
       body.get("client_id")!=="SYNTHETIC_CLIENT"||body.get("client_secret")!=="SYNTHETIC_SECRET_CANARY")
      return unexpected("BAD_TOKEN_REQUEST");
    if(mode==="token_failure")return json({message:"SYNTHETIC_PRIVATE_CANARY"},403);
    return json({access_token:"SYNTHETIC_ACCESS_CANARY"});
  }
  if(url.origin!=="https://sellingpartnerapi-eu.amazon.com")return unexpected("UNMOCKED_NETWORK");
  if(req.method!=="GET"){metrics.provider_mutations++;return unexpected("PROVIDER_MUTATION");}
  metrics.amazon_reads++;paths.push(req.method+" "+url.pathname);
  if(req.headers.get("x-amz-access-token")!=="SYNTHETIC_ACCESS_CANARY"||req.redirect!=="manual"||
     req.body!==null||[...url.searchParams.keys()].sort().join(",")!=="includedData,marketplaceIds"||
     url.searchParams.get("includedData")!=="summaries,offers,issues,fulfillmentAvailability")
    return unexpected("BAD_LISTING_REQUEST");
  const marketId=url.searchParams.get("marketplaceIds"),market=Object.keys(MARKET_IDS).find(k=>MARKET_IDS[k]===marketId);
  if(!market)return unexpected("BAD_MARKET");
  const sku=decodeURIComponent(url.pathname.split("/").at(-1)||"");
  if(url.pathname!=="/listings/2021-08-01/items/"+SELLER+"/"+encodeURIComponent(sku)||
     ![SKU,"SYNTHETIC_STOCK_002"].includes(sku))return unexpected("BAD_SKU");
  if(mode==="http403")return json({errors:[{message:"SYNTHETIC_PRIVATE_CANARY"}]},403);
  if(mode==="redirect")return new Response(null,{status:302,headers:{Location:"https://private.invalid/CANARY"}});
  if(mode==="not_found")return json({errors:[{code:"NOT_FOUND",message:"SYNTHETIC_PRIVATE_CANARY"}]},404);
  if(mode==="ambiguous404")return json({errors:[{code:"ACCESS_DENIED",message:"SYNTHETIC_PRIVATE_CANARY"}]},404);
  if(mode==="invalid_json")return new Response('{"SYNTHETIC_PRIVATE_CANARY":',{
    headers:{"Content-Type":"application/json"}
  });
  if(mode==="large_body")return new Response(' '.repeat(1_000_001),{
    headers:{"Content-Type":"application/json"}
  });
  const otherMarket=market==="IT"?MARKET_IDS.DE:MARKET_IDS.IT;
  const offer=(value="ALL",offerType="B2C",amount=PRICES[market],currency="EUR",mkt=marketId)=>({
    marketplaceId:mkt,offerType,price:{amount,currencyCode:currency},
    audience:{value,displayName:"SYNTHETIC_PRIVATE_CANARY"},arbitrary:"SYNTHETIC_PRIVATE_CANARY"
  });
  const body:Record<string,any>={
    sku,summaries:[{marketplaceId:marketId,asin:ASIN,productType:"HANDBAG",status:["BUYABLE"],
      itemName:"SYNTHETIC_PRIVATE_CANARY",mainImage:{link:"https://private.invalid/CANARY"}}],
    fulfillmentAvailability:[{fulfillmentChannelCode:"DEFAULT",quantity:QUANTITIES[market]}],
    offers:[offer()],issues:[{code:"90220",severity:"WARNING",categories:["MISSING_ATTRIBUTE"],
      attributeNames:["fulfillment_availability"],message:"SYNTHETIC_PRIVATE_CANARY"}],
    attributes:{fulfillment_availability:[{quantity:999}]},arbitrary:"SYNTHETIC_PRIVATE_CANARY"
  };
  if(mode==="missing_fulfillment")delete body.fulfillmentAvailability;
  if(mode==="empty_fulfillment")body.fulfillmentAvailability=[];
  if(mode==="fba_only")body.fulfillmentAvailability=[{fulfillmentChannelCode:"AMAZON_EU",quantity:50}];
  if(mode==="missing_quantity")body.fulfillmentAvailability=[{fulfillmentChannelCode:"DEFAULT"}];
  if(mode==="duplicate_quantity")body.fulfillmentAvailability.push({...body.fulfillmentAvailability[0]});
  if(mode==="string_quantity")body.fulfillmentAvailability[0].quantity="3";
  if(mode==="negative_quantity")body.fulfillmentAvailability[0].quantity=-1;
  if(mode==="fractional_quantity")body.fulfillmentAvailability[0].quantity=1.5;
  if(mode==="missing_offers")delete body.offers;
  if(mode==="empty_offers")body.offers=[];
  if(mode==="b2b_only")body.offers=[offer("ALL","B2B","29.90")];
  if(mode==="segmented_only")body.offers=[offer("PRIME_EXCLUSIVE")];
  if(mode==="missing_audience")delete body.offers[0].audience;
  if(mode==="duplicate_b2c")body.offers.push({...body.offers[0]});
  if(mode==="wrong_currency")body.offers=[offer("ALL","B2C","39.90","USD")];
  if(mode==="numeric_amount")body.offers[0].price.amount=39.9;
  if(mode==="negative_amount")body.offers[0].price.amount="-1.00";
  if(mode==="foreign_offers")body.offers=[offer("ALL","B2C","0.01","EUR",otherMarket)];
  if(mode==="mixed_offers")body.offers.push(offer("ALL","B2B","29.90"),offer("PRIME_EXCLUSIVE","B2C","34.90"),
    offer("ALL","B2C","0.01","EUR",otherMarket));
  if(mode==="decimal_precision")body.offers[0].price.amount="39.9000";
  if(mode==="wrong_sku")body.sku="SYNTHETIC_OTHER_SKU";
  if(mode==="invalid_asin")body.summaries[0].asin="SYNTHETIC_PRIVATE_CANARY";
  if(mode==="wrong_market")body.summaries[0].marketplaceId=otherMarket;
  if(mode==="duplicate_summary")body.summaries.push({...body.summaries[0]});
  return json(body);
};

export default {async fetch(req:Request,env:Record<string,unknown>,ctx:ExecutionContext){
  mode=req.headers.get("x-fixture-mode")||"";
  metrics={amazon_reads:0,token_requests:0,provider_mutations:0,storage_writes:0,storage_deletes:0,unmocked_requests:0};paths=[];
  const runtimeEnv:Record<string,unknown>={...env,SHOPIFY_TOKENS_KV:{
    get:async()=>null,
    put:async()=>{metrics.storage_writes++;throw new Error("UNEXPECTED_STORAGE_WRITE");},
    delete:async()=>{metrics.storage_deletes++;throw new Error("UNEXPECTED_STORAGE_DELETE");}
  }};
  if(mode==="unconfigured")delete runtimeEnv.AMAZON_SP_API_REFRESH_TOKEN;
  if(mode==="missing_seller")delete runtimeEnv.AMAZON_SP_API_SELLER_ID;
  const response=await worker.fetch(req,runtimeEnv as never,ctx);
  return json({status:response.status,result:await response.json(),metrics,paths},response.status);
}};
