# Amazon SHOES PTD mass mapping — 26 October 2026

Scope: active Shopify sneakers with positive stock; EAN and size remain variant-specific. This is a data provenance specification, not an authorization to publish.

## Mapping rules

- `brand`: merchant-confirmed Amazon listing brand, never an inferred rewrite of vendor.
- `model_name`: product `amazon_ptd_shoes.model_name`, else `custom.marketplace_model_name`; verify source identity.
- `color`: `amazon_ptd_shoes.color` else `agentic.color` / `features.color` reference; reject contradictions.
- `target_gender`: `amazon_ptd_shoes.target_gender` or a single exact `custom.navigation_gender` value; multi-valued source needs review.
- `footwear_size`: `Numero: XX EU` from selected Shopify variant; unknown sizes or systems require review.
- `style`: `Sneaker` from the explicit Shopify product type `Sneakers`; this is a merchandise category, not a technical certificate.
- `list_price`: Shopify variant `compareAtPrice` may be used as a merchant *comparison/list-price candidate* when populated, positive and not less than current Shopify price. It is NEVER the Amazon purchasable offer price.
- `purchasable_offer`: only the Channable-controlled pricing rules may calculate or publish this field.
- `manufacturer`: only an explicitly sourced operator name; brand name alone is insufficient.
- `country_of_origin`: only explicit Shopify `inventoryItem.countryCodeOfOrigin` or Amazon-specific merchant metadata, and reject conflicting sources.
- `age_range_description`: only explicitly merchant-classified adult or age group.
- `bullet_point`, `model_number`, `closure`: only unambiguous explicit product information.
- `sole_material`, `outer`, `inner`, `leather_type`, `shaft`, `height_map`, `strap_type`, `water_resistance_level`, `item_package_dimensions` and `item_package_weight`: require evidence specific to the model or family; never copy the unmeasured 4B12 D2045 pilot estimates.
- GPSR manufacturer, responsible person and safety information: evidence and authorization separately required; the Shopify marketing description does not prove compliance.

## Implementation gates

Run exact seller SKU and EAN matches independently for IT / DE / FR / ES. Do not infer absence from an API error or an unresolved match. Submit `VALIDATION_PREVIEW` for only truly missing seller listings. No live stock or price writes without Channable writer ownership. Live MARE actions require the immutable-plan approval and post-write Amazon seller-listing readback.

## Working dataset

Google Sheet AMAZON_RECOVERY_2026-09-25 tab `Shoes PTD Mapping 261026`. It has one row per positive-stock sneaker variant; the generic field-source columns describe extraction candidates and are not proof that each per-SKU value has been validated.

This design deliberately separates model-level source evidence from size-level stock, EAN and offer price and is intended as the contract for a subsequent coded bulk mapping implementation and tests.
