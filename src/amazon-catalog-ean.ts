import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

const CATALOG_ENDPOINT = "https://sellingpartnerapi-eu.amazon.com/catalog/2022-04-01/items";
type Market = keyof typeof AMAZON_EU_MARKETPLACES;

/**
 * Read-only Amazon catalog lookup for exact EAN-13.
 * Does not create listings, catalog items, offers or feeds.
 */
export async function readAmazonCatalogByEAN(
  env: AmazonCredentials, market: Market, ean: string
): Promise<unknown> {
  const marketplaceId = AMAZON_EU_MARKETPLACES[market];
  if (!marketplaceId) throw new Error("amazon_catalog_invalid_marketplace");
  if (!/^\d{13}$/.test(ean)) throw new Error("amazon_catalog_invalid_ean");
  const accessToken = await getAmazonAccessToken(env);
  const url = new URL(CATALOG_ENDPOINT);
  url.searchParams.set("marketplaceIds", marketplaceId);
  url.searchParams.set("identifiers", ean);
  url.searchParams.set("identifiersType", "EAN");
  url.searchParams.set("includedData", "identifiers,productTypes,summaries");
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: { "x-amz-access-token": accessToken, Accept: "application/json" }
      });
    } catch { throw new Error("amazon_catalog_network_error"); }
    if (response.status !== 429 || attempt === 2) break;
    await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  if (!response?.ok) throw new Error("amazon_catalog_http_" + (response?.status || 0));
  let body: { items?: Array<{
    asin?: string;
    identifiers?: Array<{ marketplaceId?: string; identifiers?: Array<{
      identifier?: string; identifierType?: string;
    }> }>;
    productTypes?: Array<{ marketplaceId?: string; productType?: string }>;
    summaries?: Array<{ marketplaceId?: string; brand?: string }>;
  }> };
  try { body = await response.json(); }
  catch { throw new Error("amazon_catalog_invalid_json"); }
  if (!Array.isArray(body.items)) throw new Error("amazon_catalog_items_missing");
  const candidates = body.items.slice(0, 20).filter(item => typeof item.asin === "string").map(item => {
    const verified = (item.identifiers || []).some(group =>
      group.marketplaceId === marketplaceId &&
      (group.identifiers || []).some(id => id.identifierType === "EAN" && id.identifier === ean));
    return {
      asin: item.asin!,
      ean_confirmed: verified,
      product_types: (item.productTypes || [])
        .filter(type => type.marketplaceId === marketplaceId && typeof type.productType === "string")
        .map(type => type.productType).slice(0, 5)
    };
  });
  return {
    marketplace: market,
    marketplace_id: marketplaceId,
    read_only: true,
    catalog_candidates: candidates.length,
    exact_ean_matches: candidates.filter(item => item.ean_confirmed).length,
    candidates
  };
}
