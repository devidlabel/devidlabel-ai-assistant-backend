import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/mare-business-amazon-matching.ts"],
  bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent" });
const { readAmazonExactMatchCandidates } = await import(
  "data:text/javascript;base64," +
  Buffer.from(built.outputFiles[0].text).toString("base64"));

function withCheck(digits) {
  const sum = [...digits].reverse().reduce((s, n, i) =>
    s + Number(n) * (i % 2 === 0 ? 3 : 1), 0);
  return digits + String((10 - sum % 10) % 10);
}
const ean = withCheck("805168921730");
const upc = withCheck("03600029145");
const credentials = {
  AMAZON_SP_API_CLIENT_ID: "private-test-id",
  AMAZON_SP_API_CLIENT_SECRET: "private-test-secret",
  AMAZON_SP_API_REFRESH_TOKEN: "private-test-refresh"
};
let calls = 0, catalogRequests = 0;
const existingFetch = globalThis.fetch;
try {
  globalThis.fetch = async (input, init = {}) => {
    calls++;
    const url = new URL(String(input));
    if (url.pathname === "/auth/o2/token") {
      assert.equal(init.method, "POST");
      return new Response(JSON.stringify({access_token:"ephemeral-lwa-token"}), {status:200});
    }
    assert.equal(url.pathname,"/catalog/2022-04-01/items");
    assert.equal(init.method,"GET");
    assert.equal(init.headers["x-amz-access-token"],"ephemeral-lwa-token");
    const type = url.searchParams.get("identifiersType");
    assert(["EAN","UPC"].includes(type));
    const requested = url.searchParams.get("identifiers");
    assert.equal(requested, type==="EAN" ? ean : upc);
    catalogRequests++;
    return new Response(JSON.stringify({numberOfResults:1,items:[{
      asin:"B000000001",
      identifiers:[{marketplaceId:"APJ6JRA9NG5V4",identifiers:[{
        identifierType:type,identifier:requested
      }]}]
    }]}), {status:200});
  };

  for (const [type,id] of [["EAN",ean],["UPC",upc]]) {
    const result = await readAmazonExactMatchCandidates({
      marketplace:"IT",identifier_type:type,identifiers:[id]
    },credentials);
    assert.equal(result.ok,true);
    assert.equal(result.no_listing_writes,true);
    assert.equal(result.has_created_offer,false);
    assert.equal(result.association_status,"CANDIDATES_ONLY");
    assert.equal(result.result.read_only,true);
    assert.equal(result.result.identifiers_count,1);
    assert.equal(result.result.identifiers[0].state,"EXACT_ONE");
    assert.deepEqual(result.result.identifiers[0].asins,["B000000001"]);
    const encoded = JSON.stringify(result);
    assert(!encoded.includes(credentials.AMAZON_SP_API_CLIENT_SECRET));
    assert(!encoded.includes(credentials.AMAZON_SP_API_REFRESH_TOKEN));
    assert(!encoded.includes("ephemeral-lwa-token"));
  }
  assert.equal(catalogRequests,2);
  const before=calls;
  for (const invalid of [
    {marketplace:"US",identifier_type:"EAN",identifiers:[ean]},
    {marketplace:"IT",identifier_type:"EAN",identifiers:[]},
    {marketplace:"IT",identifier_type:"UPC",identifiers:[ean]},
    {marketplace:"IT",identifier_type:"EAN",identifiers:Array(9).fill(ean)},
    {marketplace:"IT",identifier_type:"UPC",identifiers:[upc,upc]}
  ]) await assert.rejects(()=>readAmazonExactMatchCandidates(invalid,credentials));
  assert.equal(calls,before,"Invalid request must never touch Amazon API");
  console.log("Merchant-private Amazon exact EAN/UPC matching read-only contract passed");
} finally {
  globalThis.fetch=existingFetch;
}
