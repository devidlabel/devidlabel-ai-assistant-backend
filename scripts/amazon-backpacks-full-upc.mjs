import fs from "node:fs";
import { auditShopifyAgainstAmazon } from "./amazon-shopify-live-audit.mjs";
import { classifyShopifyBarcode } from "./amazon-backpack-barcode-quality.mjs";



const WORKER="https://devidlabel-ai-assistant-backend.devidlabel.workers.dev";
async function catalogUPCBatch({ market, selected, bearer, fetchImpl = fetch,
  endpointRetryMs = 5000 }) {
  const url=new URL(WORKER+"/internal/amazon/catalog-upcs");
  url.searchParams.set("marketplace",market);
  url.searchParams.set("upcs",selected.map(row=>row.barcode).join(","));
  let response;
  for(let attempt=0;attempt<3;attempt++){
    response=await fetchImpl(url.toString(),{
      method:"GET",
      headers:{ Authorization:"Bearer "+bearer, Accept:"application/json" },
      signal:AbortSignal.timeout(90000)
    });
    if(response.status!==404 || attempt===2)break;
    if(endpointRetryMs>0)await new Promise(r=>setTimeout(r,endpointRetryMs*(attempt+1)));
  }
  let body={};
  try{body=await response.json();}catch{}
  if(response.status!==200 || body.ok!==true || body.read_only!==true){
    const raw=typeof body.error==="string" && /^amazon_[a-z0-9_]+$/.test(body.error)
      ?body.error:null;
    return {ok:false,http_status:response.status,
      error_code:raw || "amazon_backpack_full_upc_http_or_route_error"};
  }
  const result=body.result;
  if(!result || result.complete!==true || result.read_only!==true ||
    result.marketplace!==market || result.identifiers_count!==selected.length ||
    !Array.isArray(result.identifiers) || result.identifiers.length!==selected.length ||
    !Number.isInteger(result.pages_read) || result.pages_read<1 || result.pages_read>10)
    return {ok:false,http_status:200,error_code:"amazon_backpack_full_upc_contract_invalid"};
  const expected=new Set(selected.map(r=>r.barcode)),seen=new Set();
  for(const row of result.identifiers){
    if(!row || typeof row.upc!=="string" || !expected.has(row.upc) ||
      seen.has(row.upc) || !["EXACT_ONE","EXACT_MULTIPLE","NO_EXACT_MATCH","UNVERIFIED"].includes(row.state) ||
      !Number.isInteger(row.exact_match_count) || row.exact_match_count<0 ||
      !Array.isArray(row.asins) || row.asins.length!==row.exact_match_count ||
      (row.state==="EXACT_ONE" && row.exact_match_count!==1) ||
      (row.state==="EXACT_MULTIPLE" && row.exact_match_count<2) ||
      (["NO_EXACT_MATCH","UNVERIFIED"].includes(row.state) && row.exact_match_count!==0))
      return {ok:false,http_status:200,error_code:"amazon_backpack_full_upc_identity_invalid"};
    seen.add(row.upc);
  }
  if(seen.size!==selected.length)
    return {ok:false,http_status:200,error_code:"amazon_backpack_full_upc_missing_identifier"};
  return {ok:true,http_status:200,pages_read:result.pages_read,entries:result.identifiers};
}

const MARKETS = ["IT","DE","FR","ES"];
const BATCH_SIZE = 8;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const states = ["EXACT_ONE","EXACT_MULTIPLE","NO_EXACT_MATCH","UNVERIFIED"];
const newCounts = () => Object.fromEntries(states.map(state => [state, 0]));
const safeError = value => typeof value === "string" && /^amazon_[a-z0-9_]+$/.test(value)
  ? value.slice(0, 100) : "amazon_backpack_full_upc_unclassified_error";

/**
 * Full, single-snapshot reconciliation of ALL valid UPC-A seller-missing
 * Zaini backpacks, avoiding snapshot drift across earlier pilot batches.
 * Never persist seller SKUs, GTINs, ASINs or signed report URLs.
 */
export async function runFullBackpacksUPC({
  bearer, auditFn = auditShopifyAgainstAmazon, lookup = catalogUPCBatch,
  fetchImpl = fetch, delayMs = 2500
}) {
  const receipt = {
    schema_version: 1, generated_at: new Date().toISOString(),
    type: "amazon_eu_backpacks_full_upc_catalog_audit",
    read_only: true, no_listing_writes: true,
    source: "complete_live_shopify_and_four_amazon_seller_reports",
    category: "Zaini", identifier_type: "UPC", batch_size: BATCH_SIZE,
    results_are_full_snapshot: false, audit_complete: false,
    overall_complete: false, markets: {}, error_code: null
  };
  if (!bearer) {
    receipt.error_code = "amazon_backpack_full_upc_bearer_missing";
    return receipt;
  }

  let privateSnapshot = null;
  let audit;
  try {
    audit = await auditFn({ bearer, onPrivateSnapshot: data => { privateSnapshot = data; } });
  } catch {
    receipt.error_code = "amazon_backpack_full_upc_audit_failed";
    return receipt;
  }
  receipt.audit_complete = audit?.complete === true && audit?.shopify?.complete === true &&
    MARKETS.every(m => audit?.amazon?.[m]?.compare_ready === true);
  receipt.audit_generated_at = audit?.generated_at || null;
  receipt.shopify_eligible_variants = Number.isInteger(audit?.shopify?.eligible_variants)
    ? audit.shopify.eligible_variants : null;
  if (!receipt.audit_complete || !privateSnapshot || !Array.isArray(privateSnapshot.rows) ||
      !MARKETS.every(m => privateSnapshot.amazonIndexes?.[m] instanceof Map)) {
    receipt.error_code = "amazon_backpack_full_upc_incomplete_sources";
    return receipt;
  }

  const { rows, amazonIndexes } = privateSnapshot;
  const skuCounts = new Map(), upcCounts = new Map();
  for (const row of rows) {
    skuCounts.set(row.sku, (skuCounts.get(row.sku) || 0) + 1);
    if (classifyShopifyBarcode(row.barcode) === "UPC12_VALID") {
      upcCounts.set(row.barcode, (upcCounts.get(row.barcode) || 0) + 1);
    }
  }
  const backpackEligible = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "zaini" &&
    skuCounts.get(row.sku) === 1);
  receipt.backpack_eligible_nonduplicate_variants = backpackEligible.length;
  receipt.backpack_duplicate_sku_variants_quarantined = rows.filter(row =>
    row.product_type?.trim().toLowerCase() === "zaini" &&
    skuCounts.get(row.sku) !== 1).length;

  let stoppedForThrottle = false;
  for (const market of MARKETS) {
    const missing = backpackEligible.filter(row => !amazonIndexes[market].has(row.sku));
    const valid = missing.filter(row => classifyShopifyBarcode(row.barcode) === "UPC12_VALID");
    const safe = valid.filter(row => upcCounts.get(row.barcode) === 1);
    // Sort deterministically for stable vendor-group reporting.
    safe.sort((a,b) => a.sku.localeCompare(b.sku));
    const summary = {
      missing_backpack_variants: missing.length,
      missing_with_valid_upc: valid.length,
      missing_without_valid_upc: missing.length - valid.length,
      duplicate_upc_rows_quarantined: valid.length - safe.length,
      eligible_upcs_to_search: safe.length,
      sampled_upcs: 0, groups_planned: Math.ceil(safe.length / BATCH_SIZE),
      groups_completed: 0, total_catalog_pages: 0,
      http_status_counts: {}, matching: newCounts(), by_vendor: [],
      status: "NOT_STARTED", error_code: null
    };
    receipt.markets[market] = summary;
    if (stoppedForThrottle) {
      summary.status = "SKIPPED_AFTER_THROTTLE";
      continue;
    }
    if (!safe.length) {
      summary.status = "NO_VALID_UPCS";
      continue;
    }
    const byVendor = new Map();
    summary.status = "PARTIAL";
    for (let i = 0; i < safe.length; i += BATCH_SIZE) {
      const batch = safe.slice(i, i + BATCH_SIZE);
      let response;
      try {
        response = await lookup({
          market, selected: batch, bearer, fetchImpl, endpointRetryMs: 5000
        });
      } catch {
        response = { ok: false, http_status: 0,
          error_code: "amazon_backpack_full_upc_network_error" };
      }
      const status = String(response.http_status ?? 0);
      summary.http_status_counts[status] = (summary.http_status_counts[status] || 0) + 1;
      if (!response.ok) {
        summary.error_code = safeError(response.error_code);
        if (response.error_code === "amazon_catalog_batch_http_429" || response.http_status === 429) {
          stoppedForThrottle = true;
        }
        break;
      }
      if (!Array.isArray(response.entries) || response.entries.length !== batch.length ||
          !Number.isInteger(response.pages_read) || response.pages_read < 1) {
        summary.error_code = "amazon_backpack_full_upc_invalid_response";
        break;
      }
      const index = new Map(response.entries.map(entry => [entry.upc, entry.state]));
      if (index.size !== batch.length ||
          batch.some(row => !states.includes(index.get(row.barcode)))) {
        summary.error_code = "amazon_backpack_full_upc_identity_mismatch";
        break;
      }
      // Only write group counts after the complete batch has been validated.
      for (const row of batch) {
        const classification = index.get(row.barcode);
        summary.matching[classification]++;
        const vendor = String(row.vendor || "Non specificato").slice(0, 120);
        if (!byVendor.has(vendor)) {
          byVendor.set(vendor, { vendor, searched: 0, matching: newCounts() });
        }
        byVendor.get(vendor).searched++;
        byVendor.get(vendor).matching[classification]++;
      }
      summary.sampled_upcs += batch.length;
      summary.groups_completed++;
      summary.total_catalog_pages += response.pages_read;
      if (delayMs > 0) await pause(delayMs);
    }
    summary.by_vendor = [...byVendor.values()].sort((a,b) => b.searched - a.searched ||
      a.vendor.localeCompare(b.vendor));
    summary.status = summary.groups_completed === summary.groups_planned &&
      summary.sampled_upcs === summary.eligible_upcs_to_search && !summary.error_code
      ? "COMPLETE" : "PARTIAL";
  }
  receipt.overall_complete = MARKETS.every(m => receipt.markets[m]?.status === "COMPLETE");
  receipt.results_are_full_snapshot = receipt.overall_complete;
  if (!receipt.overall_complete) receipt.error_code = stoppedForThrottle
    ? "amazon_backpack_full_upc_throttled" : "amazon_backpack_full_upc_partial";
  return receipt;
}

if (process.env.AMAZON_BACKPACKS_FULL_UPC_RUN === "true") {
  const result = await runFullBackpacksUPC({
    bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || ""
  });
  fs.writeFileSync("/tmp/amazon-backpacks-full-upc.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}
