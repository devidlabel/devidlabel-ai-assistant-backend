import assert from "node:assert/strict";
import { build } from "esbuild";

/** Offline tests. All Shopify, Amazon and OAuth interactions are fake. */
const compiled = await build({
  entryPoints: ["src/mare-business-amazon-shoes-create-pilot.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const { createAmazonNewAsinShoesPilot: create } = await import(
  "data:text/javascript;base64," +
  Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
const input = Object.freeze({
  marketplace: "IT", sku: "SYNTHETIC_SHOES_39",
  allow_known_missing_attributes: true
});
const sellerId = "A123456789";
const marketId = "APJ6JRA9NG5V4";
const ean = "8057270148101";
const env = {
  AMAZON_SP_API_SELLER_ID: sellerId,
  AMAZON_OFFER_PREVIEW_ENABLED: "true",
  AMAZON_SP_API_CLIENT_ID: "synthetic",
  AMAZON_SP_API_CLIENT_SECRET: "synthetic",
  AMAZON_SP_API_REFRESH_TOKEN: "synthetic"
};
const source = patch => ({
  ok: true, status: "REQUIREMENTS_REVIEW_REQUIRED",
  marketplace: input.marketplace, sku: input.sku,
  product_type: "SHOES", seller_listing_state: "VERIFIED_ABSENT",
  ean_match_state: "NO_EXACT_MATCH",
  ean_absence_not_catalog_absence_proof: true,
  read_only: true, provider_mutations: 0,
  schema_enforced: true, schema_requirements: "LISTING",
  shopify: {
    shopify_product_type: "Sneakers",
    ean, amazon_listing_brand: "4B12",
    product_title: "Synthetic PlayNew White Bronze",
    shopify_available: 3, variant_id: "gid://shopify/ProductVariant/1234567890"
  }, ...patch
});
const payload = {
  productType: "SHOES", requirements: "LISTING",
  attributes: {
    brand: [{ value: "4B12", marketplace_id: marketId }],
    item_name: [{
      value: "Synthetic PlayNew White Bronze",
      language_tag: "it_IT", marketplace_id: marketId
    }],
    externally_assigned_product_identifier: [{ value: ean, type: "ean", marketplace_id: marketId }],
    model_name: [{ value: "PlayNew", marketplace_id: marketId }],
    color: [{ value: "White Bronze", marketplace_id: marketId }],
    footwear_size: [{
      size: "39", size_class: "numeric",
      size_system: "eu_footwear_size_system", marketplace_id: marketId
    }]
  }
};
const json = x => new Response(JSON.stringify(x), {
  status: 200, headers: { "content-type": "application/json" }
});
function harness(options = {}) {
  const calls = [];
  let sellerReads = 0;
  const fake = {
    preview: async (raw, passedEnv, deps) => {
      calls.push("preview");
      assert.deepEqual(raw, { marketplace: input.marketplace, sku: input.sku });
      assert.equal(passedEnv, options.env ?? env);
      if (options.blockPreview) return {
        ok: false, status: "BLOCKED_PREVIEW", provider_mutations: 0
      };
      await deps.fetch(
        "https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/" +
          sellerId + "/" + input.sku + "?marketplaceIds=" + marketId + "&mode=VALIDATION_PREVIEW",
        { method: "PUT", body: JSON.stringify(options.previewPayload ?? payload) }
      );
      const previewStatus = options.previewStatus ?? "INVALID";
      const issues = options.previewIssues ?? [{
        code: "90220", severity: "ERROR",
        attribute_names: ["manufacturer"]
      }];
      return {
        ok: true, status: "VALIDATION_ONLY_REVIEW_REQUIRED",
        marketplace: input.marketplace, sku: input.sku,
        product_type: "SHOES",
        validation_mode: "VALIDATION_PREVIEW",
        provider_validation_performed: true, preview_only: true,
        provider_mutations: 0, product_created: false,
        listing_write_enabled: false,
        provider_validation_status: previewStatus,
        issue_count: issues.length, issues
      };
    },
    research: async raw => {
      calls.push("research");
      assert.deepEqual(raw, {
        marketplace: input.marketplace, sku: input.sku, product_type: "SHOES"
      });
      return source(options.source);
    },
    sellerReader: async raw => {
      calls.push("seller");
      assert.deepEqual(raw, {
        marketplace: input.marketplace, skus: [input.sku]
      });
      sellerReads++;
      if (sellerReads === 1) return {
        ok: true, marketplace: input.marketplace,
        results: [{
          sku: input.sku, state: options.currentSellerState ?? "VERIFIED_ABSENT"
        }]
      };
      return options.readback ?? {
        ok: true, marketplace: input.marketplace,
        results: [{
          sku: input.sku, state: "PRESENT",
          identity_state: "VERIFIED", asin: "B0SYNTH001"
        }]
      };
    },
    accessToken: async () => {
      calls.push("token");
      return "synthetic-token";
    },
    fetch: async (url, init) => {
      const u = new URL(String(url));
      assert.equal(u.origin, "https://sellingpartnerapi-eu.amazon.com");
      assert.equal(init.method, "PUT");
      if (u.searchParams.get("mode") === "VALIDATION_PREVIEW") {
        calls.push("PREVIEW_PUT");
        assert.deepEqual(JSON.parse(init.body), options.previewPayload ?? payload);
        return json({ sku: input.sku, status: "INVALID" });
      }
      calls.push("LIVE_DEFAULT_PUT");
      assert.equal(u.searchParams.get("mode"), "DEFAULT");
      assert.equal(u.searchParams.get("marketplaceIds"), marketId);
      assert.equal(init.headers["x-amz-access-token"], "synthetic-token");
      const p = JSON.parse(init.body);
      assert.equal(p.productType, "SHOES");
      assert.equal(p.requirements, "LISTING");
      assert.equal(p.attributes.fulfillment_availability[0].quantity, 0);
      assert.deepEqual(Object.keys(p.attributes).sort(),
        [...Object.keys(payload.attributes), "fulfillment_availability"].sort());
      assert.equal(p.attributes.purchasable_offer, undefined);
      assert.equal(p.attributes.manufacturer, undefined);
      if (options.transportError) throw Error("synthetic failure after send");
      return json(options.ack ?? {
        sku: input.sku, status: "INVALID",
        submissionId: "SYNTHETIC_SUBMISSION_001",
        issues: [{ code: "90220", severity: "ERROR", message: "Private provider details" }]
      });
    }
  };
  return { calls, run: () => create(
    options.input ?? input, options.env ?? env, fake
  ) };
}
let count = 0;
const test = async run => { await run(); count++; };
await test(async () => {
  const h = harness();
  const r = await h.run();
  assert.equal(r.status, "AMAZON_REJECTED_NEW_ASIN_SUBMISSION");
  assert.equal(r.provider_write_attempted, true);
  assert.equal(r.asin_created_verified, false);
  assert.deepEqual(r.issue_codes, ["90220"]);
  assert.equal(JSON.stringify(r).includes("Private provider details"), false);
  assert.deepEqual(h.calls, [
    "preview", "PREVIEW_PUT", "research", "seller", "token", "LIVE_DEFAULT_PUT"
  ]);
});
await test(async () => {
  const h = harness({ ack: {
    sku: input.sku, status: "ACCEPTED",
    submissionId: "SYNTHETIC_ACCEPTED", issues: []
  } });
  const r = await h.run();
  assert.equal(r.status, "NEW_ASIN_SELLER_LISTING_VERIFIED");
  assert.equal(r.asin, "B0SYNTH001");
  assert.equal(r.buyable_verified, false);
  assert.equal(r.submitted_quantity, 0);
  assert.equal(r.no_channable_changes, true);
  assert.equal(h.calls.at(-1), "seller");
});
await test(async () => {
  const h = harness({ blockPreview: true });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_NEW_ASIN_PILOT");
  assert.deepEqual(h.calls, ["preview"]);
});
await test(async () => {
  const h = harness({ input: {
    ...input, allow_known_missing_attributes: false
  } });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_NEW_ASIN_PILOT");
  assert.equal(h.calls.includes("LIVE_DEFAULT_PUT"), false);
});
await test(async () => {
  const h = harness({ previewIssues: [{
    code: "5995", severity: "ERROR", attribute_names: ["brand"]
  }] });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_NEW_ASIN_PILOT");
  assert.equal(h.calls.includes("LIVE_DEFAULT_PUT"), false);
});
await test(async () => {
  const h = harness({ source: { seller_listing_state: "PRESENT" } });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_NEW_ASIN_PILOT");
  assert.equal(h.calls.includes("LIVE_DEFAULT_PUT"), false);
});
await test(async () => {
  const h = harness({ currentSellerState: "PRESENT" });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_NEW_ASIN_PILOT");
  assert.equal(h.calls.includes("LIVE_DEFAULT_PUT"), false);
});
await test(async () => {
  const h = harness({ transportError: true });
  await assert.rejects(h.run(),
    /new_asin_pilot_uncertain_submission_reconcile_before_retry/);
});
await test(async () => {
  const h = harness({ input: { ...input, quantity: 500 } });
  await assert.rejects(h.run(), /new_asin_pilot_invalid_input/);
  assert.equal(h.calls.length, 0);
});
await test(async () => {
  const h = harness({ previewPayload: {
    ...payload,
    attributes: {
      ...payload.attributes,
      manufacturer: [{ value: "UNKNOWN", marketplace_id: marketId }]
    }
  } });
  const r = await h.run();
  assert.equal(r.status, "BLOCKED_NEW_ASIN_PILOT");
  assert.equal(h.calls.includes("LIVE_DEFAULT_PUT"), false);
});
console.log(JSON.stringify({
  ok: true, tests: count,
  zero_live_provider_calls: true, live_default_put_mocked: true,
  allow_90220_trial_only: true,
  readback_required_for_created_status: true
}));
