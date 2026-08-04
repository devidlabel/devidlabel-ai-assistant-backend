import { readFileSync, writeFileSync } from "node:fs";

const path = "scripts/apply-shopify-channel-policy.mjs";
let source = readFileSync(path, "utf8");

const replacements = [
  [
    '    const response = await fetch(`${KLAVIYO_API_BASE}${path}`, {',
    '    const response = await fetch(KLAVIYO_API_BASE + path, {',
  ],
  [
    '        Authorization: `Klaviyo-API-Key ${apiKey}`,',
    '        Authorization: "Klaviyo-API-Key " + apiKey,',
  ],
  [
    '  const error = new Error(`Klaviyo API request failed (${lastStatus || "unknown"})`);',
    '  const error = new Error("Klaviyo API request failed (" + (lastStatus || "unknown") + ")");',
  ],
  [
    '    path = `${nextUrl.pathname}${nextUrl.search}`;',
    '    path = nextUrl.pathname + nextUrl.search;',
  ],
  [
    '        id: `gid://shopify/Order/${id}`,',
    "        id: 'gid://shopify/Order/' + id,",
  ],
  [
    '            id: `gid://shopify/LineItem/${id}`,',
    "            id: 'gid://shopify/LineItem/' + id,",
  ],
  [
    'const { handleKlaviyoReportingRequest } = await import(`file://${compiled}`);',
    "const { handleKlaviyoReportingRequest } = await import('file://' + compiled);",
  ],
];

for (const [search, replacement] of replacements) {
  if (!source.includes(search)) throw new Error(`Missing migration literal: ${search}`);
  source = source.replace(search, replacement);
}

writeFileSync(path, source);
console.log("Repaired temporary migration script literals.");
