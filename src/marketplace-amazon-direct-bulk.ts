import { createAmazonOfferOnlyPilot } from "./mare-business-amazon-offer-create-pilot.js";

type Market = "IT" | "DE" | "FR" | "ES";
type Item = { marketplace: Market; sku: string; ean: string; asin: string };
type Result = Record<string, unknown>;
type Env = Parameters<typeof createAmazonOfferOnlyPilot>[1];

const markets = new Set(["IT", "DE", "FR", "ES"]);
const eanValid = (ean: string): boolean => {
  if (!/^\d{13}$/.test(ean)) return false;
  const sum = [...ean.slice(0, 12)].reduce((n, digit, i) => n + Number(digit) * (i % 2 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === Number(ean[12]);
};
export function validateDirectAmazonBatch(input: unknown): Item[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("batch_invalid");
  const obj = input as Record<string, unknown>;
  if (Object.keys(obj).some(k => k !== "items") || !Array.isArray(obj.items) || obj.items.length < 1 || obj.items.length > 12) throw Error("batch_size_invalid");
  const seen = new Set<string>();
  return obj.items.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("batch_item_invalid");
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "asin,ean,marketplace,sku" ||
        typeof r.marketplace !== "string" || !markets.has(r.marketplace) ||
        typeof r.sku !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$/.test(r.sku) ||
        typeof r.ean !== "string" || !eanValid(r.ean) ||
        typeof r.asin !== "string" || !/^[A-Z0-9]{10}$/.test(r.asin)) throw Error("batch_item_invalid");
    const key = r.marketplace + "|" + r.sku;
    if (seen.has(key)) throw Error("batch_duplicate_sku_market");
    seen.add(key);
    return {marketplace:r.marketplace as Market, sku:r.sku, ean:r.ean, asin:r.asin};
  });
}

/** Designed for execution ONLY behind an immutable MARE live-write plan.
 * Serial execution, no retries, fail-closed on ambiguous PUT or missing readback.
 * Channable, Shopify stock, prices and other seller offers are never modified.
 */
export async function executeDirectAmazonBatch(
  raw: unknown, env: Env,
  create: typeof createAmazonOfferOnlyPilot = createAmazonOfferOnlyPilot
): Promise<Result> {
  const items = validateDirectAmazonBatch(raw);
  const results: Array<{marketplace: Market; sku:string; asin:string; outcome:string; offer_created_verified:boolean; live_write_attempted:boolean}> = [];
  let halted = false;
  for (const item of items) {
    try {
      const r = await create(item, env);
      const success = r.ok === true && r.status === "SELLER_OFFER_CREATED_VERIFIED" && r.offer_created_verified === true;
      const attempted = r.live_write_attempted === true;
      results.push({marketplace:item.marketplace,sku:item.sku,asin:item.asin,outcome:String(r.status ?? "UNKNOWN"),offer_created_verified:success,live_write_attempted:attempted});
      // A submitted-but-unverified PUT must NEVER be repeated or followed by more writes.
      if (!success && attempted) { halted = true; break; }
      // Preview or preflight failure is isolated; continue with the remaining independent SKUs.
    } catch {
      results.push({marketplace:item.marketplace,sku:item.sku,asin:item.asin,outcome:"UNKNOWN_RECONCILE_BEFORE_RETRY",offer_created_verified:false,live_write_attempted:true});
      halted = true;
      break;
    }
  }
  return {ok:true,mode:"SEQUENTIAL_NO_RETRY",requested:items.length,processed:results.length,halted_for_uncertain_write:halted,results,provider_readback_required:true,channable_writer_unchanged:true,stock_or_price_changed:false};
}
