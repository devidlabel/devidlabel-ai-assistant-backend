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
  ptd_alpha_size_tokens:{apparel_size:["s","m","l","one_size"]},
  ptd_size_shapes:{apparel_size:{type:"array",items:{type:"object",
    properties:{size:{type:"string"},size_to:{type:"string"},
      size_class:{type:"string",enum:["numeric","alpha"]},
      size_system:{type:"string",enum:["as6"]},
      body_type:{type:"string",enum:["regular","petite"]},
      height_type:{type:"string",enum:["regular","tall"]}},
    required:["size","size_class","size_system"]}}}
};
const exactSock=derive(socks,{compareAtPrice:"19.90",
  selectedOptions:[{name:"Taglia",value:"41-46"}],
  inventoryItem:{countryCodeOfOrigin:"ES"}},
  "ECO_MCUACSXMOUNT0697W26_339_4146","SOCKS","IT",market,
  [...keys,"country_of_origin","apparel_size","target_gender"],sizeResearch);
assert.deepEqual(exactSock.apparel_size,[{size:"l",
  size_class:"alpha",size_system:"as6",body_type:"regular",height_type:"regular",
  marketplace_id:market}]);
assert.equal(exactSock.bullet_point.some(x=>x.value.includes("41-46")),true);
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
const maka={vendor:"Ecoalf",title:"Giacca Maka Black",
  productType:"Giacche e cappotti",description:"Giacca Maka Black. Genere: Donna."};
const makaAttrs=derive(maka,variant,"ECO_MCWGAJKMAKA00255W26_319_S",
  "COAT","IT",market,keys);
assert.equal(makaAttrs.fabric_type[0].value,"100% Poliestere riciclato");
assert.equal(makaAttrs.outer[0].material[0].value,"100% Poliestere riciclato");
assert.equal(makaAttrs.weave_type[0].value,"Tessuto tecnico");
assert.equal(makaAttrs.water_resistance_level[0].value,"waterproof");
assert.equal(makaAttrs.closure[0].type[0].value,"Zip e bottoni");
assert.equal(makaAttrs.special_size_type[0].value,"Standard");
assert.equal(makaAttrs.item_package_weight[0].value,1.1);
assert.equal(makaAttrs.item_package_dimensions[0].height.value,12);
assert.equal(makaAttrs.supplier_declared_dg_hz_regulation[0].value,
  "not_applicable");
assert.equal(makaAttrs.country_of_origin,undefined);
for(const [p,sku] of [[{...maka,title:"Giacca Maka Orange"},
  "ECO_MCWGAJKMAKA00255W26_319_S"],
  [maka,"ECO_MCWGAJKMAKA00255W26_604_S"],
  [{...maka,vendor:"Other Brand"},"ECO_MCWGAJKMAKA00255W26_319_S"]]){
  const x=derive(p,variant,sku,"COAT","IT",market,keys);
  assert.equal(x.item_package_dimensions,undefined);
  assert.equal(x.water_resistance_level,undefined);
}
const col={vendor:"Colmar Originals",title:"Colmar Originals Gilet Uomo Ultra Leggero Nero",
  productType:"Gilet",description:"Questo gilet Colmar Originals da uomo ha tessuto esterno idrorepellente. "+
  "Chiusura frontale con zip. Esterno e fodera: 100% poliammide. "+
  "Imbottitura: 100% poliestere. Vestibilità regular per un uso casual."};
const cb=derive(col,{compareAtPrice:"159.00"},"COL_11000026_8VX_99_48",
  "COAT","IT",market,keys);
assert.equal(cb.fabric_type[0].value,"100% poliammide");
assert.equal(cb.manufacturer[0].value,"COLMAR");
assert.equal(cb.water_resistance_level[0].value,"water_resistant");
assert.equal(cb.color[0].value,"Nero","Use the exact SKU/model/color merchant title evidence");
assert.equal(cb.model_name[0].value,"11000026");
const sizeCb=derive(col,{compareAtPrice:"159.00",selectedOptions:[{name:"Taglia",value:"48"}]},
  "COL_11000026_8VX_99_48","COAT","IT",market,keys);
assert.equal(sizeCb.special_size_type[0].value,"Standard");
const wrongColor=derive({...col,title:"Colmar Originals Gilet Uomo Ultra Leggero Blu"},
  {selectedOptions:[{name:"Taglia",value:"48"}]},
  "COL_11000026_8VX_99_48","COAT","IT",market,keys);
assert.equal(wrongColor.color,undefined,"Exact title guard required");
const wrongSize=derive(col,{selectedOptions:[{name:"Taglia",value:"50"}]},
  "COL_11000026_8VX_99_48","COAT","IT",market,keys);
assert.equal(wrongSize.special_size_type,undefined,"SKU and size must match");
const hybrid={vendor:"Colmar Originals",
  title:"Colmar Originals Giacca Uomo Ibrida Imbottita con Cappuccio Grigio Street",
  productType:"Giacche e cappotti",description:"Una giacca ibrida con cappuccio e zip."};
const h=derive(hybrid,{selectedOptions:[{name:"Taglia",value:"50"}]},
  "COL_11000050_8ZR_378_50","COAT","IT",market,keys);
assert.equal(h.color[0].value,"Grigio Street");
assert.equal(h.model_name[0].value,"11000050");
const provenanceKeys=[...keys,"country_of_origin","model_number","fit_type"];
const sourced=derive({...col,title:"Colmar Originals Piumino Uomo Opaco con Cappuccio Blu Navy"},
  {selectedOptions:[{name:"Taglia",value:"48"}],
   inventoryItem:{countryCodeOfOrigin:"RO"}},
  "COL_12000053R_4ZP_68_48","COAT","IT",market,provenanceKeys);
assert.equal(sourced.color[0].value,"Blu Navy");
assert.equal(sourced.country_of_origin[0].value,"RO");
assert.equal(sourced.model_number[0].value,"12000053R");
assert.equal(sourced.fit_type[0].value,"Regular");
const blockedOrigin=derive(col,
  {inventoryItem:{countryCodeOfOrigin:"ZZ"}},
  "COL_11000026_8VX_99_48","COAT","IT",market,provenanceKeys);
assert.equal(blockedOrigin.country_of_origin,undefined);
const noOrigin=derive(col,
  {inventoryItem:{countryCodeOfOrigin:null}},
  "COL_11000026_8VX_99_48","COAT","IT",market,provenanceKeys);
assert.equal(noOrigin.country_of_origin,undefined);
const doubleZip=derive({...hybrid,description:"Chiusura a doppia zip, cappuccio fisso."},
  {selectedOptions:[{name:"Taglia",value:"50"}]},
  "COL_11000050_8ZR_378_50","COAT","IT",market,provenanceKeys);
assert.equal(doubleZip.closure[0].type[0].value,"Zip");
const blendSource={...hybrid,description:"Materiali e composizione Esterno principale: "+
  "78% poliammide, 22% elastan; pannello secondario: 54% poliestere, "+
  "20% poliammide, 20% acrilico, 6% lana; fodera: 100% poliestere."};
const blended=derive(blendSource,variant,"COL_11000050_8ZR_378_50",
  "COAT","IT",market,provenanceKeys);
assert.equal(blended.fabric_type[0].value,"78% poliammide / 22% elastan");
assert.equal(blended.outer[0].material[0].value,blended.fabric_type[0].value);
const strippedHtml=derive({...blendSource,description:
  "ComposizioneEsterno principale: 78% poliammide, 22% elastan; "+
  "pannello secondario: 54% poliestere, 20% poliammide, 20% acrilico, 6% lana."},
  variant,"COL_11000050_8ZR_378_50","COAT","IT",market,provenanceKeys);
assert.equal(strippedHtml.fabric_type[0].value,"78% poliammide / 22% elastan");
const noSpaceBullets=derive({...hybrid,description:
  "La giacca ibrida Colmar ha pannelli in tessuti diversi e un cappuccio fisso.Per le giornate fresche si indossa con denim scuro e sneakers in citta."},
  variant,"COL_11000050_8ZR_378_50","COAT","IT",market,provenanceKeys);
assert.equal(noSpaceBullets.bullet_point?.length,2,
  "Keep separate merchant-source sentences even without HTML whitespace");

const wrongSum=derive({...blendSource,description:
  "Materiali e composizione Esterno principale: 78% poliammide, 21% elastan; "+
  "fodera 100% poliestere."},variant,"COL_11000050_8ZR_378_50",
  "COAT","IT",market,provenanceKeys);
assert.equal(wrongSum.fabric_type,undefined,"99 percent shell must be rejected");
const noOuter=derive({...blendSource,description:
  "Materiali e composizione Imbottitura: 90% piumino d'anatra, "+
  "10% piuma d'anatra."},variant,"COL_11000050_8ZR_378_50",
  "COAT","IT",market,provenanceKeys);
assert.equal(noOuter.fabric_type,undefined,"Do not claim filling as shell");
const wool=derive({vendor:"Colmar Originals",
  title:"Colmar Originals Pullover Uomo Heritage Mezza Zip in Lana Blu Navy Tofu Brick",
  productType:"Maglieria",description:"Materiali e composizione 80% lana, "+
  "20% poliammide. Seguire le indicazioni sull'etichetta."},variant,
  "COL_44000015_3LW_942_M","SWEATER","IT",market,provenanceKeys);
assert.equal(wool.fabric_type[0].value,"80% lana / 20% poliammide");

for(const [title,sku,want] of [
  ["Colmar Originals Piumino Donna Leggero con Cappuccio Beige Marrakech",
   "COL_22000013_2YO_636_42","Beige Marrakech"],
  ["Colmar Originals Cappotto Donna Lungo Imbottito Bianco Tofu",
   "COL_20000011_2JY_624_40","Bianco Tofu"],
  ["Colmar Originals Piumino Uomo Heritage con Cappuccio Marrakech Multicolor",
   "COL_12000023_3JQ_636_54","Marrakech Multicolor"]]){
   const test=derive({...col,title},variant,sku,"COAT","IT",market,provenanceKeys);
   assert.equal(test.color[0].value,want);
}


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
