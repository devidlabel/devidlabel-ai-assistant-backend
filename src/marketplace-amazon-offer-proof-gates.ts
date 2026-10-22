/**
 * Fail-closed contractual checks for the two OFFLINE MISSING evidence readers.
 *
 * These are NOT proof-generators. These checks only validate structured
 * output returned by independently authenticated backend evidence services.
 * Channable's documented public API does NOT expose export rule snapshots.
 * This gate therefore demands a separately reviewed Channable UI audit plus
 * independent Amazon seller readback. No connected audit source exists yet.
 * At present no provider-backed approval or Channable reader is connected.
 * No caller-supplied approval object may reach these functions via API.
 */
import type { AmazonOfferOnlyPrepared } from "./mare-business-amazon-offer-only-canary.js";

type Market = "IT" | "DE" | "FR" | "ES";
const REFERENCE = /^[A-Za-z0-9_.:-]{8,180}$/;
const HASH = /^[a-f0-9]{64}$/;
const SELLER = /^[A-Z0-9]{8,30}$/;
const EXPORT_ID = /^[A-Za-z0-9_-]{1,90}$/;
const MAX_APPROVAL_AGE = 15 * 60_000;
const MAX_EXPORT_AGE = 5 * 60_000;

export type TrustedOfferReview = Readonly<{
  source: "SERVER_VERIFIED_IMMUTABLE_REVIEW";
  verified: true;
  seller_id: string;
  marketplace: Market;
  sku: string;
  ean: string;
  asin: string;
  shopify_variant_id: string;
  schema_version: string;
  schema_checksum: string;
  plan_reference: string;
  reviewed_at: string;
  reviewer_reference: string;
  signed_review_digest_sha256: string;
  brand_name: string;
  seller_central_brand_approval_reference: string;
  seller_central_marketplace_verified: true;
  gpsr_document_digest_sha256: string;
  manufacturer_evidence_reference: string;
  pt_definitions_reference: string;
  amazon_validation_submission_reference: string;
  exact_identity_reviewed: true;
  brand_authorization_verified: true;
  gpsr_and_compliance_verified: true;
  schema_and_valid_preview_verified: true;
  price_policy_verified: true;
  approved_price_minor: number;
  order_and_tracking_pilot_ready: true;
  order_tracking_proof_reference: string;
  commercial_price_review_reference: string;
}>;
export type ChannableOfferExport = Readonly<{
  export_id: string;
  marketplace: Market;
  seller_sku_excluded: true;
  sku_exclusion_rule_reference: string;
  last_export_status: "SUCCESS";
  last_completed_at: string;
}>;
export type TrustedOfferWriterIsolation = Readonly<{
  source: "CHANNABLE_UI_AUDIT_WITH_AMAZON_READBACK";
  verified: true;
  seller_id: string;
  scope: "AMAZON_EU_OFFER_WRITERS";
  marketplace: Market;
  sku: string;
  company_id: 99008;
  project_id: 328207;
  audit_reviewer_reference: string;
  audited_export_snapshot_sha256: string;
  amazon_crosscheck_reference: string;
  no_existing_seller_offer_confirmed_at_review: true;
  listing_deletion_risk_reviewed: true;
  all_competing_writers_disabled: true;
  audited_export_inventory_complete: true;
  independently_checked_other_writers: true;
  other_live_writers_for_sku: 0;
  export_count: number;
  exports: readonly ChannableOfferExport[];
  evidence_reference: string;
  verified_at: string;
}>;
function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
function stamp(x: unknown, now: () => number, maxAge: number): boolean {
  if (typeof x !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)) return false;
  const t = Date.parse(x), n = now();
  return Number.isSafeInteger(n) && Number.isFinite(t) &&
    t <= n && n - t <= maxAge;
}
function ref(x: unknown): boolean {
  return typeof x === "string" && REFERENCE.test(x);
}
function hash(x: unknown): boolean {
  return typeof x === "string" && HASH.test(x);
}
export function verifyTrustedOfferReview(
  raw: unknown, p: AmazonOfferOnlyPrepared, seller: string, now: () => number,
): raw is TrustedOfferReview {
  if (!isObj(raw) || !SELLER.test(seller)) return false;
  const a = raw;
  return a.source === "SERVER_VERIFIED_IMMUTABLE_REVIEW" &&
    a.verified === true && a.seller_id === seller &&
    a.marketplace === p.marketplace && a.sku === p.sku &&
    a.ean === p.ean && a.asin === p.asin &&
    a.shopify_variant_id === p.shopify_variant_id &&
    a.schema_version === p.schema_version &&
    a.schema_checksum === p.schema_checksum &&
    ref(a.plan_reference) &&
    stamp(a.reviewed_at, now, MAX_APPROVAL_AGE) &&
    ref(a.reviewer_reference) && hash(a.signed_review_digest_sha256) &&
    typeof a.brand_name === "string" && /^[\p{L}\p{N}][\p{L}\p{N} &'._-]{1,89}$/u.test(a.brand_name) &&
    ref(a.seller_central_brand_approval_reference) &&
    a.seller_central_marketplace_verified === true &&
    hash(a.gpsr_document_digest_sha256) &&
    ref(a.manufacturer_evidence_reference) &&
    ref(a.pt_definitions_reference) &&
    ref(a.amazon_validation_submission_reference) &&
    a.exact_identity_reviewed === true &&
    a.brand_authorization_verified === true &&
    a.gpsr_and_compliance_verified === true &&
    a.schema_and_valid_preview_verified === true &&
    a.price_policy_verified === true &&
    a.order_and_tracking_pilot_ready === true &&
    ref(a.order_tracking_proof_reference) &&
    ref(a.commercial_price_review_reference) &&
    typeof a.approved_price_minor === "number" &&
    Number.isSafeInteger(a.approved_price_minor) &&
    a.approved_price_minor > 0 &&
    a.approved_price_minor <= 100_000_000 &&
    a.approved_price_minor === p.shopify_price_minor;
}
export function verifyTrustedChannableOfferIsolation(
  raw: unknown, p: AmazonOfferOnlyPrepared, seller: string, now: () => number,
): raw is TrustedOfferWriterIsolation {
  if (!isObj(raw) || !SELLER.test(seller)) return false;
  const a = raw;
  if (a.source !== "CHANNABLE_UI_AUDIT_WITH_AMAZON_READBACK" ||
      a.verified !== true || a.seller_id !== seller ||
      a.scope !== "AMAZON_EU_OFFER_WRITERS" ||
      a.marketplace !== p.marketplace || a.sku !== p.sku ||
      a.company_id !== 99008 || a.project_id !== 328207 ||
      !ref(a.audit_reviewer_reference) || !hash(a.audited_export_snapshot_sha256) ||
      !ref(a.amazon_crosscheck_reference) ||
      a.no_existing_seller_offer_confirmed_at_review !== true ||
      a.listing_deletion_risk_reviewed !== true ||
      a.all_competing_writers_disabled !== true ||
      a.audited_export_inventory_complete !== true ||
      a.independently_checked_other_writers !== true ||
      a.other_live_writers_for_sku !== 0 ||
      !ref(a.evidence_reference) ||
      !stamp(a.verified_at, now, MAX_EXPORT_AGE) ||
      !Array.isArray(a.exports) || a.exports.length < 1 ||
      a.exports.length > 30 || a.export_count !== a.exports.length) return false;
  const ids = new Set<string>();
  for (const rawExport of a.exports) {
    if (!isObj(rawExport)) return false;
    const e = rawExport;
    if (typeof e.export_id !== "string" ||
        !EXPORT_ID.test(e.export_id) || ids.has(e.export_id) ||
        e.marketplace !== p.marketplace ||
        e.seller_sku_excluded !== true ||
        !ref(e.sku_exclusion_rule_reference) ||
        e.last_export_status !== "SUCCESS" ||
        !stamp(e.last_completed_at, now, MAX_EXPORT_AGE)) return false;
    ids.add(e.export_id);
  }
  return true;
}
/**
 * Readiness diagnostic for use by an authenticated, provider-owned backend
 * adapter. No "ok" object is generated when either proof is missing.
 */
export function checkOfferOnlyProofReadiness(
  p: AmazonOfferOnlyPrepared, seller: string,
  approval: unknown, isolation: unknown, now: () => number = Date.now,
) {
  const blockers: string[] = [];
  if (!verifyTrustedOfferReview(approval, p, seller, now))
    blockers.push("INDEPENDENT_BRAND_GPSR_SCHEMA_PRICE_REVIEW_NOT_VERIFIED");
  if (!verifyTrustedChannableOfferIsolation(isolation, p, seller, now))
    blockers.push("CHANNABLE_ALL_EXPORTS_AND_OTHER_WRITERS_ISOLATION_NOT_VERIFIED");
  return {
    ready_for_canary_gates: blockers.length === 0,
    blockers,
    can_publish: false,
    provider_mutations: 0,
    channable_changed: false,
    // Proof readiness is NEVER equivalent to approval for live writes.
    requires_separate_live_approval: true,
  };
}
