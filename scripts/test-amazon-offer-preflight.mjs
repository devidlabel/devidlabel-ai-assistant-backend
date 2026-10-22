import assert from "node:assert/strict";
import { build } from "esbuild";

/** Entire entrypoint is bundled: the positive case uses the real COMPLETE Shopify
 * reader with mocked Shopify GraphQL transport, not a fabricated read result. */
const compiled = await build({
  entryPoints: ["src/mare-business-amazon-offer-preflight.ts"],
  bundle: true, write: false, platform: "neutral", format: "esm", logLevel: "silent"
});
const { readAmazonOfferOnlyPreflight } = await import(
  "data:text/javascript;base64," +
  Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const mkEan = prefix => {
  const sum = [...prefix].reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return prefix + String((10 - sum % 10) % 10);
};
const input = {
  marketplace:"IT", sku:"TEST_OFFER_001", ean:mkEan("200000000123"), asin:"B0TEST0001"
};
const marketId = "APJ6JRA9NG5V4";
const env = {
  AMAZON_SP_API_CLIENT_ID:"synthetic-id",
  AMAZON_SP_API_CLIENT_SECRET:"synthetic-secret",
  AMAZON_SP_API_REFRESH_TOKEN:"synthetic-refresh",
  AMAZON_SP_API_SELLER_ID:"A123456789",
  SHOPIFY_SHOP_DOMAIN:"synthetic-store.myshopify.com",
  SHOPIFY_ADMIN_ACCESS_TOKEN:"synthetic-shopify-token",
  SHOPIFY_API_VERSION:"2025-10"
};
const shopifyProduct = (overrides={}) => ({
  id:"gid://shopify/Product/111", vendor:"Example Brand", status:"ACTIVE",
  productType:"Accessory", title:"Synthetic Accessory", collections:{
    pageInfo:{hasNextPage:false},nodes:[]
  },media:{pageInfo:{hasNextPage:false},nodes:[]},
  ...overrides
});
const rawVariant = (sku,barcode,index) => ({
  id:"gid://shopify/ProductVariant/"+String(index),
  sku,barcode,price:"35.00",inventoryQuantity:3,availableForSale:true,
  selectedOptions:[{name:"Color",value:"Black"}],
  inventoryItem:{id:"gid://shopify/InventoryItem/"+String(index),
    tracked:true,inventoryLevels:{pageInfo:{hasNextPage:false},nodes:[{
      id:"gid://shopify/InventoryLevel/"+index,
      location:{id:"gid://shopify/Location/1",name:"Synthetic warehouse"},
      quantities:[{name:"available",quantity:3}]
    }]}}
});
const targetRaw = rawVariant(input.sku,input.ean,21);
const first20 = Array.from({length:20},(_,i)=>rawVariant("OTHER_"+i,mkEan("2000000"+String(i).padStart(5,"0")),i+1));
const syntheticNode = shopifyProduct({
  variants:{pageInfo:{hasNextPage:true,endCursor:"variant-cursor-20"},nodes:first20}
});
const mappedVariant = (raw=targetRaw,extra={}) => ({
  id:raw.id, sku:raw.sku, barcode:raw.barcode,
  price:raw.price, inventory_quantity:raw.inventoryQuantity,
  inventory_tracked:true, inventory_levels_complete:true,
  inventory_levels:[{location_id:"gid://shopify/Location/1",quantities:[{name:"available",quantity:3}]}],
  selected_options:raw.selectedOptions,...extra
});
const stubResult = (type,variant=mappedVariant(),extras={}) => ({
  ok:true,product_count:1,inline_product_count:1,
  truncated:false,complete_variant_pagination:true,
  products:[{vendor:"Example Brand",status:"ACTIVE",
    variants: [variant]}],...extras
});
const shopifyStub = async args => stubResult(args.query.startsWith("barcode:") ? "barcode":"sku");
const matchStub = async()=>({
  ok:true,result:{marketplace:"IT",complete:true,identifiers:[
    {ean:input.ean,state:"EXACT_ONE",asins:[input.asin]}
  ]}
});
const detailsStub = async()=>({
  ok:true,marketplace:"IT",results:[{
    state:"READ_ONLY_DETAILS_COMPLETE",asin:input.asin,brand:"Example Brand",
    product_types:["HANDBAG"],color:"Black",size:null,
    item_classification:"BASE_PRODUCT"
  }]
});
const json = (body,status=200,headers={}) =>
  new Response(JSON.stringify(body),{
    status,headers:{"content-type":"application/json",...headers}
  });
const original=globalThis.fetch;
let calls=[], graphqlCalls=0;
let listingResponse=()=>json({errors:[{code:"NOT_FOUND",message:"not found"}]},
  404,{"x-amzn-requestid":"synthetic-request-123"});
let asinSearchResponse=()=>json({numberOfResults:0,items:[]});
let definitionsResponse=()=>json({
  productType:"PRODUCT",marketplaceIds:[marketId],
  requirements:"LISTING_OFFER_ONLY",requirementsEnforced:"ENFORCED",
  schema:{checksum:"c3ludGhldGlj",link:{resource:"https://example.amazonaws.com/schema.json",verb:"GET"}},
  productTypeVersion:{version:"SYNTHETIC-VERSION",latest:true,releaseCandidate:false}
});
function installFetch(){
  globalThis.fetch=async (url,opts={})=>{
    const u=new URL(String(url));
    calls.push({url:u.toString(),method:opts.method || "GET"});
    if(u.pathname.endsWith("/graphql.json")){
      graphqlCalls++;
      assert.equal(opts.method,"POST");
      const body=JSON.parse(opts.body);
      if(body.query.includes("MareBusinessCatalogVariants")){
        assert.equal(body.variables.after,"variant-cursor-20");
        return json({data:{product:{variants:{
          pageInfo:{hasNextPage:false,endCursor:null},nodes:[targetRaw]
        }}}});
      }
      assert(body.query.includes("MareBusinessCatalogComplete"));
      assert(body.query.includes("sortKey: ID, reverse: false"));
      assert(/status:active,draft,archived,unlisted/.test(body.variables.query));
      assert(body.variables.query.startsWith('sku:"') ||
             body.variables.query.startsWith('barcode:"'));
      return json({data:{products:{
        pageInfo:{hasNextPage:false,endCursor:null},nodes:[syntheticNode]
      }}});
    }
    if(u.pathname==="/auth/o2/token")return json({access_token:"synthetic-lwa"});
    assert.equal(opts.method,"GET","No SP-API write is allowed");
    assert.equal(opts.headers["x-amz-access-token"],"synthetic-lwa");
    if(u.pathname==="/listings/2021-08-01/items/A123456789"){
      assert.equal(u.searchParams.get("identifiersType"),"ASIN");
      assert.equal(u.searchParams.get("identifiers"),input.asin);
      return asinSearchResponse();
    }
    if(u.pathname.startsWith("/listings/2021-08-01/items/"))return listingResponse();
    if(u.pathname==="/listings/2021-08-01/restrictions")return json({restrictions:[]});
    if(u.pathname.endsWith("/definitions/2020-09-01/productTypes/PRODUCT")){
      assert.equal(u.searchParams.get("requirements"),"LISTING_OFFER_ONLY");
      return definitionsResponse();
    }
    throw new Error("unexpected request: "+u.pathname);
  };
}
try {
  installFetch();
  const result = await readAmazonOfferOnlyPreflight(input,env,undefined,matchStub,detailsStub);
  assert.equal(result.ok,true);
  assert.equal(result.status,"REVIEW_REQUIRED");
  assert.equal(result.has_created_offer,false);
  assert.equal(result.live_listing_write_enabled,false);
  assert.equal(result.seller_listing_absence_result,"NOT_FOUND_VERIFIED_BY_LISTINGS_API");
  assert.equal(result.schema_version,"SYNTHETIC-VERSION");
  assert.equal(result.product_variant_id,targetRaw.id);
  assert.equal(graphqlCalls,4,"Must paginate all variants for both SKU and barcode searches");
  assert(calls.filter(x=>!x.url.includes("/graphql.json")&&!x.url.includes("/auth/o2/token"))
    .every(x=>x.method==="GET"),"Amazon must remain read-only");

  assert.equal(result.seller_asin_search_result,
    "NO_SELLER_ASIN_IN_BOUNDED_SEARCH");
  assert.equal(result.seller_asin_search_is_not_final_absence_proof,true);
  // A merchant-confirmed brand alias must unblock only the false identity
  // mismatch. It does NOT prove seller eligibility, approval, GPSR or live PUT.
  const withVendor=(name)=>async()=>{
    const original=await shopifyStub({query:'sku:"TEST_OFFER_001"'});
    return {...original,products:original.products.map(p=>({...p,vendor:name}))};
  };
  const withAmazonBrand=(name)=>async()=>{
    const original=await detailsStub();
    return {...original,results:original.results.map(x=>({...x,brand:name}))};
  };
  const brandInputs=[
    ["Back70","Back 70 Streetwear","MERCHANT_CONFIRMED_MAPPING"],
    ["County Of Milan","County Of Milan","MERCHANT_CONFIRMED_MAPPING"],
    ["Example Brand","Example Brand","SHOPIFY_VENDOR_UNVERIFIED"],
  ];
  for(const [shopifyName,amazonName,mappingSource] of brandInputs){
    const branded=await readAmazonOfferOnlyPreflight(input,env,
      withVendor(shopifyName),matchStub,withAmazonBrand(amazonName));
    assert.equal(branded.ok,true,shopifyName);
    assert.equal(branded.status,"REVIEW_REQUIRED");
    assert.equal(branded.amazon_brand_expected,amazonName);
    assert.equal(branded.brand_mapping_source,mappingSource);
    assert.equal(branded.brand_eligibility_proven,false);
    assert.equal(branded.has_created_offer,false);
    assert.equal(branded.live_listing_write_enabled,false);
  }
  const callsBeforeBrandMismatch=calls.length;
  const counterfeit=await readAmazonOfferOnlyPreflight(input,env,
    withVendor("Back70"),matchStub,withAmazonBrand("Unrelated Brand"));
  assert.equal(counterfeit.status,"BLOCKED_CATALOG_ATTRIBUTES");
  assert.equal(counterfeit.blocker,"brand_asin_or_product_type_mismatch");
  assert.equal(calls.length,callsBeforeBrandMismatch,
    "Wrong brand must stop before direct Amazon seller listing GET");
  const improperShortName=await readAmazonOfferOnlyPreflight(input,env,
    withVendor("Back70"),matchStub,withAmazonBrand("Back70"));
  assert.equal(improperShortName.status,"BLOCKED_CATALOG_ATTRIBUTES");
  assert.equal(improperShortName.blocker,"brand_asin_or_product_type_mismatch");
  asinSearchResponse=()=>json({numberOfResults:1,items:[{
    sku:"LEGACY_CHANNABLE_SKU",summaries:[{
      marketplaceId:marketId,asin:input.asin,productType:"HANDBAG"
    }]
  }]});
  const asinAlreadyListed=await readAmazonOfferOnlyPreflight(input,env,
    shopifyStub,matchStub,detailsStub);
  assert.equal(asinAlreadyListed.status,"BLOCKED_EXISTING_OFFER");
  assert.equal(asinAlreadyListed.blocker,"seller_has_asin_under_other_sku");
  asinSearchResponse=()=>json({numberOfResults:2,items:[]});
  const inconclusiveAsin=await readAmazonOfferOnlyPreflight(input,env,
    shopifyStub,matchStub,detailsStub);
  assert.equal(inconclusiveAsin.status,"BLOCKED_LISTING_STATUS_UNKNOWN");
  assert.equal(inconclusiveAsin.blocker,
    "seller_asin_search_incomplete_or_unverified");
  asinSearchResponse=()=>json({numberOfResults:0,items:[]});

  // EU locales must not create false color/one-size conflicts.
  const sizeColorReader=async()=>stubResult("sku",
    mappedVariant(targetRaw,{selected_options:[
      {name:"Color",value:"Black"},{name:"Size",value:"One Size"}
    ]}));
  const localizedDetails=async()=>({...await detailsStub(),results:[{
    state:"READ_ONLY_DETAILS_COMPLETE",asin:input.asin,
    brand:"Example Brand",product_types:["HANDBAG"],
    color:"Nero",size:"Einheitsgröße",item_classification:"BASE_PRODUCT"
  }]});
  const translated=await readAmazonOfferOnlyPreflight(input,env,
    sizeColorReader,matchStub,localizedDetails);
  assert.equal(translated.status,"REVIEW_REQUIRED");
  const coalReader=async()=>stubResult("sku",
    mappedVariant(targetRaw,{selected_options:[
      {name:"Color",value:"Coal"}
    ]}));
  const wrongShade=await readAmazonOfferOnlyPreflight(input,env,
    coalReader,matchStub,localizedDetails);
  assert.equal(wrongShade.status,"BLOCKED_CATALOG_ATTRIBUTES");
  assert.equal(wrongShade.blocker,"variant_attributes_mismatch");

  // A bogus status flag on the original legacy reader must not count as complete.
  await assert.rejects(()=>readAmazonOfferOnlyPreflight(input,env,
    async()=>({ok:true,truncated:false,product_count:1,inline_product_count:1,
      products:[{status:"ACTIVE",variants:[mappedVariant()]}]}),matchStub,detailsStub),
    /amazon_offer_preflight_shopify_incomplete/);

  const bad=[{...input,sku:"bad\nsku"},{...input,ean:"1234567890123"},
    {...input,permission:"approved"},{...input,marketplace:"US"}];
  const before=calls.length;
  for(const obj of bad)await assert.rejects(
    ()=>readAmazonOfferOnlyPreflight(obj,env,shopifyStub,matchStub,detailsStub));
  assert.equal(calls.length,before);

  const missingSeller=await readAmazonOfferOnlyPreflight(input,
    {...env,AMAZON_SP_API_SELLER_ID:""},shopifyStub,matchStub,detailsStub);
  assert.equal(missingSeller.status,"BLOCKED_CONFIG");

  const duplicate=await readAmazonOfferOnlyPreflight(input,env,
    async args=>({...stubResult(),products:[{status:"ACTIVE",vendor:"Example Brand",
      variants:[mappedVariant(),mappedVariant(targetRaw,{id:"gid://shopify/ProductVariant/100"})]}]}),
    matchStub,detailsStub);
  assert.equal(duplicate.status,"BLOCKED_SHOPIFY_IDENTITY");

  const duplicateBarcode=await readAmazonOfferOnlyPreflight(input,env,
    async args=>args.query.startsWith("sku:")?stubResult():{
      ...stubResult(),products:[{status:"ACTIVE",vendor:"Example Brand",variants:[
        mappedVariant(),mappedVariant(targetRaw,{id:"gid://shopify/ProductVariant/900"})
      ]}]},matchStub,detailsStub);
  assert.equal(duplicateBarcode.blocker,"ean_missing_or_duplicated");

  for(const invalidQty of [true,"1",1.2,null,-1,0]){
    const badQty=await readAmazonOfferOnlyPreflight(input,env,
      async()=>stubResult("sku",mappedVariant(targetRaw,{inventory_quantity:invalidQty})),
      matchStub,detailsStub);
    assert.equal(badQty.status,"BLOCKED_SHOPIFY_ELIGIBILITY");
  }
  const inventoryIncomplete=await readAmazonOfferOnlyPreflight(input,env,
    async()=>stubResult("sku",mappedVariant(targetRaw,{inventory_levels_complete:false})),
    matchStub,detailsStub);
  assert.equal(inventoryIncomplete.status,"BLOCKED_SHOPIFY_ELIGIBILITY");

  const truncated=async()=>({...stubResult(),truncated:true});
  await assert.rejects(()=>readAmazonOfferOnlyPreflight(input,env,
    truncated,matchStub,detailsStub),/shopify_incomplete/);

  const noExact=await readAmazonOfferOnlyPreflight(input,env,shopifyStub,
    async()=>({ok:true,result:{marketplace:"IT",complete:true,identifiers:[
      {ean:input.ean,state:"NO_EXACT_MATCH",asins:[]}]}}),detailsStub);
  assert.equal(noExact.status,"BLOCKED_CATALOG_MATCH");

  const parent=await readAmazonOfferOnlyPreflight(input,env,shopifyStub,matchStub,
    async()=>({ok:true,marketplace:"IT",results:[{
      state:"READ_ONLY_DETAILS_COMPLETE",asin:input.asin,brand:"Example Brand",
      product_types:["HANDBAG"],item_classification:"VARIATION_PARENT"}]}));
  assert.equal(parent.blocker,"parent_asin_not_sellable_variant");
  const badColor=await readAmazonOfferOnlyPreflight(input,env,shopifyStub,matchStub,
    async()=>({ok:true,marketplace:"IT",results:[{
      state:"READ_ONLY_DETAILS_COMPLETE",asin:input.asin,brand:"Example Brand",
      product_types:["HANDBAG"],color:"Yellow"}]}));
  assert.equal(badColor.blocker,"variant_attributes_mismatch");

  // A verified EAN can still point to an incorrectly classified Amazon page.
  // A Shopify pochette must never pass preflight on an Amazon LABEL ASIN.
  const bagReader=async args=>{
    const row=await shopifyStub(args);
    return {...row,products:row.products.map(p=>({
      ...p,product_type:"Pochette e Borselli"
    }))};
  };
  const catalogLabel=async()=>{
    const details=await detailsStub();
    return {...details,results:details.results.map(d=>({
      ...d,product_types:["LABEL"]
    }))};
  };
  const beforeCategoryCheck=calls.length;
  const wrongCategory=await readAmazonOfferOnlyPreflight(input,env,
    bagReader,matchStub,catalogLabel);
  assert.equal(wrongCategory.status,"BLOCKED_CATALOG_ATTRIBUTES");
  assert.equal(wrongCategory.blocker,
    "amazon_product_type_incompatible_with_shopify_category");
  assert.equal(calls.length,beforeCategoryCheck,
    "Known category mismatch must block before any Amazon Listings call");

  installFetch(); listingResponse=()=>json({sku:input.sku});
  const exists=await readAmazonOfferOnlyPreflight(input,env,shopifyStub,matchStub,detailsStub);
  assert.equal(exists.status,"BLOCKED_EXISTING_OFFER");

  for (const ambiguous of [
    ()=>json({unexpected:"routing error"},404,{"x-amzn-requestid":"id1"}),
    ()=>json({errors:[{code:"NOT_FOUND"}]},404),
    ()=>new Response("<html>error</html>",{status:404,headers:{"content-type":"text/html","x-amzn-requestid":"id2"}}),
    ()=>json({errors:[{code:"INVALID_REQUEST"}]},404,{"x-amzn-requestid":"id3"})
  ]){
    listingResponse=ambiguous;
    const unknown=await readAmazonOfferOnlyPreflight(input,env,shopifyStub,matchStub,detailsStub);
    assert.equal(unknown.status,"BLOCKED_LISTING_STATUS_UNKNOWN");
  }
  for (const code of [403,429,500]){
    listingResponse=()=>json({errors:[{code:"BAD"}]},code);
    await assert.rejects(()=>readAmazonOfferOnlyPreflight(input,env,
      shopifyStub,matchStub,detailsStub),new RegExp("amazon_offer_preflight_http_"+code));
  }

  listingResponse=()=>json({errors:[{code:"NOT_FOUND"}]},404,{"x-amzn-requestid":"id4"});
  definitionsResponse=()=>json({productType:"PRODUCT",schema:{link:{resource:"https://example.amazonaws.com/schema",verb:"GET"}},
    productTypeVersion:"1"});
  const schemaInvalid=await readAmazonOfferOnlyPreflight(input,env,
    shopifyStub,matchStub,detailsStub);
  assert.equal(schemaInvalid.status,"BLOCKED_PRODUCT_TYPE");

  console.log("R0 Amazon Offer Only: complete Shopify GraphQL pagination, API evidence, strict guards and no writes passed");
} finally {
  globalThis.fetch=original;
}
