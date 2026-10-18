import worker from "../../src/worker-v4.ts";

// Isolated synthetic providers. This fixture never reaches a live service.
const SKU="SYNTHETIC_PREVIEW_001",ASIN="B0TEST0001",EAN="2000000001234";
const SELLER="SYNTHETICSELLER01";
const MARKET_IDS:Record<string,string>={IT:"APJ6JRA9NG5V4",DE:"A1PA6795UKMFR9",FR:"A13V1IB3VIYZZH",ES:"A1RKKUPIHCS9HS"};
const json=(data:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(data),{
  status,headers:{"Content-Type":"application/json",...headers}
});
const kv=new Map<string,string>();
let mode="",metrics:Record<string,number>,paths:string[];
const fail=(reason:string):never=>{metrics.unmocked_requests++;throw new Error(reason);};

globalThis.fetch=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
  const req=input instanceof Request?input:new Request(input,init),url=new URL(req.url);
  if(url.origin==="https://api.amazon.com"&&url.pathname==="/auth/o2/token"){
    metrics.token_requests++;
    if(req.method!=="POST")return fail("BAD_TOKEN_METHOD");
    const body=new URLSearchParams(await req.text());
    if(body.get("grant_type")!=="refresh_token"||body.get("refresh_token")!=="SYNTHETIC_REFRESH_CANARY"||
       body.get("client_id")!=="SYNTHETIC_CLIENT"||body.get("client_secret")!=="SYNTHETIC_SECRET_CANARY")
      return fail("BAD_TOKEN_REQUEST");
    return json({access_token:"SYNTHETIC_ACCESS_CANARY"});
  }
  if(url.origin==="https://synthetic.myshopify.com"){
    metrics.shopify_reads++;
    if(req.method!=="POST"||url.pathname!=="/admin/api/2026-01/graphql.json"||
       req.headers.get("X-Shopify-Access-Token")!=="SYNTHETIC_SHOPIFY_CANARY")return fail("BAD_SHOPIFY_REQUEST");
    const body=await req.json() as {query:string;variables:{query:string}};
    if(/\bmutation\b/i.test(body.query)){metrics.provider_mutations++;return fail("SHOPIFY_MUTATION");}
    if(!body.query.includes("MareBusinessCatalogComplete")||
       !body.query.includes("sortKey: ID, reverse: false")||
       !body.variables.query.includes("status:active,draft,archived,unlisted")||
       !(body.variables.query.startsWith('sku:"'+SKU+'"')||body.variables.query.startsWith('barcode:"'+EAN+'"')))
      return fail("BAD_SHOPIFY_SELECTOR");
    const variant={id:"gid://shopify/ProductVariant/9211",sku:SKU,barcode:EAN,price:"35.00",
      inventoryQuantity:mode==="zero_stock"?0:3,availableForSale:true,selectedOptions:[{name:"Color",value:"Black"}],
      inventoryItem:{id:"gid://shopify/InventoryItem/9212",tracked:true,inventoryLevels:{
        pageInfo:{hasNextPage:false},nodes:[{id:"gid://shopify/InventoryLevel/9213",
          location:{id:"gid://shopify/Location/9214",name:"Synthetic location"},
          quantities:[{name:"available",quantity:3}]}]}}};
    return json({data:{products:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[{
      id:"gid://shopify/Product/9210",vendor:mode==="excluded_brand"?"P448":"Synthetic Brand",status:"ACTIVE",
      title:"Synthetic accessory",productType:"Handbag",collections:{pageInfo:{hasNextPage:false},nodes:[]},
      media:{pageInfo:{hasNextPage:false},nodes:[]},
      variants:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[variant]}
    }]}}});
  }
  if(url.origin==="https://sellingpartnerapi-eu.amazon.com"){
    if(req.headers.get("x-amz-access-token")!=="SYNTHETIC_ACCESS_CANARY")return fail("BAD_AMAZON_AUTH");
    const marketId=url.searchParams.get("marketplaceIds")||"";
    if(!Object.values(MARKET_IDS).includes(marketId))return fail("BAD_MARKET");
    paths.push(req.method+" "+url.pathname);
    if(req.method==="PUT"){
      metrics.preview_requests++;
      const payload=await req.json() as Record<string,any>;
      if(url.pathname!=="/listings/2021-08-01/items/"+SELLER+"/"+SKU||req.redirect!=="manual"||
         [...url.searchParams.keys()].sort().join(",")!=="marketplaceIds,mode"||
         url.searchParams.get("mode")!=="VALIDATION_PREVIEW"||
         payload.productType!=="PRODUCT"||payload.requirements!=="LISTING_OFFER_ONLY"||
         payload.attributes.fulfillment_availability[0].quantity!==0||
         payload.attributes.fulfillment_availability[0].fulfillment_channel_code!=="DEFAULT"||
         payload.attributes.merchant_suggested_asin[0].value!==ASIN||
         payload.attributes.purchasable_offer[0].our_price[0].schedule[0].value_with_tax!==35||
         payload.attributes.condition_type[0].value!=="new_new"||
         Object.keys(payload.attributes).sort().join(",")!=="condition_type,fulfillment_availability,merchant_suggested_asin,purchasable_offer"){
        metrics.provider_mutations++;return fail("BAD_PREVIEW_REQUEST");
      }
      for(const rows of Object.values(payload.attributes) as Array<Array<Record<string,unknown>>>)
        if(rows[0].marketplace_id!==marketId)return fail("PAYLOAD_MARKET_MISMATCH");
      if(mode==="preview_http403")return json({errors:[{message:"SYNTHETIC_PRIVATE_ERROR_CANARY"}]},403);
      if(mode==="preview_redirect")return new Response(null,{status:302,headers:{Location:"https://private.invalid/CANARY"}});
      const invalid=mode==="invalid",warning=mode==="warning";
      return json({sku:SKU,status:mode==="accepted"?"ACCEPTED":invalid?"INVALID":"VALID",
        submissionId:"SYNTHETIC-SUBMISSION-001",
        issues:invalid||warning?[{code:warning?"100708":"90220",severity:warning?"WARNING":"ERROR",
          categories:["MISSING_ATTRIBUTE"],attributeNames:["merchant_shipping_group"],
          message:"SYNTHETIC_PRIVATE_MESSAGE_CANARY",enforcements:{arbitrary:"SYNTHETIC_PRIVATE_CANARY"}}]:[],
        unexpected:"SYNTHETIC_PRIVATE_CANARY"});
    }
    if(req.method!=="GET"){metrics.provider_mutations++;return fail("AMAZON_MUTATION");}
    metrics.amazon_reads++;
    if(url.pathname==="/catalog/2022-04-01/items"){
      if(url.searchParams.get("identifiers")!==EAN||url.searchParams.get("identifiersType")!=="EAN"||
         url.searchParams.get("includedData")!=="identifiers")return fail("BAD_CATALOG_SEARCH");
      return json({numberOfResults:1,items:[{asin:ASIN,identifiers:[{
        marketplaceId:marketId,identifiers:[{identifierType:"EAN",identifier:EAN}]
      }]}]});
    }
    if(url.pathname==="/catalog/2022-04-01/items/"+ASIN)return json({
      asin:ASIN,summaries:[{marketplaceId:marketId,brand:"Synthetic Brand",itemClassification:"BASE_PRODUCT"}],
      productTypes:[{marketplaceId:marketId,productType:"HANDBAG"}],images:[],
      attributes:{color:[{value:"Black"}]}
    });
    if(url.pathname==="/listings/2021-08-01/items/"+SELLER+"/"+SKU){
      if(mode==="existing_sku")return json({sku:SKU,summaries:[{marketplaceId:marketId,asin:ASIN}]});
      return json({errors:[{code:"NOT_FOUND",message:"SYNTHETIC_PRIVATE_CANARY"}]},404,{"x-amzn-requestid":"SYNTHETIC-REQUEST-001"});
    }
    if(url.pathname==="/listings/2021-08-01/items/"+SELLER){
      if(mode==="existing_asin")return json({numberOfResults:1,items:[{sku:"SYNTHETIC_OTHER_SKU",
        summaries:[{marketplaceId:marketId,asin:ASIN}]}]});
      return json({numberOfResults:0,items:[]});
    }
    if(url.pathname==="/listings/2021-08-01/restrictions")return json({
      restrictions:mode==="restricted"?[{marketplaceId:marketId,reasons:[{message:"SYNTHETIC_PRIVATE_CANARY"}]}]:[]
    });
    if(url.pathname==="/definitions/2020-09-01/productTypes/PRODUCT")return json({
      productType:"PRODUCT",marketplaceIds:[marketId],requirements:"LISTING_OFFER_ONLY",requirementsEnforced:"ENFORCED",
      schema:{checksum:"c3ludGhldGljLXRlc3QxMg==",
        link:{resource:"https://synthetic.s3.amazonaws.com/schema.json?SYNTHETIC_PRIVATE_CANARY",verb:"GET"}},
      productTypeVersion:{version:"SYNTHETIC-VERSION",latest:true,releaseCandidate:false}
    });
  }
  return fail("UNMOCKED_NETWORK_FORBIDDEN");
};

export default {async fetch(req:Request,env:Record<string,unknown>,ctx:ExecutionContext){
  mode=req.headers.get("x-fixture-mode")||"";
  metrics={shopify_reads:0,amazon_reads:0,token_requests:0,preview_requests:0,provider_mutations:0,
    storage_writes:0,storage_deletes:0,unmocked_requests:0};paths=[];
  const runtimeEnv={...env,SHOPIFY_TOKENS_KV:{
    get:async(key:string)=>kv.get(key)??null,
    put:async(key:string,value:string,options:{expirationTtl:number})=>{
      if(!key.startsWith("mare-business:plan:")||options.expirationTtl!==86400)
        throw new Error("UNEXPECTED_PRIVATE_STORE_WRITE");
      metrics.storage_writes++;kv.set(key,value);
    },
    delete:async()=>{metrics.storage_deletes++;throw new Error("UNEXPECTED_PRIVATE_STORE_DELETE");}
  }};
  if(mode==="disabled")runtimeEnv.AMAZON_OFFER_PREVIEW_ENABLED="false";
  if(mode==="unconfigured")delete runtimeEnv.AMAZON_SP_API_REFRESH_TOKEN;
  if(mode==="unbound")delete (runtimeEnv as Record<string,unknown>).SHOPIFY_TOKENS_KV;
  const response=await worker.fetch(req,runtimeEnv as never,ctx);
  const result=await response.json();
  const retainedPrivateData=[...kv.values()].some(v=>v.includes("CANARY"));
  return json({status:response.status,result,metrics,paths,retained_private_data:retainedPrivateData},response.status);
}};
