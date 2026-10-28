/** Evidence-scoped mapping for one-size RAINS accessories which Amazon labels
 * with a model/form-factor size (S/M/Regular/Mini/OS), not an apparel size.
 * This is NOT a generic size bypass: SKU, ASIN, marketplace, brand, model and
 * product type must ALL match a verified catalogue record.
 */
type Input = {sku:string;asin:string;marketplace:string;shopifySize:string;amazonSize:string;brand:string;amazonModel:string;productTypes:string[];shopifyProductType:string};
type Spec = {asin:string;model:string;size:string;markets:string[];categories:string[]};
const approved: Record<string,Spec> = {
  RNS_15580_BEI:{asin:"B0FL42HWBY",model:"15580",size:"s",markets:["IT"],categories:["COSMETIC_CASE"]},
  RNS_13000_DGY:{asin:"B0GPKFGDV1",model:"13000",size:"m",markets:["IT","DE","FR","ES"],categories:["BACKPACK"]},
  RNS_14200_MYS:{asin:"B0HBNVB52P",model:"14200",size:"regular",markets:["IT","DE","FR","ES"],categories:["DUFFEL_BAG"]},
  RNS_14200_DGY:{asin:"B0GXDG86VW",model:"14200",size:"os",markets:["DE","FR","ES"],categories:["DUFFEL_BAG"]},
  // ES is intentionally excluded: the EAN-associated Amazon catalogue
  // currently reports "Kite", not the Shopify variant color "Comet".
  RNS_13020_CMT:{asin:"B0HGP78S83",model:"13020",size:"mini",markets:["IT","DE","FR"],categories:["BACKPACK"]}
};
export function approvedRainsOneSizeFormFactor(input: Input):boolean {
  const rule=approved[input.sku];
  if(!rule||input.asin!==rule.asin||!rule.markets.includes(input.marketplace)||
    input.brand.trim().toLowerCase()!=="rains"||
    input.shopifySize.trim().toLowerCase()!=="taglia unica"||
    input.amazonSize.trim().toLowerCase()!==rule.size ||
    !input.productTypes.some(x=>rule.categories.includes(x.toUpperCase()))||
    !/^(borse?|borsoni e valigie|zaini|beauty case)$/i.test(input.shopifyProductType.trim()))return false;
  // Manufacturer model code must be unambiguous and on the same 5-digit style,
  // optionally with a documented color/style suffix separated by punctuation.
  const model=input.amazonModel.trim();
  return new RegExp("(^|[^0-9])"+rule.model+"([^0-9]|$)").test(model);
}
