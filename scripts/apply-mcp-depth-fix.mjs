import { readFileSync, writeFileSync } from "node:fs";

const mcpPath = "src/mare-mcp.ts";
let mcp = readFileSync(mcpPath, "utf8");
const before = 'function trimValue(value: unknown, depth = 0, maxArray = 30): unknown {\n  if (depth > 7) return "[truncated]";';
const after = 'const MCP_MAX_NESTING_DEPTH = 10;\n\nfunction trimValue(value: unknown, depth = 0, maxArray = 30): unknown {\n  if (depth > MCP_MAX_NESTING_DEPTH) return "[truncated]";';
if (!mcp.includes(before)) throw new Error("MCP trimValue target not found");
mcp = mcp.replace(before, after);
writeFileSync(mcpPath, mcp);

const testPath = "scripts/test-mare-mcp.mjs";
let test = readFileSync(testPath, "utf8");
const marker = "  'X-MARE-MCP-Key',\n";
if (!test.includes(marker)) throw new Error("MCP test marker not found");
test = test.replace(marker, `${marker}  'const MCP_MAX_NESTING_DEPTH = 10;',\n`);
writeFileSync(testPath, test);
