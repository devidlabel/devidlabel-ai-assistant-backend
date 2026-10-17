import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

type Market = keyof typeof AMAZON_EU_MARKETPLACES;
type MatchState = "EXACT_ONE" | "EXACT_MULTIPLE" | "NO_EXACT_MATCH" | "UNVERIFIED";
type CatalogItem = {
  asin?: string;
  identifiers?: Array<{
    marketplaceId?: string;
    identifiers?: Array<{ identifier?: string; identifierType?: string }>;
  }>;
};
type CatalogResponse = {
  numberOfResults?: number;
  pagination?: { nextToken?: string };
  items?: CatalogItem[];
};

const API = "https://sellingpartnerapi-eu.amazon.com/catalog/2022-04-01/items";
const MAX_UPCS = 20;
const MAX_PAGES = 10;
const PAGE_SIZE = 10;
const THROTTLE_DELAYS_MS = [2500, 7000, 16000];

function validUPC12(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(value[i]) * (i % 2 === 0 ? 3 : 1);
  return ((10 - (sum % 10)) % 10) === Number(value[11]);
}

async function fetchPage(url: URL, token: string): Promise<CatalogResponse> {
  for (let attempt = 0; attempt <= THROTTLE_DELAYS_MS.length; attempt++) {
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: "GET",
        headers: { "x-amz-access-token": token, Accept: "application/json" }
      });
    } catch {
      throw new Error("amazon_catalog_batch_network_error");
    }
    if ((response.status === 429 || response.status === 503) &&
        attempt < THROTTLE_DELAYS_MS.length) {
      await new Promise(resolve => setTimeout(resolve, THROTTLE_DELAYS_MS[attempt]));
      continue;
    }
    if (!response.ok) throw new Error("amazon_catalog_batch_http_" + response.status);
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new Error("amazon_catalog_batch_invalid_json"); }
    if (!body || typeof body !== "object") throw new Error("amazon_catalog_batch_invalid_body");
    const data = body as CatalogResponse;
    if (!Number.isInteger(data.numberOfResults) || (data.numberOfResults as number) < 0 ||
        !Array.isArray(data.items) || data.items.length > PAGE_SIZE) {
      throw new Error("amazon_catalog_batch_invalid_page");
    }
    return data;
  }
  throw new Error("amazon_catalog_batch_throttled");
}

/**
 * Search at most 20 UPC-A 12-digit codes; verify each exact UPC identity from the
 * full, paginated Catalog Items result. Never mutate offers or products.
 *
 * Fail closed if pagination is incomplete or inconsistent: absent matches
 * must never be inferred from truncated Amazon results.
 */
export async function readAmazonCatalogByUPCBatch(
  env: AmazonCredentials,
  market: Market,
  inputUPCs: string[]
): Promise<unknown> {
  const marketplaceId = AMAZON_EU_MARKETPLACES[market];
  if (!marketplaceId) throw new Error("amazon_catalog_batch_invalid_marketplace");
  if (!Array.isArray(inputUPCs) || inputUPCs.length < 1 || inputUPCs.length > MAX_UPCS ||
      !inputUPCs.every(upc => typeof upc === "string" && validUPC12(upc)) ||
      new Set(inputUPCs).size !== inputUPCs.length) {
    throw new Error("amazon_catalog_batch_invalid_identifiers");
  }

  const token = await getAmazonAccessToken(env);
  const url = new URL(API);
  url.searchParams.set("marketplaceIds", marketplaceId);
  url.searchParams.set("identifiers", inputUPCs.join(","));
  url.searchParams.set("identifiersType", "UPC");
  url.searchParams.set("includedData", "identifiers");
  url.searchParams.set("pageSize", String(PAGE_SIZE));

  const candidates = new Map<string, Set<string>>();
  for (const upc of inputUPCs) candidates.set(upc, new Set<string>());
  const seenAsins = new Set<string>();
  const seenTokens = new Set<string>();
  let pagesRead = 0;
  let declaredTotal: number | null = null;
  let hadItemsWithNoVerifiedUPC = false;

  while (true) {
    if (pagesRead >= MAX_PAGES) throw new Error("amazon_catalog_batch_page_limit");
    const page = await fetchPage(url, token);
    pagesRead++;
    if (declaredTotal === null) declaredTotal = page.numberOfResults as number;
    else if (declaredTotal !== page.numberOfResults) {
      throw new Error("amazon_catalog_batch_inconsistent_total");
    }
    for (const item of page.items!) {
      if (!item || typeof item.asin !== "string" || !/^[A-Z0-9]{10}$/.test(item.asin)) {
        throw new Error("amazon_catalog_batch_invalid_asin");
      }
      seenAsins.add(item.asin);
      let itemMapped = false;
      for (const group of item.identifiers || []) {
        if (group.marketplaceId !== marketplaceId) continue;
        for (const id of group.identifiers || []) {
          if ((id.identifierType || "").toUpperCase() !== "UPC" ||
              typeof id.identifier !== "string") continue;
          const target = candidates.get(id.identifier);
          if (target) {
            target.add(item.asin);
            itemMapped = true;
          }
        }
      }
      if (!itemMapped) hadItemsWithNoVerifiedUPC = true;
    }

    const next = page.pagination?.nextToken;
    if (!next) break;
    if (typeof next !== "string" || next.length > 8192 || seenTokens.has(next)) {
      throw new Error("amazon_catalog_batch_pagination_invalid");
    }
    seenTokens.add(next);
    url.searchParams.set("pageToken", next);
  }
  if (declaredTotal === null || seenAsins.size !== declaredTotal) {
    throw new Error("amazon_catalog_batch_truncated_results");
  }

  const identifiers = inputUPCs.map(upc => {
    const matches = [...candidates.get(upc)!].sort();
    const state: MatchState = matches.length === 1 ? "EXACT_ONE"
      : matches.length > 1 ? "EXACT_MULTIPLE"
      : hadItemsWithNoVerifiedUPC ? "UNVERIFIED" : "NO_EXACT_MATCH";
    return { upc, state, exact_match_count: matches.length, asins: matches };
  });
  return {
    read_only: true,
    marketplace: market,
    marketplace_id: marketplaceId,
    identifiers_count: inputUPCs.length,
    pages_read: pagesRead,
    number_of_results: declaredTotal,
    unique_asins: seenAsins.size,
    complete: true,
    identifiers
  };
}
