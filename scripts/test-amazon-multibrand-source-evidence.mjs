import assert from "node:assert/strict";
import {build} from "esbuild";
const b=await build({entryPoints:["src/marketplace-amazon-generic-ean-preview.ts"],
  bundle:true,format:"esm",platform:"neutral",write:false,logLevel:"silent"});
const {merchantMultibrandEvidenceAttrs:derive}=await import(
  "data:text/javascript;base64,"+Buffer.from(b.outputFiles[0].text).toString("base64"));
const market="APJ6JRA9NG5V4";
const keys=["model_name","department","age_range_description","color","manufacturer",
"item_type_name","fabric_type","outer","water_resistance_level","closure",
"style","batteries_required","care_instructions","list_price","bullet_point",
"weave_type","special_size_type","item_package_dimensions","item_package_weight",
"supplier_declared_dg_hz_regulation"];
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
const socks={vendor:"Ecoalf",title:"Calze Mountain Medium Grey Melange",
  productType:"Calze",description:"Modello: Mountain Socks Genere: Unisex "+
    "Colore: Medium Grey Melange Codice modello: MCUACSXMOUNT0697W26"};
const sockAttrs=derive(socks,{compareAtPrice:"19.90",
  inventoryItem:{countryCodeOfOrigin:null}},
  "ECO_MCUACSXMOUNT0697W26_339_4146","SOCKS","IT",market,
  [...keys,"country_of_origin"]);
assert.equal(sockAttrs.country_of_origin[0].value,"ES");

const sizeResearch={
  ptd_size_shapes_are_read_only:true,
  ptd_size_shapes_not_schema_validation:true,
  ptd_size_mapping_not_performed:true,
  ptd_size_shapes:{apparel_size:{type:"array",items:{type:"object",
    properties:{size:{type:"string"},size_to:{type:"string"},
      size_class:{type:"string",enum:["numeric","alpha"]},
      size_system:{type:"string",enum:["as6"]}},
    required:["size","size_class","size_system"]}}}
};
const exactSock=derive(socks,{compareAtPrice:"19.90",
  selectedOptions:[{name:"Taglia",value:"41-46"}],
  inventoryItem:{countryCodeOfOrigin:"ES"}},
  "ECO_MCUACSXMOUNT0697W26_339_4146","SOCKS","IT",market,
  [...keys,"country_of_origin","apparel_size","target_gender"],sizeResearch);
assert.deepEqual(exactSock.apparel_size,[{size:"41",size_to:"46",
  size_class:"numeric",size_system:"as6",marketplace_id:market}]);
assert.equal(exactSock.target_gender[0].value,"unisex");
assert.equal(exactSock.weave_type[0].value,"Maglia");
assert.equal(exactSock.style[0].value,"Sportivo");
assert.equal(exactSock.special_size_type[0].value,"Standard");
assert.equal(exactSock.supplier_declared_dg_hz_regulation[0].value,"not_applicable");
assert.equal(exactSock.item_package_weight[0].value,0.2);
assert.equal(exactSock.item_package_dimensions[0].length.value,25);
assert.equal(exactSock.item_package_dimensions[0].width.value,18);
assert.equal(exactSock.item_package_dimensions[0].height.value,4);
const noPtd=derive(socks,{compareAtPrice:"19.90",
  selectedOptions:[{name:"Taglia",value:"41-46"}]},
  "ECO_MCUACSXMOUNT0697W26_339_4146","SOCKS","IT",market,
  [...keys,"apparel_size"],{});
assert.equal(noPtd.apparel_size,undefined);
const unsafeRange=derive(socks,{compareAtPrice:"19.90",
  selectedOptions:[{name:"Taglia",value:"25-60"}]},
  "ECO_MCUACSXMOUNT0697W26_339_4146","SOCKS","IT",market,
  [...keys,"apparel_size"],sizeResearch);
assert.equal(unsafeRange.apparel_size,undefined);

assert.equal(sockAttrs.fabric_type[0].value,
  "30% poliammide riciclata / 30% lana riciclata / "+
  "30% TENCEL Lyocell / 10% cashmere riciclato");
assert.equal(sockAttrs.color[0].value,"Medium Grey Melange");
assert.equal(sockAttrs.model_name[0].value,"Mountain Socks");
assert.equal(sockAttrs.list_price[0].value_with_tax,19.9);
const conflicting=derive(socks,{compareAtPrice:"19.90",
  inventoryItem:{countryCodeOfOrigin:"CN"}},
  "ECO_MCUACSXMOUNT0697W26_339_4146","SOCKS","IT",market,
  [...keys,"country_of_origin"]);
assert.equal(conflicting.country_of_origin,undefined,
  "Never override a conflicting Shopify origin declaration");
assert.equal(derive(socks,variant,
  "ECO_MCUACSXMOUNT0697W25_339_4146","SOCKS","IT",market,
  [...keys,"country_of_origin"]).country_of_origin,undefined,
  "AW26 evidence must not leak to other seasons");
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
