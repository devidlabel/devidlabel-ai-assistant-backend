/**
 * Read-only Amazon IT inactive-offer recovery worklist.
 * Input: Amazon GET_MERCHANT_LISTINGS_INACTIVE_DATA TSV and a Shopify catalog
 * export. Neither source alone proves matching, manufacturer/RP or permission
 * to publish. The output is a candidate audit, NEVER a mutation feed.
 */
import fs from "node:fs";
import path from "node:path";

const KEY=/^[^\r\n\t]{1,150}$/;
const ASIN=/^[A-Z0-9]{10}$/;
const MAX_BYTES=64*1024*1024;
const MAX_ROWS=250000;
const HEADER={
  sku:["sku","seller-sku","seller_sku","sku venditore","sku del venditore"],
  asin:["asin","asin 1","asin1"],
  status:["status","stato"],
  reason:["reason","motivo"],
  issues:["issue description","issue_description","descrizione del problema","descrizione problema"],
};
function rowsTsv(text){
  if(typeof text!=="string"||Buffer.byteLength(text)>MAX_BYTES)throw Error("amazon_report_invalid_size");
  const rows=[];let cells=[],cell="",quote=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){if(quote&&text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}
    else if(ch==="\t"&&!quote){cells.push(cell);cell="";}
    else if((ch==="\n"||ch==="\r")&&!quote){
      if(ch==="\r"&&text[i+1]==="\n")i++;
      cells.push(cell);cell="";if(cells.some(x=>x.length))rows.push(cells);cells=[];
      if(rows.length>MAX_ROWS)throw Error("amazon_report_too_many_rows");
    }else cell+=ch;
  }
  if(quote)throw Error("amazon_report_unterminated_quote");
  if(cell||cells.length){cells.push(cell);if(cells.some(x=>x.length))rows.push(cells);}
  return rows;
}
function headersMap(header){
  const lower=header.map(x=>x.replace(/^\uFEFF/,"").trim().toLowerCase());
  const found={};for(const [key,aliases] of Object.entries(HEADER)){
    const indices=lower.map((x,i)=>aliases.includes(x)?i:-1).filter(i=>i>=0);
    if(indices.length>1||(["sku","asin","status"].includes(key)&&indices.length!==1))
      throw Error("amazon_report_header_"+key+"_unverified");
    found[key]=indices[0]??-1;
  }
  return found;
}
function shopifyVariants(snapshot){
  const raw=Array.isArray(snapshot)?snapshot:snapshot?.products;
  if(!Array.isArray(raw)||raw.length>100000)throw Error("shopify_catalog_invalid");
  const map=new Map();let duplicates=0,invalid=0;
  for(const product of raw){
    const p=product||{};
    const variants=Array.isArray(p.variants)?p.variants:p.variants?.nodes;
    if(!Array.isArray(variants)){invalid++;continue;}
    for(const variant of variants){
      const sku=variant?.sku,quantity=variant?.inventory_quantity??variant?.inventoryQuantity;
      if(typeof sku!=="string"||!KEY.test(sku)||sku!==sku.trim()){invalid++;continue;}
      if(map.has(sku)){duplicates++;map.set(sku,null);continue;}
      if(!Number.isSafeInteger(quantity)||quantity<0){invalid++;map.set(sku,null);continue;}
      map.set(sku,{sku,stock:quantity,brand:typeof p.vendor==="string"?p.vendor.trim():"",
        product_type:typeof p.product_type==="string"?p.product_type:
          typeof p.productType==="string"?p.productType:"",active:p.status==="ACTIVE",
        ean:variant.barcode??null});
    }
  }
  return {map,duplicates,invalid};
}
const GPSR=/\bgpsr\b|sicurezza dei prodotti|product safety|responsible person|persona responsabile|manufacturer (?:address|contact)|indirizzo.*responsabile/i;
function reasonClass(reason,issue){
  const s=(reason+" "+issue).slice(0,2500);
  if(/\b8541\b|conflitto di corrispondenza|matching conflict|product match conflict/i.test(s))
    return "CATALOG_IDENTITY_8541";
  if(GPSR.test(s))return "GPSR_DATA_REVIEW";
  if(/\b100632\b/.test(s))return "QUALIFICATION_100632_REVIEW";
  return "OTHER_INACTIVE_REVIEW";
}
function priority(category){return category==="GPSR_DATA_REVIEW"?1:category==="QUALIFICATION_100632_REVIEW"?2:
  category==="CATALOG_IDENTITY_8541"?4:3;}
function safeCell(x){return String(x??"").replace(/^[=+\-@]/,"'").replace(/[\t\r\n]/g," ").slice(0,180);}
export function buildAmazonItExistingRecoveryWorklist(amazonTsv,shopifySnapshot){
  const rows=rowsTsv(amazonTsv);
  if(rows.length<2)throw Error("amazon_report_empty");
  const h=headersMap(rows[0]),catalog=shopifyVariants(shopifySnapshot);
  const summary={source:"AMAZON_INACTIVE_TSV_SHOPIFY_CATALOG",marketplace:"IT",
    read_only:true,provider_mutations:0,listing_updates:0,manufacturer_verified:false,
    responsible_person_verified:false,safe_to_publish:false,
    report_marketplace_must_be_verified_externally:true,
    shopify_catalog_exhaustive:(!Array.isArray(shopifySnapshot)&&
      shopifySnapshot?.truncated===false&&
      !shopifySnapshot?.next_cursor),
    rows_scanned:0,positive_stock_existing_asin:0,zero_stock_excluded:0,
    missing_shopify_excluded:0,missing_asin_excluded:0,not_active_shopify_excluded:0,
    invalid_or_duplicate_excluded:0,deleted_or_not_inactive_excluded:0,
    by_brand:{},by_blocker:{}};
  const seen=new Set(),worklist=[];
  for(const row of rows.slice(1)){
    if(row.length!==rows[0].length){summary.invalid_or_duplicate_excluded++;continue;}
    const sku=row[h.sku]?.trim(),asin=row[h.asin]?.trim(),status=row[h.status]?.trim();
    summary.rows_scanned++;
    if(!sku||!KEY.test(sku)||seen.has(sku)){summary.invalid_or_duplicate_excluded++;continue;}
    seen.add(sku);
    if(/delet|eliminat|cancel|cancellat/i.test(status)){summary.deleted_or_not_inactive_excluded++;continue;}
    if(!/^(inactive|incomplete|suppressed|non attivo|non attiva|non attivo.*)$/i.test(status)){
      summary.deleted_or_not_inactive_excluded++;continue;
    }
    if(!asin||!ASIN.test(asin)){summary.missing_asin_excluded++;continue;}
    const item=catalog.map.get(sku);
    if(item===undefined){summary.missing_shopify_excluded++;continue;}
    if(!item){summary.invalid_or_duplicate_excluded++;continue;}
    if(!item.active){summary.not_active_shopify_excluded++;continue;}
    if(item.stock===0){summary.zero_stock_excluded++;continue;}
    const category=reasonClass(h.reason>=0?row[h.reason]:"",h.issues>=0?row[h.issues]:"");
    worklist.push({sku,asin,brand:item.brand,shopify_available:item.stock,
      shopify_ean:item.ean,product_type:item.product_type,priority:priority(category),
      blocker:category,direct_seller_sku_asin_verification:"REQUIRED",
      gpsr_contact_evidence:"NOT_VERIFIED",no_catalog_mutation:true});
    summary.positive_stock_existing_asin++;
    summary.by_brand[item.brand]=(summary.by_brand[item.brand]||0)+1;
    summary.by_blocker[category]=(summary.by_blocker[category]||0)+1;
  }
  worklist.sort((a,b)=>a.priority-b.priority||a.brand.localeCompare(b.brand)||a.sku.localeCompare(b.sku));
  return {summary,worklist};
}
export function worklistCsv(rows){
  const fields=["priority","brand","sku","asin","shopify_available","product_type",
    "blocker","direct_seller_sku_asin_verification","gpsr_contact_evidence"];
  return [fields.join(","),...rows.map(row=>fields.map(k=>
    '"'+safeCell(row[k]).replace(/"/g,'""')+'"').join(","))].join("\n")+"\n";
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  const args=Object.fromEntries(process.argv.slice(2).map(x=>{
    const i=x.indexOf("=");return [i<0?x:x.slice(0,i),i<0?"":x.slice(i+1)];
  }));
  if(!args["--amazon"]||!args["--shopify"]||!args["--out"]){
    throw Error("usage --amazon=/path/GET_MERCHANT_LISTINGS_INACTIVE_DATA.tsv --shopify=/path/catalog.json --out=/path/worklist");
  }
  const a=fs.readFileSync(args["--amazon"],"utf8");
  const b=JSON.parse(fs.readFileSync(args["--shopify"],"utf8"));
  const out=buildAmazonItExistingRecoveryWorklist(a,b);
  fs.writeFileSync(args["--out"]+".csv",worklistCsv(out.worklist));
  fs.writeFileSync(args["--out"]+".summary.json",JSON.stringify(out.summary,null,2)+"\n");
  process.stdout.write(JSON.stringify(out.summary)+"\n");
}
