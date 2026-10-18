import assert from 'node:assert/strict';
import {build} from 'esbuild';

const paths=['src/marketplace-amazon-orders-readonly.ts','src/marketplace-order-shadow-intake.ts','src/marketplace-core-ledger.ts'];
const modules=await Promise.all(paths.map(async p=>{const b=await build({entryPoints:[p],bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));}));
const {readAmazonOrdersPilot}=modules[0];
const {stageAmazonOrdersReadOnly}=modules[1];
const {MarketplaceCoreLedger}=modules[2];
console.log('PASS module load');
