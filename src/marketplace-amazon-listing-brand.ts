/**
 * Brand display names for Amazon LISTING payload construction.
 * Only expressly confirmed merchant mappings are permitted.
 * These names are NOT proof of trademark ownership or seller eligibility.
 * Shopify product.vendor remains immutable and authoritative.
 */
type BrandIdentity = Readonly<{
  shopify_vendor:string;amazon_brand:string;
  source:"MERCHANT_CONFIRMED_MAPPING"|"SHOPIFY_VENDOR_UNVERIFIED";
  requires_amazon_brand_eligibility_check:true;
  listing_write_authorized:false;
}>;
const KNOWN = new Map<string,string>([
  ["back70","Back 70 Streetwear"],
  ["county of milan","County Of Milan"],
]);
export function resolveAmazonListingBrand(raw:unknown):BrandIdentity|null{
  if(typeof raw!=="string"||raw.length>100||!raw.trim())return null;
  const vendor=raw.trim();
  if(vendor!==raw || /[\u0000-\u001f<>]/.test(vendor))return null;
  const amazon=KNOWN.get(vendor.toLowerCase());
  return {
    shopify_vendor:vendor,
    amazon_brand:amazon??vendor,
    source:amazon?"MERCHANT_CONFIRMED_MAPPING":"SHOPIFY_VENDOR_UNVERIFIED",
    requires_amazon_brand_eligibility_check:true,
    listing_write_authorized:false,
  };
}
