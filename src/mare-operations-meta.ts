import { handleMetaReportingRequest } from "./meta-reporting.js";

type JsonObject = Record<string, unknown>;

export type MetaOperationsEnv = {
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_REPORT_ACCESS_TOKEN?: string;
  META_WRITE_ACCESS_TOKEN?: string;
  META_PIXEL_ID?: string;
  [key: string]: unknown;
};

type MetaMutationAction =
  | "campaign_create"
  | "campaign_update"
  | "adset_create"
  | "adset_update"
  | "ad_create"
  | "ad_update";

const STANDARD_CONFIRMATION = "EXECUTE META CHANGE";
const ACTIVATE_CONFIRMATION = "ACTIVATE META ADS";
const MAX_PAYLOAD_BYTES = 48 * 1024;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function isId(value: string): boolean {
  return /^\d{5,40}$/.test(value);
}

function isIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function containsSensitiveContent(value: unknown): boolean {
  const text = JSON.stringify(value);
  if (text.length > MAX_PAYLOAD_BYTES) return true;
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/i,
    /\b(?:password|passwd|secret|access[_ -]?token|api[_ -]?key)\s*[:=]\s*\S+/i,
  ].some((pattern) => pattern.test(text));
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function configured(env: MetaOperationsEnv): boolean {
  return Boolean(
    normalize(env.META_ADS_ACCESS_TOKEN)
    && normalize(env.META_AD_ACCOUNT_ID)
    && normalize(env.META_WRITE_ACCESS_TOKEN),
  );
}

export function metaOperationsConfiguration(env: MetaOperationsEnv): JsonObject {
  return {
    configured: configured(env),
    required_secrets: ["META_ADS_ACCESS_TOKEN", "META_WRITE_ACCESS_TOKEN"],
    required_configuration: ["META_AD_ACCOUNT_ID"],
    required_upstream_permissions: ["ads_read", "ads_management"],
    supported_actions: [
      "campaign_create", "campaign_update", "adset_create", "adset_update", "ad_create", "ad_update",
    ],
    defaults: {
      creates_default_to_paused: true,
      active_requires_separate_confirmation: true,
      delete_exposed: false,
    },
  };
}

function route(action: MetaMutationAction, objectId: string): { method: string; path: string; resource?: string } {
  if (action === "campaign_create") return { method: "POST", path: "/internal/meta/campaigns", resource: "campaigns" };
  if (action === "adset_create") return { method: "POST", path: "/internal/meta/adsets", resource: "adsets" };
  if (action === "ad_create") return { method: "POST", path: "/internal/meta/ads", resource: "ads" };
  if (!isId(objectId)) throw new Error("invalid_meta_object_id");
  if (action === "campaign_update") return { method: "PATCH", path: `/internal/meta/campaigns/${objectId}` };
  if (action === "adset_update") return { method: "PATCH", path: `/internal/meta/adsets/${objectId}` };
  return { method: "PATCH", path: `/internal/meta/ads/${objectId}` };
}

async function listExistingByName(
  env: MetaOperationsEnv,
  resource: string,
  storedName: string,
): Promise<JsonObject | null> {
  const readToken = normalize(env.META_REPORT_ACCESS_TOKEN);
  if (!readToken) return null;
  const response = await handleMetaReportingRequest(new Request(`https://internal.mare/internal/meta/${resource}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${readToken}` },
  }), env);
  if (!response?.ok) return null;
  const body = await response.json() as JsonObject;
  const rows = Array.isArray(body.rows) ? body.rows : [];
  for (const row of rows) {
    const item = asObject(row);
    if (normalize(item.name) === storedName) return item;
  }
  return null;
}

function requiredConfirmation(payload: JsonObject): string {
  return normalize(payload.status) === "ACTIVE" ? ACTIVATE_CONFIRMATION : STANDARD_CONFIRMATION;
}

function validatePayload(action: MetaMutationAction, payload: JsonObject): void {
  if (containsSensitiveContent(payload)) throw new Error("sensitive_or_oversized_meta_payload");
  const status = normalize(payload.status);
  if (status && !["ACTIVE", "PAUSED"].includes(status)) throw new Error("unsupported_meta_status");
  if (action.endsWith("_create") && !normalize(payload.name)) throw new Error("meta_create_name_required");
  if (action === "campaign_create" && !normalize(payload.objective)) throw new Error("meta_campaign_objective_required");
}

export async function executeMetaMutation(args: JsonObject, env: MetaOperationsEnv): Promise<JsonObject> {
  if (!configured(env)) throw new Error("meta_operations_not_configured");
  const action = normalize(args.action) as MetaMutationAction;
  const allowed: MetaMutationAction[] = [
    "campaign_create", "campaign_update", "adset_create", "adset_update", "ad_create", "ad_update",
  ];
  if (!allowed.includes(action)) throw new Error("invalid_meta_action");

  const objectId = normalize(args.object_id);
  const payload = { ...asObject(args.payload) };
  const idempotencyKey = normalize(args.idempotency_key);
  if (!isIdempotencyKey(idempotencyKey)) throw new Error("invalid_idempotency_key");
  validatePayload(action, payload);

  const expectedConfirmation = requiredConfirmation(payload);
  if (normalize(args.approval_confirmation) !== expectedConfirmation) {
    throw new Error(expectedConfirmation === ACTIVATE_CONFIRMATION
      ? "meta_activation_confirmation_required"
      : "meta_execution_confirmation_required");
  }

  const routed = route(action, objectId);
  let storedName = normalize(payload.name);
  if (action.endsWith("_create")) {
    const suffix = await shortHash(idempotencyKey);
    storedName = `${storedName} · MARE-${suffix}`;
    payload.name = storedName;
    const existing = await listExistingByName(env, routed.resource || "", storedName);
    if (existing) {
      return {
        ok: true,
        operation: action,
        status: "already_exists",
        idempotent_replay: true,
        external_write_performed: false,
        entity: existing,
        safety: {
          active_requested: normalize(payload.status) === "ACTIVE",
          delete_exposed: false,
        },
      };
    }
  }

  if (normalize(payload.status) === "ACTIVE") payload.confirm_active = true;
  const response = await handleMetaReportingRequest(new Request(`https://internal.mare${routed.path}`, {
    method: routed.method,
    headers: {
      Authorization: `Bearer ${normalize(env.META_WRITE_ACCESS_TOKEN)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }), env);

  if (!response) throw new Error("meta_operation_handler_not_found");
  const body = await response.json() as JsonObject;
  if (!response.ok || body.ok === false) {
    return {
      ok: false,
      operation: action,
      status: "failed",
      external_write_performed: false,
      error: normalize(body.error) || `meta_operation_failed_${response.status}`,
      detail: body.detail || null,
    };
  }

  return {
    ...body,
    operation: action,
    status: "executed",
    idempotent_replay: false,
    external_write_performed: true,
    stored_name: storedName || null,
    safety: {
      active_requested: normalize(payload.status) === "ACTIVE",
      delete_exposed: false,
      explicit_confirmation_verified: true,
      requires_human_review: true,
    },
  };
}
