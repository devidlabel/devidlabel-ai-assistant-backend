/**
 * Conservative, deterministic PTD SHOES -> Shopify evidence gap report.
 * This is NOT a listing builder or schema validator. Never infers technical
 * footwear specifications, brand authorization or GPSR compliance.
 */
import { locateAmazonShoesDescriptionCandidates } from "./marketplace-amazon-shoes-description-evidence.js";

type Row = Record<string, unknown>;
type Status = "SOURCE_VERIFIED" | "TRANSFORM_REVIEW" | "MISSING" | "CONDITIONAL_UNRESOLVED";
type AttributeRow = {attribute: string; status: Status; source_path: string | null};
const FIELD_RE = /^[a-z][a-z0-9_]{0,119}$/;
const MAX_REQUIRED = 1000;

function stringValue(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}
function hasTag(product: Row, prefix: string): boolean {
  return Array.isArray(product.tags) && product.tags.some(tag =>
    typeof tag === "string" && tag.toLowerCase().startsWith(prefix + ":") &&
    tag.slice(prefix.length + 1).trim().length > 0);
}
function hasOption(variant: Row, names: string[]): boolean {
  return Array.isArray(variant.selected_options) && variant.selected_options.some(value => {
    const option = object(value);
    return typeof option.name === "string" &&
      names.includes(option.name.toLowerCase().trim()) && stringValue(option.value);
  });
}
function evidence(attribute: string, product: Row, variant: Row,
  descriptionCandidates: Readonly<Record<string,string>>): Omit<AttributeRow, "attribute"> {
  if (attribute === "brand" && stringValue(product.vendor))
    return {status:"SOURCE_VERIFIED", source_path:"product.vendor"};
  if (attribute === "item_name" && stringValue(product.title))
    return {status:"SOURCE_VERIFIED", source_path:"product.title"};
  if (attribute === "footwear_size" &&
      (hasOption(variant, ["taglia","numero","size","shoe size","eu size"]) ||
       (typeof variant.title === "string" && /\b\d{2}(?:[.,]5)?(?:\s*EU)?\b/i.test(variant.title))))
    return {status:"TRANSFORM_REVIEW", source_path:"variant.selected_options_or_title"};
  if (attribute === "color" &&
      (hasTag(product,"color") || hasOption(variant, ["colore","color"])))
    return {status:"TRANSFORM_REVIEW", source_path:"product.tags_or_variant.selected_options"};
  if (attribute === "target_gender" &&
      (hasTag(product,"gender") || hasOption(variant, ["gender","genere"])))
    return {status:"TRANSFORM_REVIEW", source_path:"product.tags_or_variant.selected_options"};
  if (attribute === "model_name" && hasTag(product,"model"))
    return {status:"TRANSFORM_REVIEW", source_path:"product.tags"};
  if (attribute === "style" && hasTag(product,"style"))
    return {status:"TRANSFORM_REVIEW", source_path:"product.tags"};
  if (attribute === "product_description" && stringValue(product.description_html))
    return {status:"TRANSFORM_REVIEW", source_path:"product.description_html"};
  // These are only unverified marketing-copy LOCATIONS for human review.
  if (Object.hasOwn(descriptionCandidates, attribute))
    return {status:"TRANSFORM_REVIEW", source_path: descriptionCandidates[attribute]};
  // No synthetic manufacturer, origin, leather, sole, construction, GPSR,
  // bullets, etc. Marketing descriptions alone do not prove technical specs.
  return {status:"MISSING", source_path:null};
}

export function buildAmazonShoesGapReport(
  product: Row, variant: Row, requiredNames: unknown,
  staticRequiredDeclared: boolean, conditionalRequirementsDetected: boolean,
): Row {
  const unavailable = (reason: string): Row => ({
    report_status:"BLOCKED_SCHEMA_UNVERIFIED", reason, product_type:"SHOES",
    attributes:[], required_attribute_count:0,
    required_status_counts:{SOURCE_VERIFIED:0,TRANSFORM_REVIEW:0,MISSING:0},
    conditional_requirements:[{attribute:"unmapped_schema_conditions",
      status:"CONDITIONAL_UNRESOLVED",source_path:null}],
    ready_for_validation_preview:false, ready_for_publication:false,
    brand_authorization_proven:false, gpsr_compliance_proven:false,
    full_schema_validated:false, schema_checksum_verified:false,
    provider_mutations:0, read_only:true,
  });
  if (staticRequiredDeclared !== true) return unavailable("static_required_not_declared");
  if (!Array.isArray(requiredNames) || requiredNames.length === 0 ||
      requiredNames.length > MAX_REQUIRED ||
      requiredNames.some(s => typeof s !== "string" || !FIELD_RE.test(s)) ||
      new Set(requiredNames).size !== requiredNames.length)
    return unavailable("required_attributes_invalid_or_empty");
  if (product.product_type !== "Sneakers" || product.status !== "ACTIVE" ||
      !stringValue(product.vendor) || !stringValue(product.title) ||
      typeof variant.sku !== "string" || !variant.sku)
    return unavailable("shopify_sneaker_evidence_unverified");

  const descriptionCandidates = locateAmazonShoesDescriptionCandidates(product.description_html);
  const attributes: AttributeRow[] = [...requiredNames].sort().map(attribute => ({
    attribute, ...evidence(attribute, product, variant, descriptionCandidates),
  }));
  const required_status_counts = {
    SOURCE_VERIFIED: attributes.filter(x => x.status === "SOURCE_VERIFIED").length,
    TRANSFORM_REVIEW: attributes.filter(x => x.status === "TRANSFORM_REVIEW").length,
    MISSING: attributes.filter(x => x.status === "MISSING").length,
  };
  return {
    report_status:"GAPS_REQUIRE_REVIEW", product_type:"SHOES",
    required_attribute_count:attributes.length,
    attributes, required_status_counts,
    description_review_candidate_count: attributes.filter(a => a.status === "TRANSFORM_REVIEW" &&
      a.source_path?.startsWith("product.description_html:")).length,
    description_evidence_not_manufacturer_verified: true,
    conditional_requirements:conditionalRequirementsDetected
      ? [{attribute:"unmapped_schema_conditions",
          status:"CONDITIONAL_UNRESOLVED",source_path:null}]
      : [],
    conditional_requirements_detected:conditionalRequirementsDetected,
    status_semantics:"Evidence presence only; SOURCE_VERIFIED is not Amazon value/schema approval",
    technical_values_inferred:false, values_sent_to_amazon:false,
    ready_for_validation_preview:false, ready_for_publication:false,
    brand_authorization_proven:false, gpsr_compliance_proven:false,
    full_schema_validated:false, schema_checksum_verified:false,
    provider_mutations:0, read_only:true,
  };
}
