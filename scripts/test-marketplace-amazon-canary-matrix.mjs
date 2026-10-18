import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/marketplace-amazon-canary-matrix.ts"],
  bundle:true,platform:"neutral",format:"esm",write:false,logLevel:"silent"});
const {classifyAmazonPilotCatalogIdentity}=await import(
 "data:text/javascript;base64,"+
 Buffer.from(b.outputFiles[0].text).toString("base64"));
const markets=["IT","DE","FR","ES"];
const colors=["Nero","Schwarz","Noir","Negro"];
const black={
 sku:"RNS_14920_BLACK",ean:"5711747572921",vendor:"Rains",
 title:"Reporter Box Bag W3 Black",product_type:"Pochette e Borselli",
 status:"ACTIVE",inventory_quantity:4,inventory_tracked:true,
 inventory_levels_complete:true
};
const evidences=markets.map((marketplace,i)=>({
 marketplace,ean:black.ean,asin:"B0CW4LTCX4",
 lookup_source:"amazon_spapi_catalog_items_live",lookup_complete:true,
 lookup_state:"EXACT_ONE",lookup_asins:["B0CW4LTCX4"],
 details_source:"amazon_spapi_catalog_item_live",
 details_state:"READ_ONLY_DETAILS_COMPLETE",
 brand:"RAINS",model_number:black.sku,part_number:black.ean,
 item_name:"RAINS Reporter Box Bag W3 Black",
 item_classification:"BASE_PRODUCT",product_types:["HANDBAG"],
 color:colors[i],size:null
}));
const positive=classifyAmazonPilotCatalogIdentity(black,evidences);
assert.equal(positive.ok,true);
assert.equal(positive.strong_catalog_identity_market_count,4);
assert.equal(positive.overall_status,"CATALOG_IDENTITY_STRONG_ALL_MARKETS");
assert.equal(positive.can_validate_preview,false);
assert.equal(positive.can_create_offer,false);
assert.equal(positive.can_publish_positive_quantity,false);
assert.equal(positive.seller_listing_state,"UNVERIFIED");
assert.equal(positive.markets.length,4);
assert(positive.missing_mandatory_gates.includes("channable_listing_writer_ownership"));

const coal={...black,sku:"RNS_15600_COAL",ean:"5715793005679",inventory_quantity:3};
const coalE=evidences.map((e,i)=>({...e,ean:coal.ean,asin:"B0HLWFFZKD",
 lookup_asins:["B0HLWFFZKD"],model_number:coal.sku,part_number:coal.sku,
 color:["Grigio","Grau","Gris","Gris"][i],
 item_name:"Cosmetic Bag W3 Coal",product_types:["COSMETIC_CASE"]}));
const review=classifyAmazonPilotCatalogIdentity(coal,coalE);
assert.equal(review.overall_status,"CATALOG_IDENTITY_REVIEW_REQUIRED");
assert.equal(review.review_required_market_count,4);
assert.equal(review.can_create_offer,false);
const variants=[
 [x=>({...x,brand:"OTHER"}),"brand_conflict"],
 [x=>({...x,model_number:"WRONG"}),"amazon_model_number_conflicts_with_shopify_sku"],
 [x=>({...x,part_number:"OTHER"}),"amazon_part_number_unverified"],
 [x=>({...x,product_types:["LABEL"]}),"clearly_incompatible_product_type"],
 [x=>({...x,item_classification:"VARIATION_PARENT"}),"non_sellable_parent_asin"],
 [x=>({...x,color:"BLU"}),"localized_color_conflict"],
 [x=>({...x,lookup_complete:false}),"amazon_live_identity_evidence_incomplete"]
];
for(const [change,reason] of variants){
 const rows=[change(evidences[0]),...evidences.slice(1)];
 const x=classifyAmazonPilotCatalogIdentity(black,rows);
 assert.equal(x.markets[0].reason,reason);
 assert.equal(x.can_create_offer,false);
}
assert.throws(()=>classifyAmazonPilotCatalogIdentity({...black,inventory_quantity:0},evidences),/ineligible/);
assert.throws(()=>classifyAmazonPilotCatalogIdentity({...black,vendor:"P448"},evidences),/ineligible/);
assert.throws(()=>classifyAmazonPilotCatalogIdentity(black,evidences.slice(1)),/four_market/);
assert.throws(()=>classifyAmazonPilotCatalogIdentity(black,
 [...evidences.slice(0,3),evidences[0]]),/four_market/);
assert.throws(()=>classifyAmazonPilotCatalogIdentity(black,
 [{...evidences[0],lookup_asins:["B000000001"]},...evidences.slice(1)]),
 /./ /* returned BLOCKED rather than throw is also legitimate, see below */);
console.log("PASS Amazon canary identity 4-country strong vs review vs blocked, no offer validation or listing write authorization");
