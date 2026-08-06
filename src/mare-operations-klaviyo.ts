type JsonObject = Record<string, unknown>;

export type KlaviyoOperationsEnv = {
  KLAVIYO_OPERATIONS_API_KEY?: string;
  KLAVIYO_DEFAULT_FROM_EMAIL?: string;
  KLAVIYO_DEFAULT_FROM_LABEL?: string;
  KLAVIYO_DEFAULT_REPLY_TO_EMAIL?: string;
  KLAVIYO_DRAFT_HOLD_DATETIME?: string;
};

const KLAVIYO_API_BASE = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const DEFAULT_HOLD_DATETIME = "2099-12-31T23:59:00+01:00";
const MAX_RETRIES = 2;
const APPROVAL_CONFIRMATION = "CREATE KLAVIYO DRAFT";

class KlaviyoOperationError extends Error {
  status?: number;
  apiCode?: string;

  constructor(message: string, status?: number, apiCode?: string) {
    super(message);
    this.name = "KlaviyoOperationError";
    this.status = status;
    this.apiCode = apiCode;
  }
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,100}$/.test(value);
}

function isSafeIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

function containsCredentialLikeContent(values: string[]): boolean {
  const joined = values.join("\n");
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\bKlaviyo-API-Key\s+\S+/i,
    /\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/i,
    /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/i,
    /\b(?:password|passwd|secret|access[_ -]?token|api[_ -]?key)\s*[:=]\s*\S+/i,
  ];
  return patterns.some((pattern) => pattern.test(joined));
}

function configuredApiKey(env: KlaviyoOperationsEnv): string {
  return normalize(env.KLAVIYO_OPERATIONS_API_KEY);
}

export function klaviyoCampaignDraftConfigured(env: KlaviyoOperationsEnv): boolean {
  const apiKey = configuredApiKey(env);
  const fromEmail = normalize(env.KLAVIYO_DEFAULT_FROM_EMAIL);
  const fromLabel = normalize(env.KLAVIYO_DEFAULT_FROM_LABEL);
  const replyTo = normalize(env.KLAVIYO_DEFAULT_REPLY_TO_EMAIL) || fromEmail;
  return Boolean(apiKey && isEmail(fromEmail) && fromLabel && isEmail(replyTo));
}

export function klaviyoCampaignDraftConfiguration(env: KlaviyoOperationsEnv): JsonObject {
  return {
    configured: klaviyoCampaignDraftConfigured(env),
    api_revision: KLAVIYO_REVISION,
    required_secret: "KLAVIYO_OPERATIONS_API_KEY",
    required_scopes: ["campaigns:read", "campaigns:write"],
    sender_defaults_configured: {
      from_email: isEmail(normalize(env.KLAVIYO_DEFAULT_FROM_EMAIL)),
      from_label: Boolean(normalize(env.KLAVIYO_DEFAULT_FROM_LABEL)),
      reply_to_email: isEmail(normalize(env.KLAVIYO_DEFAULT_REPLY_TO_EMAIL) || normalize(env.KLAVIYO_DEFAULT_FROM_EMAIL)),
    },
    hold_datetime_configured: Boolean(normalize(env.KLAVIYO_DRAFT_HOLD_DATETIME)),
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeApiError(payload: JsonObject): { code?: string; title?: string } {
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const first = errors.length ? asObject(errors[0]) : {};
  const code = normalize(first.code);
  const title = normalize(first.title);
  return {
    ...(code ? { code: code.slice(0, 100) } : {}),
    ...(title ? { title: title.slice(0, 160) } : {}),
  };
}

async function klaviyoFetch(
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  let lastStatus = 0;
  let lastCode = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(KLAVIYO_API_BASE + path, {
      ...init,
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: "Klaviyo-API-Key " + apiKey,
        revision: KLAVIYO_REVISION,
        ...(init.body ? { "Content-Type": "application/vnd.api+json" } : {}),
        ...(init.headers || {}),
      },
    });

    let body: JsonObject = {};
    try {
      body = await response.json() as JsonObject;
    } catch {
      body = {};
    }

    if (response.ok) return body;

    lastStatus = response.status;
    lastCode = safeApiError(body).code || "";
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) break;

    const retryAfterSeconds = Number(response.headers.get("Retry-After") || "0");
    const backoff = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 300 * (2 ** attempt);
    await sleep(Math.min(backoff, 4000));
  }

  throw new KlaviyoOperationError("klaviyo_api_request_failed", lastStatus || undefined, lastCode || undefined);
}

async function shortHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function filterLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function campaignMessageId(campaign: JsonObject): string {
  const relationships = asObject(campaign.relationships);
  const relationship = asObject(relationships["campaign-messages"]);
  const data = Array.isArray(relationship.data) ? relationship.data : [];
  const first = data.length ? asObject(data[0]) : {};
  return normalize(first.id);
}

function campaignStatus(campaign: JsonObject): string {
  return normalize(asObject(campaign.attributes).status);
}

function campaignName(campaign: JsonObject): string {
  return normalize(asObject(campaign.attributes).name);
}

async function findExistingCampaign(
  apiKey: string,
  storedName: string,
): Promise<{ campaignId: string; messageId: string; status: string } | null> {
  const params = new URLSearchParams();
  params.set("filter", `and(equals(messages.channel,'email'),contains(name,'${filterLiteral(storedName)}'))`);
  params.set("fields[campaign]", "id,name,status");
  params.set("include", "campaign-messages");
  params.set("page[size]", "10");

  const payload = await klaviyoFetch("/api/campaigns?" + params.toString(), apiKey);
  const data = Array.isArray(payload.data) ? payload.data : [];
  for (const item of data) {
    const campaign = asObject(item);
    if (campaignName(campaign) !== storedName) continue;
    const campaignId = normalize(campaign.id);
    if (!campaignId) continue;
    return {
      campaignId,
      messageId: campaignMessageId(campaign),
      status: campaignStatus(campaign),
    };
  }
  return null;
}

function createCampaignBody(
  storedName: string,
  audienceId: string,
  subject: string,
  previewText: string,
  fromEmail: string,
  fromLabel: string,
  replyToEmail: string,
  holdDatetime: string,
  useSmartSending: boolean,
): JsonObject {
  return {
    data: {
      type: "campaign",
      attributes: {
        name: storedName,
        audiences: {
          included: [audienceId],
          excluded: [],
        },
        send_strategy: {
          method: "static",
          datetime: holdDatetime,
          options: {
            is_local: false,
          },
        },
        send_options: {
          use_smart_sending: useSmartSending,
        },
        tracking_options: {
          add_tracking_params: true,
          custom_tracking_params: [],
          is_tracking_clicks: true,
          is_tracking_opens: true,
        },
        "campaign-messages": {
          data: [
            {
              type: "campaign-message",
              attributes: {
                definition: {
                  channel: "email",
                  label: storedName,
                  content: {
                    subject,
                    preview_text: previewText,
                    from_email: fromEmail,
                    from_label: fromLabel,
                    reply_to_email: replyToEmail,
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

async function assignTemplate(
  apiKey: string,
  messageId: string,
  templateId: string,
): Promise<void> {
  await klaviyoFetch("/api/campaign-message-assign-template", apiKey, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "campaign-message",
        id: messageId,
        relationships: {
          template: {
            data: {
              type: "template",
              id: templateId,
            },
          },
        },
      },
    }),
  });
}

function validateDraftArgs(args: JsonObject): {
  campaignName: string;
  audienceId: string;
  subject: string;
  previewText: string;
  templateId: string;
  idempotencyKey: string;
  useSmartSending: boolean;
} {
  if (normalize(args.approval_confirmation) !== APPROVAL_CONFIRMATION) {
    throw new Error("approval_confirmation_required");
  }

  const campaignNameValue = normalize(args.campaign_name);
  const audienceId = normalize(args.audience_id);
  const subject = normalize(args.subject);
  const previewText = normalize(args.preview_text);
  const templateId = normalize(args.template_id);
  const idempotencyKey = normalize(args.idempotency_key);

  if (campaignNameValue.length < 3 || campaignNameValue.length > 180) throw new Error("invalid_campaign_name");
  if (!isSafeIdentifier(audienceId)) throw new Error("invalid_audience_id");
  if (!subject || subject.length > 200) throw new Error("invalid_subject");
  if (previewText.length > 300) throw new Error("invalid_preview_text");
  if (templateId && !isSafeIdentifier(templateId)) throw new Error("invalid_template_id");
  if (!isSafeIdempotencyKey(idempotencyKey)) throw new Error("invalid_idempotency_key");
  if (containsCredentialLikeContent([campaignNameValue, subject, previewText, idempotencyKey])) {
    throw new Error("sensitive_content_not_allowed");
  }

  return {
    campaignName: campaignNameValue,
    audienceId,
    subject,
    previewText,
    templateId,
    idempotencyKey,
    useSmartSending: typeof args.use_smart_sending === "boolean" ? args.use_smart_sending : true,
  };
}

export async function createKlaviyoCampaignDraft(
  args: JsonObject,
  env: KlaviyoOperationsEnv,
): Promise<JsonObject> {
  const input = validateDraftArgs(args);
  if (!klaviyoCampaignDraftConfigured(env)) throw new Error("klaviyo_operations_not_configured");

  const apiKey = configuredApiKey(env);
  const fromEmail = normalize(env.KLAVIYO_DEFAULT_FROM_EMAIL);
  const fromLabel = normalize(env.KLAVIYO_DEFAULT_FROM_LABEL);
  const replyToEmail = normalize(env.KLAVIYO_DEFAULT_REPLY_TO_EMAIL) || fromEmail;
  const holdDatetime = normalize(env.KLAVIYO_DRAFT_HOLD_DATETIME) || DEFAULT_HOLD_DATETIME;
  const idempotencyHash = await shortHash(input.idempotencyKey);
  const storedName = `${input.campaignName} · MARE-${idempotencyHash}`;

  const existing = await findExistingCampaign(apiKey, storedName);
  if (existing) {
    return {
      ok: true,
      operation: "klaviyo_campaign_draft",
      status: "already_exists",
      idempotent_replay: true,
      external_write_performed: false,
      campaign_id: existing.campaignId,
      campaign_message_id: existing.messageId || null,
      campaign_status: existing.status || "unknown",
      campaign_name: storedName,
      template_assignment_skipped_on_replay: Boolean(input.templateId),
      send_or_schedule_performed: false,
      requires_human_review: true,
    };
  }

  const createPayload = await klaviyoFetch("/api/campaigns", apiKey, {
    method: "POST",
    body: JSON.stringify(createCampaignBody(
      storedName,
      input.audienceId,
      input.subject,
      input.previewText,
      fromEmail,
      fromLabel,
      replyToEmail,
      holdDatetime,
      input.useSmartSending,
    )),
  });

  const campaign = asObject(createPayload.data);
  const campaignId = normalize(campaign.id);
  const messageId = campaignMessageId(campaign);
  const status = campaignStatus(campaign);
  if (!campaignId) throw new Error("klaviyo_campaign_created_without_id");

  let templateAssigned = false;
  let templateAssignmentError: JsonObject | null = null;
  if (input.templateId) {
    if (!messageId) {
      templateAssignmentError = { code: "campaign_message_id_missing" };
    } else {
      try {
        await assignTemplate(apiKey, messageId, input.templateId);
        templateAssigned = true;
      } catch (error) {
        const candidate = error as KlaviyoOperationError;
        templateAssignmentError = {
          code: candidate.message || "template_assignment_failed",
          ...(typeof candidate.status === "number" ? { status: candidate.status } : {}),
          ...(candidate.apiCode ? { api_code: candidate.apiCode } : {}),
        };
      }
    }
  }

  return {
    ok: !templateAssignmentError,
    partial_success: Boolean(templateAssignmentError),
    operation: "klaviyo_campaign_draft",
    status: templateAssignmentError ? "draft_created_template_not_assigned" : "draft_created",
    idempotent_replay: false,
    external_write_performed: true,
    campaign_id: campaignId,
    campaign_message_id: messageId || null,
    campaign_status: status || "Draft",
    campaign_name: storedName,
    audience_id: input.audienceId,
    template_id: input.templateId || null,
    template_assigned: templateAssigned,
    ...(templateAssignmentError ? { template_assignment_error: templateAssignmentError } : {}),
    safety: {
      draft_only: true,
      hold_datetime: holdDatetime,
      send_or_schedule_performed: false,
      send_capability_exposed: false,
      irreversible_action_performed: false,
      requires_human_review: true,
    },
  };
}
