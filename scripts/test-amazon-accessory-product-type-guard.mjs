import assert from "node:assert/strict";
import {build} from "esbuild";
const built=await build({entryPoints:["src/marketplace-amazon-new-asin-research.ts"],
 bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {researchAmazonNewAsinProductType:research}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
const SKU="MC2_BOX0023_03765I",EAN="8057338641070",MARKET="APJ6JRA9NG5V4";
const req={marketplace:"IT",sku:SKU};
const env={AMAZON_SP_API_SELLER_ID:"A1234567891234"};
const shops=(category,title)=>({
 ok:true,truncated:false,complete_variant_pagination:true,inline_product_count:1,product_count:1,
 products:[{title,vendor:"MC2 Saint Barth",product_type:category,status:"ACTIVE",media_count:2,
   variants:[{sku:SKU,barcode:EAN,id:"gid://shopify/ProductVariant/52554617454933",
     inventory_quantity:5,inventory_tracked:true,inventory_levels_complete:true,price:"99.90"}]}]
});
const cases=[
 {category:"Pochette e Borselli",title:"Christmas Box Red Velvet",types:["ABIS_MUSIC"],rejected:["ABIS_MUSIC"],remaining:[],status:"PRODUCT_TYPE_CATEGORY_REVIEW_REQUIRED"},
 {category:"Borsoni e Valigie",title:"Spritz Carry-on",types:["TABLETOP_GAME","APPAREL"],rejected:["TABLETOP_GAME","APPAREL"],remaining:[],status:"PRODUCT_TYPE_CATEGORY_REVIEW_REQUIRED"},
 {category:"Borse",title:"Borsa Colette In Lino Panna",types:["ABIS_MUSIC","HANDBAG"],rejected:["ABIS_MUSIC"],remaining:["HANDBAG"],status:"PRODUCT_TYPE_SELECTION_REQUIRED"},
 {category:"Borse",title:"Borsa Colette In Lino Panna",types:["HANDBAG"],rejected:[],remaining:["HANDBAG"],status:"PRODUCT_TYPE_SELECTION_REQUIRED"},
 {category:"Musica",title:"Musica fisica",types:["ABIS_MUSIC"],rejected:[],remaining:["ABIS_MUSIC"],status:"PRODUCT_TYPE_SELECTION_REQUIRED"},
];
for(const c of cases){
 const requests=[];
 const deps={
  clock:()=>Date.parse("2026-10-22T19:09:18.000Z"),
  readShopify:async()=>shops(c.category,c.title),
  readListing:async()=>({ok:true,marketplace:"IT",can_change_stock:false,
    provider_mutations:0,results:[{sku:SKU,state:"VERIFIED_ABSENT"}]}),
  readCatalogMatch:async()=>({ok:true,result:{marketplace:"IT",complete:true,
    identifiers:[{ean:EAN,state:"NO_EXACT_MATCH",exact_match_count:0,asins:[]}]}}),
  getAccessToken:async()=>"mock-token",
  fetch:async(url,options)=>{
    const u=new URL(url);requests.push(u.pathname);
    assert.equal(options.method,"GET");
    assert.equal(options.redirect,"manual");
    assert.equal(u.pathname,"/definitions/2020-09-01/productTypes");
    assert.equal(u.searchParams.get("itemName"),c.title);
    return new Response(JSON.stringify({productTypes:c.types.map(name=>({
      name,displayName:name,marketplaceIds:[MARKET]
    }))}),{status:200,headers:{"content-type":"application/json"}});
  },
 };
 const result=await research(req,env,deps);
 assert.equal(result.status,c.status,c.title);
 assert.equal(result.ok,true);
 assert.deepEqual(result.rejected_unrelated_product_type_names,c.rejected);
 assert.deepEqual(result.product_type_candidates.map(x=>x.name),c.remaining);
 assert.equal(result.candidate_count,c.remaining.length);
 assert.equal(result.title_category_conflict_detected,c.rejected.length>0);
 assert.equal(result.shopify_category_is_manual_review_evidence_only,true);
 assert.equal(result.provider_mutations,0);
 assert.equal(result.can_publish,false);
 assert.equal(result.product_creation_writer_implemented,false);
 assert.equal(result.brand_authorization_proven,false);
 assert.equal(result.gpsr_compliance_proven,false);
 assert.equal(requests.length,1,"No guessed Product Type schema calls");
 if(c.rejected.length){
  const explicit=await research({...req,product_type:c.rejected[0]},env,deps);
  assert.equal(explicit.ok,false);
  assert.equal(explicit.blocker,"item_name_product_type_conflicts_with_shopify_category");
  assert.equal(requests.length,2,"Must not attempt to fetch schema for a rejected product type");
 }
}
console.log("PASS Amazon accessory PTD guard: block ABIS_MUSIC/TABLETOP_GAME and luggage APPAREL; allow HANDBAG review");
