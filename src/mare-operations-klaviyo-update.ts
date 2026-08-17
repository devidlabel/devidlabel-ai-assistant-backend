import type { KlaviyoOperationsEnv } from "./mare-operations-klaviyo.js";

type JsonObject = Record<string, unknown>;

const KLAVIYO_API_BASE = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const APPROVAL_CONFIRMATION = "UPDATE KLAVIYO DRAFT";
const MAX_RETRIES = 2;
const MAX_HTML_BYTES = 180 * 1024;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,100}$/.test(value);
}

function configured(env: KlaviyoOperationsEnv): boolean {
  return Boolean(normalize(env.KLAVIYO_OPERATIONS_API_KEY));
}

export function klaviyoCampaignUpdateConfiguration(env: KlaviyoOperationsEnv): JsonObject {
  return {
    configured: configured(env),
    required_scopes: ["campaigns:read", "campaigns:write", "templates:write"],
    supported_changes: ["campaign name", "email subject", "preview text", "assigned template", "HTML email body via managed CODE template", "Smart Sending"],
    preserves_existing_sender_identity: true,
    post_write_campaign_readback: true,
    draft_only: true,
    send_or_schedule_exposed: false,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function klaviyoFetch(
  env: KlaviyoOperationsEnv,
  path: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  const apiKey = normalize(env.KLAVIYO_OPERATIONS_API_KEY);
  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${KLAVIYO_API_BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.api+json",
        Authorization: `Klaviyo-API-Key ${apiKey}`,
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
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      const error = new Error(`klaviyo_api_request_failed_${response.status}`) as Error & { detail?: unknown };
      error.detail = body;
      throw error;
    }
    const retryAfter = Number(response.headers.get("Retry-After") || "0");
    await sleep(Math.min(retryAfter > 0 ? retryAfter * 1000 : 300 * (2 ** attempt), 4000));
  }
  throw new Error(`klaviyo_api_request_failed_${lastStatus || "unknown"}`);
}

async function getCampaign(env: KlaviyoOperationsEnv, campaignId: string): Promise<JsonObject> {
  const payload = await klaviyoFetch(env, `/api/campaigns/${encodeURIComponent(campaignId)}?include=campaign-messages`);
  return asObject(payload.data);
}

function campaignStatus(campaign: JsonObject): string {
  return normalize(asObject(campaign.attributes).status).toLowerCase();
}

function relatedMessageId(campaign: JsonObject): string {
  const relationships = asObject(campaign.relationships);
  const messages = asObject(relationships["campaign-messages"]);
  const data = Array.isArray(messages.data) ? messages.data : [];
  return data.length ? normalize(asObject(data[0]).id) : "";
}

async function getMessageId(env: KlaviyoOperationsEnv, campaignId: string): Promise<string> {
  const payload = await klaviyoFetch(env, `/api/campaigns/${encodeURIComponent(campaignId)}/campaign-messages?page[size]=10`);
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.length ? normalize(asObject(data[0]).id) : "";
}

async function patchCampaignName(env: KlaviyoOperationsEnv, campaignId: string, name: string): Promise<void> {
  await klaviyoFetch(env, `/api/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "campaign", id: campaignId, attributes: { name } } }),
  });
}

async function patchCampaignSmartSending(env: KlaviyoOperationsEnv, campaignId: string, useSmartSending: boolean): Promise<void> {
  await klaviyoFetch(env, `/api/campaigns/${encodeURIComponent(campaignId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: {
        type: "campaign",
        id: campaignId,
        attributes: { send_options: { use_smart_sending: useSmartSending } },
      },
    }),
  });
}

async function patchCampaignMessage(env: KlaviyoOperationsEnv, messageId: string, subject: string, previewText: string): Promise<void> {
  const content: JsonObject = {};
  if (subject) content.subject = subject;
  if (previewText || previewText === "") content.preview_text = previewText;
  await klaviyoFetch(env, `/api/campaign-messages/${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      data: { type: "campaign-message", id: messageId, attributes: { definition: { channel: "email", content } } },
    }),
  });
}

async function assignTemplate(env: KlaviyoOperationsEnv, messageId: string, templateId: string): Promise<void> {
  await klaviyoFetch(env, "/api/campaign-message-assign-template", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "campaign-message",
        id: messageId,
        relationships: { template: { data: { type: "template", id: templateId } } },
      },
    }),
  });
}

async function createManagedHtmlTemplate(env: KlaviyoOperationsEnv, campaignId: string, html: string, text: string): Promise<string> {
  const name = `MARE K-Way Final Sale ${campaignId.slice(-8)} ${new Date().toISOString().slice(0, 16)}`;
  const payload = await klaviyoFetch(env, "/api/templates", {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "template",
        attributes: {
          name,
          editor_type: "CODE",
          html,
          ...(text ? { text } : {}),
        },
      },
    }),
  });
  const data = asObject(payload.data);
  const id = normalize(data.id);
  if (!id) throw new Error("klaviyo_template_create_missing_id");
  return id;
}

export async function updateKlaviyoCampaignDraft(args: JsonObject, env: KlaviyoOperationsEnv): Promise<JsonObject> {
  if (!configured(env)) throw new Error("klaviyo_operations_not_configured");
  if (normalize(args.approval_confirmation) !== APPROVAL_CONFIRMATION) throw new Error("klaviyo_update_confirmation_required");

  const campaignId = normalize(args.campaign_id);
  let messageId = normalize(args.campaign_message_id);
  const campaignName = normalize(args.campaign_name);
  const subject = normalize(args.subject);
  const previewText = typeof args.preview_text === "string" ? args.preview_text.trim() : "";
  const requestedTemplateId = normalize(args.template_id);
  const htmlBody = typeof args.html_body === "string" ? args.html_body.trim() : "";
  const textBody = typeof args.text_body === "string" ? args.text_body.trim() : "";
  const smartSendingRequested = typeof args.use_smart_sending === "boolean";
  const useSmartSending = args.use_smart_sending === true;

  if (!isSafeIdentifier(campaignId)) throw new Error("invalid_campaign_id");
  if (messageId && !isSafeIdentifier(messageId)) throw new Error("invalid_campaign_message_id");
  if (campaignName && (campaignName.length < 3 || campaignName.length > 180)) throw new Error("invalid_campaign_name");
  if (subject && subject.length > 200) throw new Error("invalid_subject");
  if (previewText.length > 300) throw new Error("invalid_preview_text");
  if (requestedTemplateId && !isSafeIdentifier(requestedTemplateId)) throw new Error("invalid_template_id");
  if (htmlBody && new TextEncoder().encode(htmlBody).byteLength > MAX_HTML_BYTES) throw new Error("klaviyo_html_body_too_large");
  if (textBody.length > 30000) throw new Error("klaviyo_text_body_too_large");
  if (!campaignName && !subject && args.preview_text === undefined && !requestedTemplateId && !htmlBody && !smartSendingRequested) throw new Error("no_klaviyo_changes_requested");

  const campaign = await getCampaign(env, campaignId);
  const status = campaignStatus(campaign);
  if (status && status !== "draft") throw new Error("klaviyo_campaign_is_not_draft");
  messageId = messageId || relatedMessageId(campaign) || await getMessageId(env, campaignId);
  if ((subject || args.preview_text !== undefined || requestedTemplateId || htmlBody) && !messageId) throw new Error("klaviyo_campaign_message_not_found");

  const changes: string[] = [];
  let assignedTemplateId = requestedTemplateId;
  if (campaignName) { await patchCampaignName(env, campaignId, campaignName); changes.push("campaign_name"); }
  if (smartSendingRequested) { await patchCampaignSmartSending(env, campaignId, useSmartSending); changes.push("smart_sending"); }
  if (subject || args.preview_text !== undefined) { await patchCampaignMessage(env, messageId, subject, previewText); changes.push("message_content"); }
  if (htmlBody) {
    assignedTemplateId = await createManagedHtmlTemplate(env, campaignId, htmlBody, textBody);
    await assignTemplate(env, messageId, assignedTemplateId);
    changes.push("managed_html_template_created", "template_assignment");
  } else if (requestedTemplateId) {
    await assignTemplate(env, messageId, requestedTemplateId);
    changes.push("template_assignment");
  }

  const readbackCampaign = await getCampaign(env, campaignId);
  const readbackAttributes = asObject(readbackCampaign.attributes);
  const readbackSendOptions = asObject(readbackAttributes.send_options);
  const readbackAudiences = asObject(readbackAttributes.audiences);

  return {
    ok: true,
    operation: "klaviyo_campaign_draft_update",
    status: "draft_updated",
    external_write_performed: true,
    campaign_id: campaignId,
    campaign_message_id: messageId || null,
    assigned_template_id: assignedTemplateId || null,
    changes,
    readback: {
      campaign_status: normalize(readbackAttributes.status) || null,
      campaign_name: normalize(readbackAttributes.name) || null,
      use_smart_sending: typeof readbackSendOptions.use_smart_sending === "boolean" ? readbackSendOptions.use_smart_sending : null,
      audience_included_ids: Array.isArray(readbackAudiences.included) ? readbackAudiences.included : [],
      audience_excluded_ids: Array.isArray(readbackAudiences.excluded) ? readbackAudiences.excluded : [],
      scheduled_at: readbackAttributes.scheduled_at ?? null,
    },
    safety: {
      draft_only_verified: true,
      post_write_campaign_readback_performed: true,
      existing_sender_identity_preserved: true,
      send_or_schedule_performed: false,
      send_capability_exposed: false,
      requires_human_review: true,
    },
  };
}
