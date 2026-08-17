import { shopifyGraphQL } from "./index.js";
import {
  storeBusinessArtifact,
  type MareBusinessShopifyEnv,
} from "./mare-business-shopify.js";

type JsonObject = Record<string, unknown>;

type PageInfo = { hasNextPage?: boolean; endCursor?: string | null };
type Connection<T> = { pageInfo?: PageInfo; nodes?: T[] };

type VariantNode = JsonObject & {
  inventoryItem?: JsonObject & {
    unitCost?: JsonObject | null;
    inventoryLevels?: Connection<JsonObject> | null;
  };
};

type ProductNode = JsonObject & {
  variants?: Connection<VariantNode> | null;
  collections?: Connection<JsonObject> | null;
  media?: Connection<JsonObject> | null;
};

type VariantPageData = { product?: { variants?: Connection<VariantNode> | null } | null };
type ProductPageData = { products?: Connection<ProductNode> };

const MAX_PRODUCTS = 2500;
const PRODUCT_PAGE_SIZE = 3;
const VARIANT_PAGE_SIZE = 20;

const PRODUCT_QUERY = `
  query MareBusinessCatalogComplete($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        vendor
        status
        productType
        tags
        createdAt
        updatedAt
        publishedAt
        descriptionHtml
        seo { title description }
        collections(first: 20) { nodes { id handle title } }
        media(first: 20) {
          nodes {
            id
            mediaContentType
            status
            alt
            ... on MediaImage {
              image { url width height }
              originalSource { url }
            }
          }
        }
        variants(first: 20) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            inventoryQuantity
            availableForSale
            selectedOptions { name value }
            inventoryItem {
              id
              tracked
              unitCost { amount currencyCode }
              inventoryLevels(first: 10) {
                nodes {
                  id
                  location { id name }
                  quantities(names: ["available", "on_hand", "committed"]) { name quantity }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const VARIANT_PAGE_QUERY = `
  query MareBusinessCatalogVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          sku
          barcode
          price
          compareAtPrice
          inventoryQuantity
          availableForSale
          selectedOptions { name value }
          inventoryItem {
            id
            tracked
            unitCost { amount currencyCode }
            inventoryLevels(first: 10) {
              nodes {
                id
                location { id name }
                quantities(names: ["available", "on_hand", "committed"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
`;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value); if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
function bool(value: unknown, fallback = false): boolean { return typeof value === "boolean" ? value : fallback; }
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function nodes(value: unknown): JsonObject[] { const connection = object(value); return Array.isArray(connection.nodes) ? connection.nodes.filter((item) => item && typeof item === "object").map((item) => item as JsonObject) : []; }
function csvCell(value: unknown): string { const text = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value); return `"${text.replace(/"/g, '""')}"`; }

function mapVariant(raw: VariantNode): JsonObject {
  const inventoryItem = object(raw.inventoryItem); const unitCost = object(inventoryItem.unitCost);
  const inventoryLevels = nodes(inventoryItem.inventoryLevels).map((level) => { const location = object(level.location); return { id: level.id ?? null, location_id: location.id ?? null, location_name: location.name ?? null, quantities: Array.isArray(level.quantities) ? level.quantities : [] }; });
  return { id: raw.id ?? null, title: raw.title ?? null, sku: raw.sku ?? null, barcode: raw.barcode ?? null, price: raw.price ?? null, compare_at_price: raw.compareAtPrice ?? null, inventory_quantity: raw.inventoryQuantity ?? null, available_for_sale: raw.availableForSale ?? null, selected_options: Array.isArray(raw.selectedOptions) ? raw.selectedOptions : [], inventory_item_id: inventoryItem.id ?? null, inventory_tracked: inventoryItem.tracked ?? null, unit_cost: unitCost.amount ?? null, cost_currency: unitCost.currencyCode ?? null, inventory_levels: inventoryLevels };
}

function mapProduct(raw: ProductNode, completeVariants: VariantNode[]): JsonObject {
  const media = nodes(raw.media).map((item, index) => { const image = object(item.image); const original = object(item.originalSource); return { id: item.id ?? null, position: index + 1, type: item.mediaContentType ?? null, status: item.status ?? null, alt: item.alt ?? null, url: original.url ?? image.url ?? null, width: image.width ?? null, height: image.height ?? null }; });
  const collections = nodes(raw.collections).map((collection) => ({ id: collection.id ?? null, handle: collection.handle ?? null, title: collection.title ?? null }));
  const seo = object(raw.seo); const variants = completeVariants.map(mapVariant);
  return { id: raw.id ?? null, title: raw.title ?? null, handle: raw.handle ?? null, vendor: raw.vendor ?? null, status: raw.status ?? null, product_type: raw.productType ?? null, tags: Array.isArray(raw.tags) ? raw.tags : [], created_at: raw.createdAt ?? null, updated_at: raw.updatedAt ?? null, published_at: raw.publishedAt ?? null, description_html: raw.descriptionHtml ?? null, seo_title: seo.title ?? null, seo_description: seo.description ?? null, collections, media_count: media.length, media, variant_count: variants.length, variants };
}

async function loadAllVariants(product: ProductNode, env: MareBusinessShopifyEnv): Promise<VariantNode[]> {
  const initial = (product.variants?.nodes || []) as VariantNode[]; const result = [...initial];
  let hasNextPage = Boolean(product.variants?.pageInfo?.hasNextPage); let after = normalize(product.variants?.pageInfo?.endCursor) || null; const productId = normalize(product.id); if (!productId) return result;
  while (hasNextPage && after) { const data: VariantPageData = await shopifyGraphQL<VariantPageData>(env, VARIANT_PAGE_QUERY, { id: productId, first: VARIANT_PAGE_SIZE, after }); const connection = data.product?.variants; result.push(...(connection?.nodes || [])); hasNextPage = Boolean(connection?.pageInfo?.hasNextPage); after = normalize(connection?.pageInfo?.endCursor) || null; }
  return result;
}

function buildCatalogCsv(products: JsonObject[]): string {
  const headers = ["Product ID","Handle","Title","Vendor","Status","Product Type","Tags","Product Created At","Product Updated At","Published At","SEO Title","SEO Description","Variant ID","Variant Title","SKU","Barcode","Price","Compare At Price","Unit Cost","Cost Currency","Inventory Quantity","Available For Sale","Selected Options","Inventory Levels","Collections","Media Count","Media"];
  const lines = [headers.map(csvCell).join(",")];
  for (const product of products) { const variants = Array.isArray(product.variants) ? product.variants as JsonObject[] : []; for (const variant of variants.length ? variants : [{}]) lines.push([product.id,product.handle,product.title,product.vendor,product.status,product.product_type,product.tags,product.created_at,product.updated_at,product.published_at,product.seo_title,product.seo_description,variant.id,variant.title,variant.sku,variant.barcode,variant.price,variant.compare_at_price,variant.unit_cost,variant.cost_currency,variant.inventory_quantity,variant.available_for_sale,variant.selected_options,variant.inventory_levels,product.collections,product.media_count,product.media].map(csvCell).join(",")); }
  return `${lines.join("\n")}\n`;
}

export async function readShopifyCatalogComplete(args: JsonObject, env: MareBusinessShopifyEnv): Promise<JsonObject> {
  const query = normalize(args.query); const maxProducts = integer(args.max_products,1000,1,MAX_PRODUCTS); const inlineLimit = integer(args.inline_limit,25,0,100); const includeCsv = bool(args.include_csv,true); let after: string|null=null; let hasNextPage=true; const products:JsonObject[]=[]; let paginatedVariantProducts=0;
  while (hasNextPage && products.length < maxProducts) { const first=Math.min(PRODUCT_PAGE_SIZE,maxProducts-products.length); const data:ProductPageData=await shopifyGraphQL<ProductPageData>(env,PRODUCT_QUERY,{first,after,query:query||null}); const connection:Connection<ProductNode>=data.products||{}; for(const product of connection.nodes||[]){const completeVariants=await loadAllVariants(product,env); if(product.variants?.pageInfo?.hasNextPage) paginatedVariantProducts+=1; products.push(mapProduct(product,completeVariants));} hasNextPage=Boolean(connection.pageInfo?.hasNextPage); after=normalize(connection.pageInfo?.endCursor)||null; if(!after) hasNextPage=false; }
  const generatedAt=new Date().toISOString(); const payload={generated_at:generatedAt,query:query||null,complete_variant_pagination:true,products};
  const jsonArtifact=await storeBusinessArtifact(env,{kind:"shopify_catalog_complete_json",filename:`shopify-catalog-complete-${generatedAt.slice(0,10)}.json`,mime_type:"application/json",encoding:"utf-8",content:JSON.stringify(payload),metadata:{product_count:products.length,truncated:hasNextPage,complete_variant_pagination:true,paginated_variant_products:paginatedVariantProducts}});
  const csvArtifact=includeCsv?await storeBusinessArtifact(env,{kind:"shopify_catalog_complete_csv",filename:`shopify-catalog-complete-${generatedAt.slice(0,10)}.csv`,mime_type:"text/csv",encoding:"utf-8",content:buildCatalogCsv(products),metadata:{product_count:products.length,truncated:hasNextPage,complete_variant_pagination:true,paginated_variant_products:paginatedVariantProducts}}):null;
  const variantCount=products.reduce((sum,p)=>sum+Number(p.variant_count||0),0); const mediaCount=products.reduce((sum,p)=>sum+Number(p.media_count||0),0);
  return {ok:true,source:"shopify_admin_graphql",query:query||null,product_count:products.length,variant_count:variantCount,media_count:mediaCount,truncated:hasNextPage,next_cursor:after,complete_variant_pagination:true,paginated_variant_products:paginatedVariantProducts,artifacts:{json:{artifact_id:jsonArtifact.artifact_id,filename:jsonArtifact.filename,bytes:jsonArtifact.bytes,expires_at:jsonArtifact.expires_at},csv:csvArtifact?{artifact_id:csvArtifact.artifact_id,filename:csvArtifact.filename,bytes:csvArtifact.bytes,expires_at:csvArtifact.expires_at}:null},products:products.slice(0,inlineLimit),inline_product_count:Math.min(products.length,inlineLimit)};
}
