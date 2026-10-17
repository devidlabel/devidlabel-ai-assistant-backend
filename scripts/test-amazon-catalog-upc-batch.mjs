import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/amazon-readonly-handler.ts"], bundle: true,
  platform: "neutral", format: "esm", write: false, logLevel: "silent"
});
const { handleAmazonReadonlyRequest } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
function makeUpc(base) {
  const prefix = String(base).padStart(11, "0");
  const total = [...prefix].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return prefix + ((10 - total % 10) % 10);
}
const upcs = [makeEan(80516892173), makeEan(80516892174), makeEan(80516892175)];
const root = "https://worker.test/internal/amazon/catalog-upcs?marketplace=IT&upcs=" + upcs.join(",");
const headers = { Authorization: "Bearer private-admin" };
const env = {
  DAILY_PULSE_ACCESS_TOKEN: "private-admin",
  AMAZON_SP_API_CLIENT_ID: "test-id", AMAZON_SP_API_CLIENT_SECRET: "secret",
  AMAZON_SP_API_REFRESH_TOKEN: "test-refresh"
};
let mode = "normal", pageFetches = 0;
const original = globalThis.fetch;
function item(asin, upc, mapToEan = true) {
  return { asin, identifiers: [{
    marketplaceId: "APJ6JRA9NG5V4",
    identifiers: mapToEan ? [{ identifierType: "UPC", identifier: upc }] : []
  }] };
}
try {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/o2/token") {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({ access_token: "mock-access" }), { status: 200 });
    }
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-amz-access-token"], "mock-access");
    assert.equal(url.pathname, "/catalog/2022-04-01/items");
    assert.equal(url.searchParams.get("identifiersType"), "UPC");
    assert.equal(url.searchParams.get("identifiers"), upcs.join(","));
    assert.equal(url.searchParams.get("marketplaceIds"), "APJ6JRA9NG5V4");
    assert.equal(url.searchParams.get("pageSize"), "10");
    pageFetches++;
    if (mode === "truncated") {
      return new Response(JSON.stringify({
        numberOfResults: 4,
        items: [item("B000000001", upcs[0])]
      }), { status: 200 });
    }
    if (mode === "unmapped") {
      return new Response(JSON.stringify({
        numberOfResults: 1,
        items: [item("B000000004", upcs[2], false)]
      }), { status: 200 });
    }
    if (mode === "cycle") {
      return new Response(JSON.stringify({
        numberOfResults: 10, pagination: { nextToken: "REPEAT" }, items: [item("B000000001", upcs[0])]
      }), { status: 200 });
    }
    const token = url.searchParams.get("pageToken");
    if (!token) {
      return new Response(JSON.stringify({
        numberOfResults: 3, pagination: { nextToken: "NEXT_PAGE" },
        items: [item("B000000001", upcs[0]), item("B000000002", upcs[1])]
      }), { status: 200 });
    }
    assert.equal(token, "NEXT_PAGE");
    return new Response(JSON.stringify({
      numberOfResults: 3,
      items: [item("B000000003", upcs[1])]
    }), { status: 200 });
  };

  assert.equal((await handleAmazonReadonlyRequest(new Request(root), env)).status, 401);
  assert.equal(pageFetches, 0);
  assert.equal((await handleAmazonReadonlyRequest(
    new Request(root.replace("marketplace=IT", "marketplace=CN"), { headers }), env
  )).status, 400);
  assert.equal((await handleAmazonReadonlyRequest(
    new Request(root.replace(upcs.join(","), "INVALID"), { headers }), env
  )).status, 400);
  assert.equal(pageFetches, 0);

  const response = await handleAmazonReadonlyRequest(new Request(root, { headers }), env);
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.read_only, true);
  assert.equal(result.complete, true);
  assert.equal(result.pages_read, 2);
  assert.equal(result.identifiers_count, 3);
  assert.equal(result.unique_asins, 3);
  assert.deepEqual(result.identifiers.map(x => x.state), [
    "EXACT_ONE", "EXACT_MULTIPLE", "NO_EXACT_MATCH"
  ]);
  assert.deepEqual(result.identifiers.map(x => x.exact_match_count), [1, 2, 0]);
  assert.equal(pageFetches, 2);
  assert(!JSON.stringify(result).includes("private-admin"));

  mode = "truncated";
  const truncated = await handleAmazonReadonlyRequest(new Request(root, { headers }), env);
  assert.equal(truncated.status, 502);
  assert.equal((await truncated.json()).error, "amazon_catalog_batch_truncated_results");

  mode = "unmapped";
  const unmapped = await handleAmazonReadonlyRequest(new Request(root, { headers }), env);
  assert.equal(unmapped.status, 200);
  const candidates = (await unmapped.json()).result.identifiers;
  assert(candidates.every(x => x.state === "UNVERIFIED"),
    "Unmapped Catalog Items results must never be interpreted as missing");

  mode = "cycle";
  const cycle = await handleAmazonReadonlyRequest(new Request(root, { headers }), env);
  assert.equal(cycle.status, 502);
  assert.equal((await cycle.json()).error, "amazon_catalog_batch_pagination_invalid");

  console.log("Amazon multi-UPC Catalog Items pagination and strict identity tests passed");
} finally {
  globalThis.fetch = original;
}
