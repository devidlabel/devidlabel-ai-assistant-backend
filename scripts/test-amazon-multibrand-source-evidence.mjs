import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {merchantMultibrandEvidenceAttrs:derive}=await import(
  "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const market="APJ6JRA9NG5V4";
const keys=["model_name","department","age_range_description","color","manufacturer",
"item_type_name","fabric_type","outer","water_resistance_level","closure",
"style","batteries_required","care_instructions","list_price","bullet_point"];
const eco={vendor:"Ecoalf",title:"Giacca Nizo Olive",productType:"Giacche e cappotti",
  description:"La Giacca Nizo Ecoalf nella variante Olive fa parte della collezione. "+
  "Modello: Nizo Genere: Uomo Colore: Olive Codice modello: MCMGAJKNIZO00188W26. "+
  "Tessuto principale: 100% cotone riciclato. Fodera: 100% poliammide riciclata. "+
  "Tasche frontali e chiusura frontale con zip. Il brand è attento a materiali riciclati."};
const variant={compareAtPrice:"229.90"};
const a=derive(eco,variant,"ECO_MCMGAJKNIZO00188W26_128_S","COAT","IT",market,keys);
assert.equal(a.color[0].value,"Olive");
assert.equal(a.model_name[0].value,"Nizo");
assert.equal(a.department[0].value,"Uomo");
assert.equal(a.fabric_type[0].value,"100% cotone");
assert.equal(a.outer[0].material[0].value,"100% cotone");
assert.equal(a.list_price[0].value_with_tax,229.9);
assert.equal(a.manufacturer[0].value,"Ecoalf");
assert.equal(a.batteries_required[0].value,false);
for(const k of ["country_of_origin","gpsr_manufacturer_reference",
  "dsa_responsible_party_address","item_package_weight","item_package_dimensions",
  "fulfillment_availability","purchasable_offer"])assert.equal(a[k],undefined);
const col={vendor:"Colmar Originals",title:"Colmar Originals Gilet Uomo Ultra Leggero Nero",
  productType:"Gilet",description:"Questo gilet Colmar Originals da uomo ha tessuto esterno idrorepellente. "+
  "Chiusura frontale con zip. Esterno e fodera: 100% poliammide. "+
  "Imbottitura: 100% poliestere. Vestibilità regular per un uso casual."};
const cb=derive(col,{compareAtPrice:"159.00"},"COL_11000026_8VX_99_48",
  "COAT","IT",market,keys);
assert.equal(cb.fabric_type[0].value,"100% poliammide");
assert.equal(cb.manufacturer[0].value,"COLMAR");
assert.equal(cb.water_resistance_level[0].value,"water_resistant");
assert.equal(cb.color,undefined,"Do not invent color from product title");
assert.equal(cb.list_price[0].value_with_tax,159);
for(const [p,sku,mkt] of [[{...col,vendor:"Other Brand"},"COL_11000026_8VX_99_48","IT"],
  [col,"ECO_MCMGAJKNIZO00188W26_128_S","IT"],
  [col,"COL_11000026_8VX_99_48","DE"],
  [{...col,description:""},"COL_11000026_8VX_99_48","IT"]]){
  assert.deepEqual(derive(p,variant,sku,"COAT",mkt,market,keys),{});
}
assert.deepEqual(derive(col,variant,"COL_11000026_8VX_99_48",
  "COAT","IT",market,[]),{});
console.log("Colmar/Ecoalf exact-source descriptive attribute mapping passed.");
