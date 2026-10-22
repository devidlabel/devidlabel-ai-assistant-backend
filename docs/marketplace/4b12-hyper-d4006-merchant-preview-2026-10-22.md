# 4B12 Hyper D-4006: cautious merchant-description evidence for Amazon validation

On 22 October 2026 Amazon SHOES VALIDATION_PREVIEW returned 20 errors for Hyper D-4006 size 38 in IT/DE/FR/ES, compared with 17 common errors for five other 4B12 model samples. The three extra attributes were model_number, bullet_point and closure. The Shopify product description already includes explicit model D-4006, platform-sole feature, and two lace descriptions; no Shopify storefront edit is required.

This PR extends ONLY merchantDescription extraction in the private Shopify Admin reader, with strict boundaries:
- Shopify source identity remains matching ACTIVE exact SKU, title and brand.
- Only a 4B12 Hyper D-series SKU whose title and at least two description model mentions agree and has a unique technical list is considered.
- Use the verbatim merchant-source model string (D-4006), verbatim bullet point ("Suola platform effetto vintage") and two explicit lace descriptions for a candidate lace closure.
- Fail closed on ambiguous model, absent technical list, contradictory Velcro/zip, unsupported HTML or mismatched SKU.
- **Preview only:** no manufacturer/material/origin/GPSR/retail-price attributes are inferred. Merchant marketing description is not a supplier technical certificate, and the preview is never approval to publish.
- No product, theme, metafield, quantity, price or Amazon live listing mutation. Channable stays owner.

After merge and controlled deployment: rerun `amazon.shoes.new_asin.validation.preview` on `4B12_HYPER_D4006_38_EU` in IT/DE/FR/ES, verify actual change from baseline 20. Do not assume success until live readback.

Tests added to `scripts/test-amazon-shoes-private-shopify-values.mjs` for positive and contradictory cases; existing Amazon runtime tests continue.