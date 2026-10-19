type JsonObject = Record<string, unknown>;

export type MareBusinessCapability = {
  id: string;
  provider: string;
  domain: string;
  operation: "read" | "prepare" | "execute" | "artifact" | "job";
  risk: "read_only" | "artifact_only" | "reversible_write" | "live_write" | "irreversible";
  implemented: boolean;
  configured: boolean;
  available: boolean;
  approval: "none" | "prepare" | "explicit" | "strong";
  description: string;
  request_schema: JsonObject;
  missing: string[];
};

export type MareBusinessCapabilityEnv = {
  MARE_BUSINESS_ACCESS_TOKEN?: string;
  MARE_MARKETPLACE_SHADOW?: unknown;
  MARE_MCP_ACCESS_TOKEN?: string;
  MARE_OPS_ACCESS_TOKEN?: string;
  MARE_PRODUCT_MEDIA_ACCESS_TOKEN?: string;
  SHOPIFY_SHOP_DOMAIN?: string;
  SHOPIFY_TOKENS_KV?: unknown;
  OPENAI_API_KEY?: string;
  IMAGES?: unknown;
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_OPERATIONS_API_KEY?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GITHUB_OPERATIONS_TOKEN?: string;
  GITHUB_OPERATIONS_REPOSITORIES?: string;
  TIKTOK_APP_ID?: string;
  TIKTOK_APP_SECRET?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_REFRESH_TOKEN?: string;
  TIKTOK_ADVERTISER_ID?: string;
  GOOGLE_MERCHANT_ACCOUNT_ID?: string;
  GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_MERCHANT_REFRESH_TOKEN?: string;
  AMAZON_SP_API_REFRESH_TOKEN?: string;
  AMAZON_SP_API_CLIENT_ID?: string;
  AMAZON_SP_API_CLIENT_SECRET?: string;
  AMAZON_SP_API_SELLER_ID?: string;
  AMAZON_OFFER_PREVIEW_ENABLED?: string;
  SPARTOO_API_KEY?: string;
  MIINTO_API_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  [key: string]: unknown;
};

function configured(...values: unknown[]): boolean {
  return values.every((value) => typeof value === "string" ? value.trim().length > 0 : Boolean(value));
}

function schema(properties: JsonObject = {}, required: string[] = []): JsonObject {
  return { type: "object", properties, required, additionalProperties: true };
}

function capability(
  input: Omit<MareBusinessCapability, "available" | "missing"> & { requirements?: Array<[boolean, string]> },
): MareBusinessCapability {
  const missing = (input.requirements || []).filter(([ok]) => !ok).map(([, name]) => name);
  const { requirements: _requirements, ...rest } = input;
  return { ...rest, missing, available: rest.implemented && rest.configured && missing.length === 0 };
}

export function buildMareBusinessCapabilities(env: MareBusinessCapabilityEnv): MareBusinessCapability[] {
  const businessAuth = configured(env.MARE_BUSINESS_ACCESS_TOKEN);
  const commerce = configured(env.MARE_MCP_ACCESS_TOKEN);
  const operations = configured(env.MARE_OPS_ACCESS_TOKEN);
  const media = configured(env.MARE_PRODUCT_MEDIA_ACCESS_TOKEN);
  const shopify = configured(env.SHOPIFY_SHOP_DOMAIN, env.SHOPIFY_TOKENS_KV);
  const imagePipeline = configured(env.OPENAI_API_KEY, env.IMAGES);
  const klaviyoWrite = configured(env.KLAVIYO_OPERATIONS_API_KEY);
  const metaWrite = configured(env.META_ADS_ACCESS_TOKEN, env.META_WRITE_ACCESS_TOKEN);
  const googleWrite = configured(env.GOOGLE_ADS_DEVELOPER_TOKEN) && configured(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON || env.GOOGLE_ADS_REFRESH_TOKEN);
  const githubWrite = configured(env.GITHUB_OPERATIONS_TOKEN, env.GITHUB_OPERATIONS_REPOSITORIES);
  const tiktokApp = configured(env.TIKTOK_APP_ID, env.TIKTOK_APP_SECRET);
  const tiktokAuthorized = configured(env.TIKTOK_ACCESS_TOKEN, env.TIKTOK_ADVERTISER_ID);
  const merchant = configured(env.GOOGLE_MERCHANT_ACCOUNT_ID) && configured(env.GOOGLE_MERCHANT_SERVICE_ACCOUNT_JSON || env.GOOGLE_MERCHANT_REFRESH_TOKEN);
  const amazon = configured(env.AMAZON_SP_API_REFRESH_TOKEN, env.AMAZON_SP_API_CLIENT_ID, env.AMAZON_SP_API_CLIENT_SECRET);
  const amazonSellerId = configured(env.AMAZON_SP_API_SELLER_ID);
  const orderEvidence = businessAuth && configured(env.MARE_ORDER_JOURNAL, env.COMMERCE_TENANT_ID, env.SHOPIFY_SHOP_DOMAIN) &&
    amazonSellerId && env.MARE_ORDER_JOURNAL_ENABLED === "true";

  return [
    capability({ id: "system.status", provider: "mare", domain: "system", operation: "read", risk: "read_only", implemented: true, configured: businessAuth, approval: "none", description: "Unified health, permission and provider configuration status.", request_schema: schema(), requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"]] }),
    capability({
      id: "amazon.catalog.exact.match",
      provider: "amazon", domain: "marketplace", operation: "read",
      risk: "read_only", implemented: true, configured: businessAuth && amazon,
      approval: "none",
      description: "Merchant-private exact Amazon Catalog Items lookup: up to eight validated EAN or UPC codes in IT DE FR ES. Returns possible ASINs only; never creates offers or changes listings.",
      request_schema: schema({
        marketplace: { type: "string", enum: ["IT", "DE", "FR", "ES"] },
        identifier_type: { type: "string", enum: ["EAN", "UPC"] },
        identifiers: { type: "array", minItems: 1, maxItems: 8,
          items: { type: "string" } }
      }, ["marketplace", "identifier_type", "identifiers"]),
      requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"], [amazon, "Amazon SP-API credentials"]]
    }),
    capability({
      id: "amazon.listing.new_asin.requirements.readonly",
      provider: "amazon", domain: "marketplace", operation: "read", risk: "read_only",
      implemented: true, configured: businessAuth && amazon && amazonSellerId && shopify, approval: "none",
      description: "Read-only new-ASIN Product Type Definitions research for a uniquely identified, ACTIVE Shopify SKU with validated EAN and stock. Confirms seller-SKU absence and EAN exact lookup, retrieves marketplace product-type recommendations, and optionally inspects an explicit LISTING standalone schema. Does not validate or submit any listing, check brand authorization or switch Channable ownership.",
      request_schema: {...schema({
        marketplace: {type:"string",enum:["IT","DE","FR","ES"]},
        sku: {type:"string",minLength:1,maxLength:120,pattern:"^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$"},
        product_type: {type:"string",pattern:"^[A-Z][A-Z0-9_]{1,79}$"},
      },["marketplace","sku"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [amazon,"Amazon SP-API credentials"],[amazonSellerId,"AMAZON_SP_API_SELLER_ID"],[shopify,"Shopify OAuth/KV"]]
    }),
    capability({
      id: "amazon.catalog.asin.details",
      provider: "amazon", domain: "marketplace", operation: "read",
      risk: "read_only", implemented: true, configured: businessAuth && amazon,
      approval: "none",
      description: "Merchant-private read-only Amazon Catalog Item summaries by ASIN and IT/DE/FR/ES. Returns brand, title, category and variant attributes; no offer changes.",
      request_schema: schema({
        marketplace: { type: "string", enum: ["IT", "DE", "FR", "ES"] },
        asins: { type: "array", minItems: 1, maxItems: 3,
          items: { type: "string", pattern: "^[A-Z0-9]{10}$" } }
      }, ["marketplace", "asins"]),
      requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"], [amazon, "Amazon SP-API credentials"]]
    }),
    capability({
      id:"amazon.seller.sku.status",provider:"amazon",domain:"marketplace",
      operation:"read",risk:"read_only",implemented:true,
      configured:businessAuth&&amazon,approval:"none",
      description:"Merchant-private SKU status from existing recent Amazon seller report, refuses unverified missing classifications. Never changes offers.",
      request_schema:schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        skus:{type:"array",minItems:1,maxItems:8,items:{type:"string"}}
      },["marketplace","skus"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazon,"Amazon SP-API credentials"]]
    }),
    capability({
      id:"amazon.seller.listings.direct",
      provider:"amazon",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&amazon&&amazonSellerId,
      approval:"none",
      description:"Merchant-private seller listing GET via Amazon Listings Items, independent of reports. Reads current FBM availability and per-market offers/prices with separate identity, quantity and price evidence. Missing data stays unknown, never zero; complete_evidence alone is not stock or price proof. Never writes or transfers Channable ownership.",
      request_schema:{...schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        skus:{type:"array",minItems:1,maxItems:8,uniqueItems:true,items:{type:"string",minLength:1,maxLength:120,pattern:"^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$"}}
      },["marketplace","skus"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"]]
    }),
    capability({
      id:"amazon.seller.asin.direct",
      provider:"amazon",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&amazon&&amazonSellerId,
      approval:"none",
      description:"Search seller ASIN via Listings Items GET to detect existing offers under OTHER seller SKUs. Empty search is not a publish permit. Read-only, bounded pages.",
      request_schema:schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        asins:{type:"array",minItems:1,maxItems:4,
          items:{type:"string",pattern:"^[A-Z0-9]{10}$"}}
      },["marketplace","asins"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"]]
    }),
    capability({
      id: "amazon.inventory.eu.shadow.readonly",
      provider:"amazon",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&amazon&&amazonSellerId&&shopify,approval:"none",
      description:"Read up to eight Shopify SKUs once and compare their live seller offer identity, FBM quantity and B2C price across Amazon IT/DE/FR/ES. Read-only shadow evidence only: it cannot change stock, price, listings, orders or writer ownership.",
      request_schema:{...schema({
        skus:{type:"array",minItems:1,maxItems:8,uniqueItems:true,
          items:{type:"string",minLength:1,maxLength:120,pattern:"^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$"}}
      },["skus"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"],[shopify,"Shopify OAuth/KV"]]
    }),
    capability({
      id:"amazon.offer.preflight",provider:"amazon",domain:"marketplace",
      operation:"read",risk:"read_only",implemented:true,
      configured:businessAuth&&amazon&&amazonSellerId&&shopify,approval:"none",
      description:"Fail-closed Amazon EU Offer Only preflight: verifies Shopify identity, exact EAN-to-ASIN, seller listing absence, restrictions and product type; never publishes.",
      request_schema:schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        sku:{type:"string"},ean:{type:"string",pattern:"^[0-9]{13}$"},
        asin:{type:"string",pattern:"^[A-Z0-9]{10}$"}
      },["marketplace","sku","ean","asin"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"],
        [shopify,"Shopify OAuth/KV"]]
    }),
    capability({
      id:"amazon.offer.validation.preview",provider:"amazon",domain:"marketplace",
      operation:"prepare",risk:"artifact_only",approval:"none",implemented:true,
      configured:businessAuth&&amazon&&amazonSellerId&&shopify&&env.AMAZON_OFFER_PREVIEW_ENABLED==="true",
      description:"Run one server-built Amazon OFFER_ONLY validation preview after fresh Shopify and Amazon preflight. Fixed PUT mode=VALIDATION_PREVIEW and quantity=0; no listing, stock, price or order mutation. Returns bounded issue codes and attribute names. The private MARE plan is stored for 24 hours; VALID never means published or authorized for live writes.",
      request_schema:{...schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        sku:{type:"string",minLength:1,maxLength:120,pattern:"^[A-Za-z0-9][A-Za-z0-9_ .-]{0,119}$"},
        ean:{type:"string",pattern:"^[0-9]{13}$"},
        asin:{type:"string",pattern:"^[A-Z0-9]{10}$"}
      },["marketplace","sku","ean","asin"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"],[shopify,"Shopify OAuth/KV and private plan store"],
        [env.AMAZON_OFFER_PREVIEW_ENABLED==="true","AMAZON_OFFER_PREVIEW_ENABLED=true (validation only)"]]
    }),
    capability({
      id:"amazon.orders.observe.readonly",
      provider:"amazon",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&amazon&&amazonSellerId,
      approval:"none",
      description:"Privacy-minimal Amazon Orders v2026-01-01 search with bounded complete pagination and no buyer/address/payments datasets. Observes FBM orders only; NEVER imports Shopify orders, updates inventory, or changes tracking.",
      request_schema:schema({
        marketplaces:{type:"array",minItems:1,maxItems:4,
          items:{type:"string",enum:["IT","DE","FR","ES"]}},
        last_updated_after:{type:"string"},
        last_updated_before:{type:"string"},
        max_pages:{type:"integer",minimum:1,maximum:5}
      },["marketplaces","last_updated_after","last_updated_before"]),
      requirements:[
        [businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"]
      ]
    }),
    capability({
      id: "amazon.shipment.confirmation.preview",
      provider:"amazon",domain:"marketplace",operation:"prepare",risk:"artifact_only",
      implemented:true,configured:businessAuth&&amazon&&amazonSellerId&&shopify,approval:"none",
      description:"Prepare a zero-mutation Amazon Orders v0 confirmShipment preview from one existing Channable-imported Shopify order. Server-side reads require an UNSHIPPED merchant order, complete SUCCESS fulfillments, one tracking entry per package, complete quantity mapping and a configured carrier-code mapping. Tracking numbers are never returned. No Amazon confirmation is sent.",
      request_schema:{...schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        shopify_order_gid:{type:"string",pattern:"^gid://shopify/Order/[0-9]+$"},
        amazon_order_id:{type:"string",pattern:"^[0-9]{3}-[0-9]{7}-[0-9]{7}$"}
      },["marketplace","shopify_order_gid","amazon_order_id"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"],[shopify,"Shopify OAuth/KV (read_orders)"]]
    }),
    capability({
      id:"marketplace.amazon.shipment_reconciliation.readonly",
      provider:"mare",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&amazon&&amazonSellerId&&shopify,approval:"none",
      description:"Read one Amazon order's packages and current Channable Shopify fulfillments server-side. Compare exact tracking and line quantities; return aggregate evidence only. Missing or ambiguous records require review. No shipment confirmation, customer fields, raw identifiers, tracking values, inventory change or Channable handoff.",
      request_schema:{...schema({
        marketplace:{type:"string",enum:["IT","DE","FR","ES"]},
        shopify_order_gid:{type:"string",pattern:"^gid://shopify/Order/[0-9]+$"},
        amazon_order_id:{type:"string",pattern:"^[0-9]{3}-[0-9]{7}-[0-9]{7}$"}
      },["marketplace","shopify_order_gid","amazon_order_id"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"],[shopify,"Shopify OAuth/KV (read_orders)"]]
    }),
    capability({
      id:"marketplace.order.evidence.capture",provider:"mare",domain:"marketplace",
      operation:"prepare",risk:"artifact_only",approval:"none",implemented:true,
      configured:orderEvidence&&amazon&&shopify,
      description:"Read Amazon and Shopify server-side, verify one existing Channable order and its SKU quantities, persist SHADOW_ONLY evidence in the private journal, and verify a separate readback. Local audit writes only: no provider mutation, import, inventory adjustment, tracking, cursor, or ownership transfer. Never accepts caller-supplied observations.",
      request_schema:{...schema({
        marketplaces:{type:"array",minItems:1,maxItems:4,uniqueItems:true,items:{type:"string",enum:["IT","DE","FR","ES"]}},
        amazon_order_id:{type:"string",pattern:"^[0-9]{3}-[0-9]{7}-[0-9]{7}$"},
        last_updated_after:{type:"string"},last_updated_before:{type:"string"},
        shopify_created_after:{type:"string"},shopify_created_before:{type:"string"},
        amazon_max_pages:{type:"integer",minimum:1,maximum:5},
        shopify_max_pages:{type:"integer",minimum:1,maximum:10}
      },["marketplaces","amazon_order_id","last_updated_after","last_updated_before","shopify_created_after","shopify_created_before"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazon,"Amazon SP-API credentials"],
        [amazonSellerId,"AMAZON_SP_API_SELLER_ID"],[shopify,"Shopify OAuth/KV (read_orders)"],
        [Boolean(env.MARE_ORDER_JOURNAL),"MARE_ORDER_JOURNAL binding"],
        [configured(env.COMMERCE_TENANT_ID),"COMMERCE_TENANT_ID"],
        [env.MARE_ORDER_JOURNAL_ENABLED==="true","MARE_ORDER_JOURNAL_ENABLED=true"]]
    }),
    capability({
      id:"marketplace.order.evidence.read",provider:"mare",domain:"marketplace",
      operation:"read",risk:"read_only",approval:"none",implemented:true,configured:orderEvidence,
      description:"Read and verify one stored order-evidence receipt in the current tenant, seller and Shopify store scope. No provider request or write. SHADOW_ONLY evidence does not authorize order import, inventory, tracking, or Channable handoff.",
      request_schema:{...schema({receipt_id:{type:"string",pattern:"^[a-f0-9]{64}$"}},["receipt_id"]),additionalProperties:false},
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[amazonSellerId,"AMAZON_SP_API_SELLER_ID"],
        [Boolean(env.MARE_ORDER_JOURNAL),"MARE_ORDER_JOURNAL binding"],
        [configured(env.COMMERCE_TENANT_ID,env.SHOPIFY_SHOP_DOMAIN),"Tenant and Shopify store scope"],
        [env.MARE_ORDER_JOURNAL_ENABLED==="true","MARE_ORDER_JOURNAL_ENABLED=true"]]
    }),
    capability({ id: "marketplace.shadow.status", provider: "mare", domain: "marketplace", operation: "read", risk: "read_only", implemented: true, configured: businessAuth && Boolean(env.MARE_MARKETPLACE_SHADOW), approval: "none", description: "Read Shopify shadow scan progress, freshness and errors. Does not start scans or publish marketplace data.", request_schema: schema(), requirements: [[Boolean(env.MARE_MARKETPLACE_SHADOW), "MARE_MARKETPLACE_SHADOW binding"]] }),
    capability({ id: "system.capabilities", provider: "mare", domain: "system", operation: "read", risk: "read_only", implemented: true, configured: businessAuth, approval: "none", description: "Dynamic capability registry used by every V2 agent.", request_schema: schema(), requirements: [[businessAuth, "MARE_BUSINESS_ACCESS_TOKEN"]] }),
    capability({ id: "artifact.get", provider: "mare", domain: "artifact", operation: "artifact", risk: "read_only", implemented: true, configured: shopify, approval: "none", description: "Retrieve a stored report, feed, Matrixify file or image artifact.", request_schema: schema({ artifact_id: { type: "string" } }, ["artifact_id"]), requirements: [[shopify, "SHOPIFY_TOKENS_KV"]] }),

    capability({
      id:"shopify.marketplace.amazon_order_adoption.readonly",
      provider:"shopify",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&shopify,approval:"none",
      description:"Scan Channable-imported Shopify Amazon orders for Amazon Order ID custom attributes; detect duplicates and missing metadata. Does not prove absence and NEVER creates orders.",
      request_schema:schema({
        created_after:{type:"string"},
        created_before:{type:"string"},
        max_pages:{type:"integer",minimum:1,maximum:10}
      },["created_after","created_before"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [shopify,"Shopify OAuth/KV (read_orders)"]]
    }),
    capability({
      id:"shopify.marketplace.amazon_order_lines.readonly",
      provider:"shopify",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&shopify,approval:"none",
      description:"Read Shopify line SKU and quantities for one Channable-imported Amazon order after verifying its Amazon Order ID. No buyer data, inventory mutation, fulfillment or order import.",
      request_schema:schema({
        shopify_order_gid:{type:"string"},
        amazon_order_id:{type:"string",pattern:"^[0-9]{3}-[0-9]{7}-[0-9]{7}$"}
      },["shopify_order_gid","amazon_order_id"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[shopify,"Shopify OAuth/KV (read_orders)"]]
    }),
    capability({
      id:"shopify.marketplace.fulfillment_metadata.readonly",
      provider:"shopify",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&shopify,approval:"none",
      description:"Read-only Channable Amazon/Spartoo fulfillment quantities, carrier names and tracking-number presence on Shopify. Tracking numbers are reduced to counts in memory; no raw tracking numbers, URLs, recipients or addresses are returned. Cannot send shipment confirmations.",
      request_schema:schema({
        provider:{type:"string",enum:["amazon","spartoo"]},
        shopify_order_gid:{type:"string"},
        external_order_id:{type:"string"}
      },["provider","shopify_order_gid","external_order_id"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [shopify,"Shopify OAuth/KV (read_orders)"]]
    }),
    capability({
      id:"shopify.marketplace.amazon_fulfillment_review.readonly",
      provider:"shopify",domain:"marketplace",operation:"read",risk:"read_only",
      implemented:true,configured:businessAuth&&shopify,approval:"none",
      description:"Read current Channable-imported Amazon order lines and Shopify fulfillments server-side; compare SUCCESS quantities, line identity and tracking-number presence. No caller-supplied evidence, raw tracking values, provider mutations or importer handoff.",
      request_schema:schema({
        shopify_order_gid:{type:"string",pattern:"^gid://shopify/Order/[0-9]+$"},
        amazon_order_id:{type:"string",pattern:"^[0-9]{3}-[0-9]{7}-[0-9]{7}$"}
      },["shopify_order_gid","amazon_order_id"]),
      requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],
        [shopify,"Shopify OAuth/KV (read_orders)"]]
    }),
    capability({ id:"shopify.marketplace.api_readiness.readonly",provider:"shopify",domain:"marketplace",operation:"read",risk:"read_only",implemented:true,configured:businessAuth&&shopify,approval:"none",description:"Observe the configured and actual X-Shopify-API-Version using the same authenticated M.A.R.E. Shopify client. Report fall-forward, missing headers or unverified support without exposing credentials or authorizing marketplace writes.",request_schema:schema(),requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[shopify,"Shopify OAuth/KV"]] }),
    capability({ id:"shopify.marketplace.scopes.readonly",provider:"shopify",domain:"marketplace",operation:"read",risk:"read_only",implemented:true,configured:businessAuth&&shopify,approval:"none",description:"Read currentAppInstallation access scopes using the same M.A.R.E. Shopify client; distinguish implied read access from cached metadata. No credentials returned and no order, inventory or tracking write authorization.",request_schema:schema(),requirements:[[businessAuth,"MARE_BUSINESS_ACCESS_TOKEN"],[shopify,"Shopify OAuth/KV"]] }),
    capability({ id: "shopify.catalog.read", provider: "shopify", domain: "catalog", operation: "read", risk: "read_only", implemented: true, configured: shopify, approval: "none", description: "Read the complete Shopify catalog with products, variants, SKU, prices, compare-at prices, costs, stock by location, collections and media.", request_schema: schema({ query: { type: "string" }, max_products: { type: "integer", minimum: 1, maximum: 2500 }, inline_limit: { type: "integer", minimum: 0, maximum: 100 }, include_csv: { type: "boolean" } }), requirements: [[shopify, "Shopify OAuth/KV"]] }),
    capability({ id: "shopify.catalog.export", provider: "shopify", domain: "catalog", operation: "artifact", risk: "artifact_only", implemented: true, configured: shopify, approval: "none", description: "Export the canonical Shopify catalog as JSON and CSV artifacts.", request_schema: schema({ query: { type: "string" }, max_products: { type: "integer" }, include_csv: { type: "boolean" } }), requirements: [[shopify, "Shopify OAuth/KV"]] }),
    capability({ id: "shopify.media.find", provider: "shopify", domain: "media", operation: "read", risk: "read_only", implemented: true, configured: media, approval: "none", description: "Find product media by vendor and inclusive title range.", request_schema: schema({ vendor: { type: "string" }, start_title: { type: "string" }, end_title: { type: "string" }, max_products: { type: "integer" } }, ["vendor"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"]] }),
    capability({ id: "shopify.media.read", provider: "shopify", domain: "media", operation: "read", risk: "read_only", implemented: true, configured: media, approval: "none", description: "Read one original Shopify product image for visual inspection.", request_schema: schema({ product_id: { type: "string" }, media_id: { type: "string" } }, ["product_id", "media_id"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"]] }),
    capability({ id: "shopify.media.preview", provider: "shopify", domain: "media", operation: "prepare", risk: "artifact_only", implemented: true, configured: media && imagePipeline, approval: "explicit", description: "Generate a strict product-faithful 600x771 white-background preview without altering Shopify.", request_schema: schema({ product_id: { type: "string" }, media_id: { type: "string" }, idempotency_key: { type: "string" } }, ["product_id", "media_id", "idempotency_key"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"], [imagePipeline, "OPENAI_API_KEY and IMAGES"]] }),
    capability({ id: "shopify.media.publish", provider: "shopify", domain: "media", operation: "execute", risk: "live_write", implemented: true, configured: media && shopify, approval: "explicit", description: "Publish an approved stored preview to the matching Shopify product while preserving originals.", request_schema: schema({ preview_id: { type: "string" }, product_id: { type: "string" }, idempotency_key: { type: "string" }, alt_text: { type: "string" }, make_primary: { type: "boolean" } }, ["preview_id", "product_id", "idempotency_key"]), requirements: [[media, "MARE_PRODUCT_MEDIA_ACCESS_TOKEN"], [shopify, "Shopify write_products"]] }),

    capability({ id: "commerce.daily_pulse", provider: "mare", domain: "commerce", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Executive Shopify and paid-media pulse using the established ecommerce channel policy.", request_schema: schema(), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "shopify.commerce.report", provider: "shopify", domain: "commerce", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Shopify revenue, orders and channel segmentation report.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "paid_media.report", provider: "multi", domain: "advertising", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Combined Meta and Google Ads reporting with non-additive attribution guardrail.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "ga4.report", provider: "google_analytics", domain: "analytics", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "GA4 traffic and funnel diagnostics.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "ga4.realtime", provider: "google_analytics", domain: "analytics", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "GA4 realtime aggregate diagnostics.", request_schema: schema(), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "search_console.report", provider: "search_console", domain: "seo", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Search Console queries, pages, devices and countries.", request_schema: schema({ timeframe: { type: "string" }, top_rows: { type: "integer" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),
    capability({ id: "klaviyo.report", provider: "klaviyo", domain: "crm", operation: "read", risk: "read_only", implemented: true, configured: commerce, approval: "none", description: "Klaviyo campaign and flow reporting.", request_schema: schema({ timeframe: { type: "string" } }), requirements: [[commerce, "MARE_MCP_ACCESS_TOKEN"]] }),

    capability({ id: "permissions.audit", provider: "mare", domain: "security", operation: "read", risk: "read_only", implemented: true, configured: operations, approval: "none", description: "Provider permissions and missing configuration audit without exposing secrets.", request_schema: schema(), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"]] }),
    capability({ id: "klaviyo.campaign.draft.create", provider: "klaviyo", domain: "crm", operation: "execute", risk: "reversible_write", implemented: true, configured: operations && klaviyoWrite, approval: "explicit", description: "Create a Klaviyo campaign draft only.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [klaviyoWrite, "KLAVIYO_OPERATIONS_API_KEY"]] }),
    capability({ id: "klaviyo.campaign.draft.update", provider: "klaviyo", domain: "crm", operation: "execute", risk: "reversible_write", implemented: true, configured: operations && klaviyoWrite, approval: "explicit", description: "Update an existing Klaviyo campaign while it remains Draft.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [klaviyoWrite, "KLAVIYO_OPERATIONS_API_KEY"]] }),
    capability({ id: "meta.entity.mutate", provider: "meta", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: operations && metaWrite, approval: "explicit", description: "Create or update Meta campaigns, ad sets and ads. New entities default to PAUSED.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [metaWrite, "Meta ads_management credentials"]] }),
    capability({ id: "google_ads.campaign.update", provider: "google_ads", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: operations && googleWrite, approval: "explicit", description: "Update an existing Google Ads campaign name, state or daily budget.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [googleWrite, "Google Ads write credentials"]] }),
    capability({ id: "github.pull_request.create", provider: "github", domain: "engineering", operation: "execute", risk: "reversible_write", implemented: true, configured: operations && githubWrite, approval: "explicit", description: "Create a mare/* branch, write allowlisted files and open a draft pull request.", request_schema: schema({}, []), requirements: [[operations, "MARE_OPS_ACCESS_TOKEN"], [githubWrite, "GitHub operations token and repository allowlist"]] }),

    capability({ id: "marketplace.feed.generate", provider: "multi", domain: "marketplace", operation: "prepare", risk: "artifact_only", implemented: true, configured: shopify, approval: "none", description: "Generate a validated channel feed artifact from the canonical Shopify catalog for Google Merchant, Meta, TikTok, Amazon or generic marketplaces.", request_schema: schema({ channel: { type: "string" }, query: { type: "string" }, country: { type: "string" }, language: { type: "string" }, currency: { type: "string" }, max_products: { type: "integer" } }, ["channel"]), requirements: [[shopify, "Shopify catalog access"]] }),
    capability({ id: "matrixify.catalog.generate", provider: "matrixify", domain: "catalog", operation: "prepare", risk: "artifact_only", implemented: true, configured: shopify, approval: "none", description: "Generate a Matrixify-compatible product and variant CSV artifact from live Shopify data and requested transformations.", request_schema: schema({ query: { type: "string" }, operation: { type: "string" }, transformations: { type: "object" }, max_products: { type: "integer" } }), requirements: [[shopify, "Shopify catalog access"]] }),

    capability({ id: "tiktok.authorization.status", provider: "tiktok", domain: "advertising", operation: "read", risk: "read_only", implemented: true, configured: tiktokApp, approval: "none", description: "Check TikTok app, access-token and advertiser authorization state.", request_schema: schema(), requirements: [[tiktokApp, "TIKTOK_APP_ID and TIKTOK_APP_SECRET"]] }),
    capability({ id: "tiktok.campaign.read", provider: "tiktok", domain: "advertising", operation: "read", risk: "read_only", implemented: true, configured: tiktokAuthorized, approval: "none", description: "Read TikTok campaigns for the authorized advertiser.", request_schema: schema({ page: { type: "integer" }, page_size: { type: "integer" }, filtering: { type: "object" } }), requirements: [[tiktokAuthorized, "TIKTOK_ACCESS_TOKEN and TIKTOK_ADVERTISER_ID"]] }),
    capability({ id: "tiktok.campaign.create", provider: "tiktok", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: tiktokAuthorized, approval: "explicit", description: "Create a TikTok campaign disabled by default; enabling requires stronger approval.", request_schema: schema({}, []), requirements: [[tiktokAuthorized, "TikTok advertiser authorization"]] }),
    capability({ id: "tiktok.campaign.update", provider: "tiktok", domain: "advertising", operation: "execute", risk: "live_write", implemented: true, configured: tiktokAuthorized, approval: "explicit", description: "Update a TikTok campaign with explicit approval.", request_schema: schema({}, []), requirements: [[tiktokAuthorized, "TikTok advertiser authorization"]] }),

    capability({ id: "google_merchant.products.read", provider: "google_merchant", domain: "feed", operation: "read", risk: "read_only", implemented: false, configured: merchant, approval: "none", description: "Read processed products and product issues from Merchant Center.", request_schema: schema(), requirements: [[merchant, "Merchant API credentials"]] }),
    capability({ id: "google_merchant.products.sync", provider: "google_merchant", domain: "feed", operation: "execute", risk: "live_write", implemented: false, configured: merchant, approval: "explicit", description: "Synchronize Shopify products to an API data source in Merchant Center.", request_schema: schema(), requirements: [[merchant, "Merchant API credentials"]] }),
    capability({ id: "amazon.listings.sync", provider: "amazon", domain: "marketplace", operation: "execute", risk: "live_write", implemented: false, configured: amazon, approval: "explicit", description: "Create or update Amazon listings using Listings Items API or JSON_LISTINGS_FEED.", request_schema: schema(), requirements: [[amazon, "Amazon SP-API credentials"]] }),
    capability({ id: "spartoo.catalog.sync", provider: "spartoo", domain: "marketplace", operation: "execute", risk: "live_write", implemented: false, configured: configured(env.SPARTOO_API_KEY), approval: "explicit", description: "Synchronize products, prices and inventory with Spartoo after its API contract is mapped.", request_schema: schema(), requirements: [[configured(env.SPARTOO_API_KEY), "SPARTOO_API_KEY"]] }),
    capability({ id: "miinto.catalog.sync", provider: "miinto", domain: "marketplace", operation: "execute", risk: "live_write", implemented: false, configured: configured(env.MIINTO_API_TOKEN), approval: "explicit", description: "Synchronize products, prices and inventory with Miinto after its API contract is mapped.", request_schema: schema(), requirements: [[configured(env.MIINTO_API_TOKEN), "MIINTO_API_TOKEN"]] }),

    capability({ id: "ai.claude.review", provider: "anthropic", domain: "model_router", operation: "prepare", risk: "artifact_only", implemented: false, configured: configured(env.ANTHROPIC_API_KEY), approval: "none", description: "Use Claude as a specialist or independent reviewer inside a controlled job.", request_schema: schema(), requirements: [[configured(env.ANTHROPIC_API_KEY), "ANTHROPIC_API_KEY"]] }),
    capability({ id: "ai.gemini.review", provider: "google_gemini", domain: "model_router", operation: "prepare", risk: "artifact_only", implemented: false, configured: configured(env.GEMINI_API_KEY), approval: "none", description: "Use Gemini as a specialist or multimodal reviewer inside a controlled job.", request_schema: schema(), requirements: [[configured(env.GEMINI_API_KEY), "GEMINI_API_KEY"]] }),
  ];
}

export function findCapability(id: string, env: MareBusinessCapabilityEnv): MareBusinessCapability | null {
  return buildMareBusinessCapabilities(env).find((item) => item.id === id) || null;
}

