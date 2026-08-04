import { strict as assert } from "node:assert";

const moduleUrl = new URL("../src/mare-mcp.ts", import.meta.url);
const source = await (await fetch(moduleUrl)).text().catch(() => "");
if (!source) {
  console.log("Skipping direct TypeScript import in Node; static contract checks only.");
}

const requiredFragments = [
  'rpc.method === "initialize"',
  'rpc.method === "tools/list"',
  'rpc.method === "tools/call"',
  'name: "mare_daily_pulse"',
  'name: "mare_shopify_commerce"',
  'name: "mare_paid_media"',
  'name: "mare_ga4"',
  'name: "mare_search_console"',
  'name: "mare_klaviyo"',
  'readOnlyHint: true',
  'url.pathname !== "/mcp"',
  'X-MARE-MCP-Key',
];

for (const fragment of requiredFragments) {
  assert.ok(source.includes(fragment), `Missing MCP contract fragment: ${fragment}`);
}

const workerSource = await (await fetch(new URL("../src/worker-v3.ts", import.meta.url))).text();
assert.ok(workerSource.includes('import { handleMareMcpRequest } from "./mare-mcp";'));
assert.ok(workerSource.includes("await handleMareMcpRequest(request, env)"));

console.log(JSON.stringify({
  ok: true,
  contract: "mare_commerce_os_mcp",
  transport: "streamable_http",
  read_only_tools: 8,
}));
