import { readAmazonCatalogByEANBatch } from "./amazon-catalog-ean-batch.js";
import { readAmazonCatalogByUPCBatch } from "./amazon-catalog-upc-batch.js";
import type { AmazonCredentials } from "./amazon-auth.js";

type Market = "IT" | "DE" | "FR" | "ES";
type IdentifierType = "EAN" | "UPC";
type MatchReadRequest = Record<string, unknown>;

const MARKETS = new Set(["IT", "DE", "FR", "ES"]);
const TYPES = new Set(["EAN", "UPC"]);
const MAX_IDENTIFIERS = 8;

/**
 * Merchant-only authenticated MCP read. Designed to return actionable exact
 * identifier -> ASIN candidates WITHOUT writing them to public GitHub or
 * changing any Amazon listing. Source records remain in the authenticated
 * response and are never persisted or logged.
 */
export async function readAmazonExactMatchCandidates(
  request: MatchReadRequest,
  env: AmazonCredentials
): Promise<unknown> {
  const market = request.marketplace;
  const type = request.identifier_type;
  const raw = request.identifiers;
  if (typeof market !== "string" || !MARKETS.has(market) ||
      typeof type !== "string" || !TYPES.has(type) ||
      !Array.isArray(raw) || raw.length < 1 || raw.length > MAX_IDENTIFIERS ||
      !raw.every(v => typeof v === "string" &&
        (type === "EAN" ? /^\d{13}$/.test(v) : /^\d{12}$/.test(v))) ||
      new Set(raw).size !== raw.length) {
    throw new Error("amazon_match_read_invalid_request");
  }

  // Underlying Catalog Items readers additionally validate check digits,
  // full pagination, exact identifier identity and Amazon throttle responses.
  const result = type === "EAN"
    ? await readAmazonCatalogByEANBatch(env, market as Market, raw as string[])
    : await readAmazonCatalogByUPCBatch(env, market as Market, raw as string[]);
  return {
    ok: true,
    read_only: true,
    no_listing_writes: true,
    source: "amazon_spapi_catalog_items_live",
    identifier_type: type as IdentifierType,
    association_status: "CANDIDATES_ONLY",
    requires_brand_title_size_color_verification: true,
    has_created_offer: false,
    result
  };
}
