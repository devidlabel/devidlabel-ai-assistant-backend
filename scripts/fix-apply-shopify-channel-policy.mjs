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

const workflowPatchStart = source.indexOf('workflow = replaceOnce(\n  workflow,\n  `      - name: Test Shopify ADV reporting');
const workflowPatchEnd = source.indexOf('writeFileSync(workflowPath, workflow);', workflowPatchStart);
if (workflowPatchStart < 0 || workflowPatchEnd < 0) throw new Error('Missing workflow patch block');
const workflowPatch = source.slice(workflowPatchStart, workflowPatchEnd);
source = source.slice(0, workflowPatchStart)
  + 'if (!workflow.includes("Test Klaviyo reporting resilience")) {\n'
  + workflowPatch.split('\n').map((line) => `  ${line}`).join('\n')
  + '}\n'
  + source.slice(workflowPatchEnd);

writeFileSync(path, source);
console.log("Repaired temporary migration script literals and idempotency.");
