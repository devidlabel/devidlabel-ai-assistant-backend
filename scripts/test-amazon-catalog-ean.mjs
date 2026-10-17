import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/amazon-readonly-handler.ts"],
  bundle: true, platform: "neutral", format: "esm", write: false, logLevel: "silent" });
const { handleAmazonReadonlyRequest } = await import(
  "data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const originalFetch = globalThis.fetch;
const env = { DAILY_PULSE_ACCESS_TOKEN: "test-admin",
  AMAZON_SP_API_CLIENT_ID: "test-client", AMAZON_SP_API_CLIENT_SECRET: "test-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "test-refresh" };
const ean = "8051689217366";
let calls = 0;
let noMatches = false;
try {
  globalThis.fetch = async (target, init) => {
    calls++;
    if (String(target).includes("/auth/o2/token")) {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ access_token: "mock-access" }), { status: 200 });
    }
    const url = new URL(String(target));
    assert.equal(url.pathname, "/catalog/2022-04-01/items");
    assert.equal(url.searchParams.get("identifiersType"), "EAN");
    assert.equal(url.searchParams.get("identifiers"), ean);
    assert.equal(url.searchParams.get("marketplaceIds"), "APJ6JRA9NG5V4");
    assert.equal(init.headers["x-amz-access-token"], "mock-access");
    assert.equal(init.method, "GET");
    const items = noMatches ? [] : [{
      asin: "B0TEST1234",
      identifiers: [{ marketplaceId: "APJ6JRA9NG5V4", identifiers: [
        { identifierType: "EAN", identifier: ean }
      ] }],
      productTypes: [{ marketplaceId: "APJ6JRA9NG5V4", productType: "SHOES" }]
    }];
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  const root = "https://worker.test/internal/amazon/catalog-ean?marketplace=IT&ean=" + ean;
  assert.equal((await handleAmazonReadonlyRequest(new Request(root), env)).status, 401);
  assert.equal(calls, 0);
  const headers = { Authorization: "Bearer test-admin" };
  assert.equal((await handleAmazonReadonlyRequest(new Request(root.replace("marketplace=IT", "marketplace=XX"), { headers }), env)).status, 400);
  assert.equal((await handleAmazonReadonlyRequest(new Request(root.replace(ean, "not-an-ean"), { headers }), env)).status, 400);
  assert.equal(calls, 0);
  const response = await handleAmazonReadonlyRequest(new Request(root, { headers }), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.read_only, true);
  assert.equal(body.result.catalog_candidates, 1);
  assert.equal(body.result.exact_ean_matches, 1);
  assert.equal(body.result.candidates[0].asin, "B0TEST1234");
  assert.deepEqual(body.result.candidates[0].product_types, ["SHOES"]);
  assert(!JSON.stringify(body).includes(ean), "Do not echo EAN in catalog response");
  assert.equal(calls, 2);
  noMatches = true;
  const empty = await handleAmazonReadonlyRequest(new Request(root, { headers }), env);
  assert.equal((await empty.json()).result.catalog_candidates, 0);
  assert.equal(calls, 4);
  console.log("Amazon Catalog Items EAN read-only tests passed");
} finally { globalThis.fetch = originalFetch; }
