import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../src/mare-business-shopify-complete.ts', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/export /g, '');
const js = stripTypeScriptTypes(source);
const calls = [];
const variants = [{id:'v1',inventoryItem:{inventoryLevels:{nodes:[],pageInfo:{hasNextPage:false}}}}];
let queue = [{products:{pageInfo:{hasNextPage:true,endCursor:'next'},nodes:[{
  id:'p1',variants:{nodes:variants,pageInfo:{hasNextPage:false}},
  media:{nodes:[],pageInfo:{hasNextPage:false}},collections:{nodes:[],pageInfo:{hasNextPage:false}}
}]}}];
const context = {
  TextEncoder, console,
  shopifyGraphQL: async (_env, query, variables) => {calls.push({query,variables});return queue.shift();},
  storeBusinessArtifact: async (_env, artifact) => ({...artifact,artifact_id:'mock',bytes:1,expires_at:'later'})
};
vm.createContext(context);
vm.runInContext(js+';globalThis.readCatalog=readShopifyCatalogComplete;',context);
const result = await context.readCatalog({after:'resume',max_products:1,include_csv:false},{});
assert.equal(calls[0].variables.after,'resume');
assert.equal(result.next_cursor,'next');
assert.equal(result.truncated,true);
assert.equal(result.complete_related_pagination,true);
queue = [{products:{pageInfo:{hasNextPage:false,endCursor:'end'},nodes:[{
  id:'p2',variants:{nodes:[{id:'v2',inventoryItem:{inventoryLevels:{nodes:[],pageInfo:{hasNextPage:true}}}}],pageInfo:{hasNextPage:false}},
  media:{nodes:[],pageInfo:{hasNextPage:true}},collections:{nodes:[],pageInfo:{hasNextPage:false}}
}]}}];
const incomplete = await context.readCatalog({max_products:1,include_csv:false},{});
assert.equal(incomplete.complete_related_pagination,false);
assert.equal(incomplete.products[0].variants[0].inventory_levels_complete,false);
queue = [{products:{pageInfo:{hasNextPage:false,endCursor:'end'},nodes:[{
  id:'p3',variants:{nodes:[{id:'v3',inventoryItem:{}}],pageInfo:{hasNextPage:false}}
}]}}];
const unknown = await context.readCatalog({max_products:1,include_csv:false},{});
assert.equal(unknown.complete_related_pagination,false);
assert.equal(unknown.products[0].variants[0].inventory_levels_complete,false);
console.log('PASS: cursor resume, truncation, complete related data, incomplete inventory, unknown pagination');
