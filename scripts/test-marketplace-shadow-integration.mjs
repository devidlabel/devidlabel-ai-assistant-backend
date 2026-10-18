import assert from "node:assert/strict";
import {build} from "esbuild";

/** Cross-feature integration gate for the Marketplace Core shadow release.
 * Does not call a provider, mutate inventory or access production tokens.
 */
const r=await build({
  entryPoints:["src/mare-business-capabilities.ts"],bundle:true,write:false,
  platform:"neutral",format:"esm",logLevel:"silent"
});
const {buildMareBusinessCapabilities}=await import(
  "data:text/javascript;base64,"+
  Buffer.from(r.outputFiles[0].text).toString("base64")
);
const cfg={
  MARE_BUSINESS_ACCESS_TOKEN:"SYNTHETIC_AUTH",
  AMAZON_SP_API_REFRESH_TOKEN:"SYNTHETIC_REFRESH",
  AMAZON_SP_API_CLIENT_ID:"SYNTHETIC_CLIENT",
  AMAZON_SP_API_CLIENT_SECRET:"SYNTHETIC_SECRET",
  AMAZON_SP_API_SELLER_ID:"A123456789",
  SHOPIFY_SHOP_DOMAIN:"synthetic-store.myshopify.com",
  SHOPIFY_TOKENS_KV:{get:async()=>null}
};
const capabilities=buildMareBusinessCapabilities(cfg);
const ids=[
  "amazon.catalog.exact.match",
  "amazon.catalog.asin.details",
  "amazon.seller.listings.direct",
  "amazon.offer.preflight",
  "amazon.orders.observe.readonly",
  "shopify.marketplace.scopes.readonly",
  "shopify.marketplace.amazon_order_adoption.readonly",
  "shopify.marketplace.amazon_order_lines.readonly"
];
for(const id of ids){
  const c=capabilities.find(x=>x.id===id);
  assert(c,"Missing marketplace read-only capability: "+id);
  assert.equal(c.available,true,id+" unavailable with synthetic configuration");
  assert.equal(c.operation,"read",id+" unexpectedly sends provider writes");
  assert.equal(c.risk,"read_only");
  assert.equal(c.approval,"none");
}
const withoutSeller=buildMareBusinessCapabilities({
  ...cfg,AMAZON_SP_API_SELLER_ID:""
});
for(const id of ["amazon.seller.listings.direct","amazon.offer.preflight",
                 "amazon.orders.observe.readonly"]) {
  const c=withoutSeller.find(x=>x.id===id);
  assert.equal(c.available,false);
  assert(c.missing.includes("AMAZON_SP_API_SELLER_ID"));
}
const withoutShopify=buildMareBusinessCapabilities({
  ...cfg,SHOPIFY_TOKENS_KV:undefined
});
for(const id of ["shopify.marketplace.scopes.readonly",
  "shopify.marketplace.amazon_order_adoption.readonly",
  "shopify.marketplace.amazon_order_lines.readonly",
  "amazon.offer.preflight"]) {
  const c=withoutShopify.find(x=>x.id===id);
  assert.equal(c.available,false);
}
const liveListings=capabilities.find(x=>x.id==="amazon.listings.sync");
assert(liveListings);
assert.equal(liveListings.implemented,false);
assert.equal(liveListings.available,false);
assert(!capabilities.some(x=>/^amazon\.(order\.create|orders\.import|inventory\.write|tracking\.confirm)$/i.test(x.id)&&x.available));
console.log("PASS Marketplace shadow integration: Amazon and Shopify readers present, seller/Shopify configuration gates, NO live order/listing/inventory/tracking writer");
