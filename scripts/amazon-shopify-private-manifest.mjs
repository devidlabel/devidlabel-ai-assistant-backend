import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const CHECKOUT_ROOT = fileURLToPath(new URL("../", import.meta.url));

const MARKETS = ["IT", "DE", "FR", "ES"];
const STATES = new Set(["PRESENT_ACTIVE", "PRESENT_INACTIVE", "PRESENT_UNKNOWN",
  "NOT_FOUND_IN_AMAZON_REPORT", "UNVERIFIED", "DUPLICATE_SHOPIFY_SKU"]);
const price = value => typeof value === "string" && /^\d+(?:\.\d{1,4})?$/.test(value)
  ? value : null;

/** Private operational snapshot. Never attach this to the public aggregate receipt. */
export function buildPrivateShopifyAmazonManifest(snapshot, report) {
  if (report?.complete !== true || report?.shopify?.complete !== true ||
      !MARKETS.every(m => report.amazon?.[m]?.compare_ready === true) ||
      !Array.isArray(snapshot?.rows) || !Array.isArray(snapshot?.classifications) ||
      snapshot.rows.length !== snapshot.classifications.length ||
      snapshot.rows.length !== report.shopify.eligible_variants)
    throw new Error("private_manifest_requires_complete_reconciled_snapshot");
  const rows = snapshot.rows.map((row, i) => {
    const states = snapshot.classifications[i];
    if (typeof row?.sku !== "string" || !row.sku.trim() ||
        typeof row.product_id !== "string" || typeof row.variant_id !== "string" ||
        !Number.isFinite(row.inventory_quantity) || row.inventory_quantity <= 0 ||
        !MARKETS.every(m => STATES.has(states?.[m])))
      throw new Error("private_manifest_row_invalid");
    return {
      sku: row.sku, product_id: row.product_id, variant_id: row.variant_id,
      vendor: typeof row.vendor === "string" ? row.vendor : "",
      product_type: typeof row.product_type === "string" ? row.product_type : "",
      inventory_quantity: row.inventory_quantity,
      barcode: typeof row.barcode === "string" ? row.barcode : null,
      price: price(row.price), compare_at_price: price(row.compare_at_price),
      market_states: Object.fromEntries(MARKETS.map(m => [m, states[m]]))
    };
  });
  return {
    schema_version: 1, generated_at: report.generated_at,
    source: "same_complete_shopify_amazon_audit_snapshot",
    private_operational_manifest: true, read_only: true, no_listing_writes: true,
    buyability_verified: false, row_count: rows.length,
    unique_sku_count: new Set(rows.map(r => r.sku)).size,
    report_sources: Object.fromEntries(MARKETS.map(m => [m, {
      report_created_at: report.amazon[m].report_created_at,
      compare_ready: report.amazon[m].compare_ready
    }])),
    field_notes: {
      barcode: "Original identifier; UPC is never padded into EAN.",
      price: "Null when not returned by the existing Shopify page endpoint.",
      compare_at_price: "Null when not returned by the existing Shopify page endpoint.",
      market_states: "Report classification, not a direct BUYABLE observation.",
      duplicates: "Duplicate SKU variant rows remain separate and retain their classification."
    },
    rows
  };
}

function outside(directory, root) {
  const relative = path.relative(root, directory);
  return relative === ".." || relative.startsWith(".." + path.sep);
}

/** Keep the detailed output outside the checkout; the repository is public. */
export function validatePrivateManifestOutput(filename, checkoutRoot = CHECKOUT_ROOT) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) ||
      !outside(path.resolve(filename), path.resolve(checkoutRoot)))
    throw new Error("private_manifest_output_must_be_absolute_outside_checkout");
}

/** Atomic 0600 file, with a second check against symlinks into the checkout. */
export function writePrivateShopifyAmazonManifest(filename, manifest, checkoutRoot = CHECKOUT_ROOT) {
  validatePrivateManifestOutput(filename, checkoutRoot);
  const folder = path.dirname(filename);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const realFolder = fs.realpathSync(folder), realRoot = fs.realpathSync(checkoutRoot);
  if (!outside(realFolder, realRoot))
    throw new Error("private_manifest_output_resolves_inside_checkout");
  const temporary = path.join(realFolder, "." + path.basename(filename) + "." + randomUUID() + ".tmp");
  try {
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + "\n", {
      encoding: "utf8", flag: "wx", mode: 0o600
    });
    fs.renameSync(temporary, path.join(realFolder, path.basename(filename)));
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

