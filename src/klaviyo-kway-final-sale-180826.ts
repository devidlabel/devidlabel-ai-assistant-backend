type JsonObject = Record<string, unknown>;

export type KwayFinalSaleEnv = {
  KLAVIYO_OPERATIONS_API_KEY?: string;
  KLAVIYO_PRIVATE_API_KEY?: string;
};

type Claims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  repository?: string;
  repository_owner?: string;
  ref?: string;
  event_name?: string;
  exp?: number;
  iat?: number;
  nbf?: number;
};

const PATH = "/internal/ops/kway-final-sale-2026-08-18";
const API = "https://a.klaviyo.com";
const REVISION = "2026-07-15";
const REPOSITORY = "devidlabel/devidlabel-ai-assistant-backend";
const EXECUTION_REF = "refs/heads/ops/execute-kway-final-sale-2026-08-18";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const OIDC_AUDIENCE = "devidlabel-kway-final-sale-2026-08-18";
const OIDC_SUBJECT = `repo:${REPOSITORY}:ref:${EXECUTION_REF}`;
const OIDC_PULL_REQUEST_REF = "refs/pull/118/merge";
const OIDC_PULL_REQUEST_SUBJECT = `repo:${REPOSITORY}:pull_request`;

const SOURCE_ENGAGED = "Re2ZyU";
const SOURCE_HISTORICAL = "WsPZgJ";
const SOURCE_SENDER_CAMPAIGN = "01KZRMTF5Z2N4EHWGW91P4ARXB";
const WRONG_DRAFT_ID = "01KZRN987J0R3M2HS0F190KEQ4";
const SEND_AT = "2026-08-18T16:30:00+00:00";
const SEND_AT_MS = Date.parse(SEND_AT);
const SUBJECT = "K-Way Final Sale: ultime taglie fino al -50%";
const PREVIEW = "Giubbotti e accessori K-Way in Final Sale. Le disponibilità migliori stanno terminando.";
const COHORT_A_NAME = "DL | K-WAY FINAL SALE | ENGAGED90 | EXCL BUYERS14 | 180826 | V4";
const COHORT_B_NAME = "DL | K-WAY FINAL SALE | HISTORICAL ALL TIME | DORMANT60 | OPEN0 90 | 180826 | V4";
const CAMPAIGN_A_NAME = "DL | 2026-08-18 18:30 | K-WAY FINAL SALE | ENGAGED90";
const CAMPAIGN_B_NAME = "DL | 2026-08-18 18:30 | K-WAY FINAL SALE | HISTORICAL K-WAY";
const MARKETPLACE_NAME = "BC - Amazon, Spartoo and Ebay profiles";

const LOGO = "https://d3k81ch9hvuctc.cloudfront.net/company/V6B2sR/images/1558f3d0-2cf5-4937-920f-7293a7950f98.png";
const COLLECTION = "https://devidlabel.com/collections/k-way";
const HOME = "https://devidlabel.com/";
const PRODUCTS = [
  {
    category: "ACCESSORI",
    name: "Zaino Laon Brown Bistre",
    price: "€ 60,00",
    compareAt: "€ 100,00",
    discount: "-40%",
    stock: 2,
    url: "https://devidlabel.com/products/k-way-zaino-laon-brown-bistre-kwayk2116rwv04",
    image: "https://devidlabel.com/cdn/shop/files/259_d9f31912-072a-483c-8fad-c94bc085a81e.jpg?v=1776608482&width=600",
  },
  {
    category: "DONNA",
    name: "Giacca Marguerite Stretch Dot Beige Lt",
    price: "€ 95,00",
    compareAt: "€ 190,00",
    discount: "-50%",
    stock: 3,
    url: "https://devidlabel.com/products/k-way-giacca-marguerite-stretch-dot-beige-lt-kwayk31382w634",
    image: "https://devidlabel.com/cdn/shop/files/RIDIMENSIONATE_3-9_c8c9f269-f9ae-4cdf-9075-6935e31336c0.jpg?v=1776756813&width=600",
  },
  {
    category: "UOMO",
    name: "Giacca Jake Cotton Double Blue Depth - Green Lichen",
    price: "€ 125,00",
    compareAt: "€ 250,00",
    discount: "-50%",
    stock: 3,
    url: "https://devidlabel.com/products/k-way-giacca-jake-cotton-double-blue-depth-green-lichen-kwayk51337wb0t",
    image: "https://devidlabel.com/cdn/shop/files/RIDIMENSIONATE_3-3_5eb94dfa-3dec-4391-aa92-a756fe95b9f9.jpg?v=1776960949&width=600",
  },
] as const;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function response(body: JsonObject, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function b64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decode<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(b64(value))) as T;
}

async function authorized(request: Request): Promise<boolean> {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3 || token.length < 100 || token.length > 12000) return false;
  try {
    const header = decode<{ alg?: string; kid?: string }>(parts[0]);
    const claims = decode<Claims>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return false;
    const now = Math.floor(Date.now() / 1000);
    const audience = Array.isArray(claims.aud) ? claims.aud.includes(OIDC_AUDIENCE) : claims.aud === OIDC_AUDIENCE;
    const allowedExecutionIdentity =
      (claims.event_name === "push" && claims.ref === EXECUTION_REF && claims.sub === OIDC_SUBJECT) ||
      (claims.event_name === "pull_request" && claims.ref === OIDC_PULL_REQUEST_REF && claims.sub === OIDC_PULL_REQUEST_SUBJECT);
    if (
      claims.iss !== OIDC_ISSUER || !audience || claims.repository !== REPOSITORY ||
      claims.repository_owner !== "devidlabel" || !allowedExecutionIdentity ||
      typeof claims.exp !== "number" || claims.exp < now - 30 || claims.exp > now + 900 ||
      typeof claims.iat !== "number" || claims.iat > now + 30 || claims.iat < now - 900 ||
      (typeof claims.nbf === "number" && claims.nbf > now + 30)
    ) return false;
    const configResponse = await fetch(`${OIDC_ISSUER}/.well-known/openid-configuration`);
    if (!configResponse.ok) return false;
    const config = await configResponse.json() as { issuer?: string; jwks_uri?: string };
    if (config.issuer !== OIDC_ISSUER || !config.jwks_uri) return false;
    const jwksUrl = new URL(config.jwks_uri);
    if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== "token.actions.githubusercontent.com") return false;
    const jwksResponse = await fetch(jwksUrl.toString(), { headers: { Accept: "application/json" } });
    if (!jwksResponse.ok) return false;
    const jwks = await jwksResponse.json() as { keys?: Array<JsonWebKey & { kid?: string; alg?: string; use?: string }> };
    const jwk = (jwks.keys || []).find((item) => item.kid === header.kid && (!item.alg || item.alg === "RS256") && (!item.use || item.use === "sig"));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, Uint8Array.from(b64(parts[2])).buffer, Uint8Array.from(signed).buffer);
  } catch {
    return false;
  }
}

async function kfetch(apiKey: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; body: JsonObject }> {
  const result = await fetch(API + path, {
    ...init,
    headers: {
      Accept: "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: REVISION,
      ...(init.body ? { "Content-Type": "application/vnd.api+json" } : {}),
      ...(init.headers || {}),
    },
  });
  let body: JsonObject = {};
  try { body = await result.json() as JsonObject; } catch { body = {}; }
  return { ok: result.ok, status: result.status, body };
}

async function must(apiKey: string, path: string, init: RequestInit = {}): Promise<JsonObject> {
  let result = await kfetch(apiKey, path, init);
  for (let attempt = 1; result.status === 429 && attempt <= 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1300 * attempt));
    result = await kfetch(apiKey, path, init);
  }
  if (result.ok) return result.body;
  const errors = Array.isArray(result.body.errors) ? result.body.errors : [];
  const first = errors.length ? asObject(errors[0]) : {};
  throw new Error(`${path} :: ${result.status} :: ${normalize(first.code) || normalize(first.title) || normalize(first.detail) || "Klaviyo error"}`);
}

function relationshipId(row: JsonObject, name: string): string {
  const data = asObject(asObject(row.relationships)[name]).data;
  if (Array.isArray(data) && data.length) return normalize(asObject(data[0]).id);
  return normalize(asObject(data).id);
}

function messageId(payload: JsonObject): string {
  const related = relationshipId(asObject(payload.data), "campaign-messages");
  if (related) return related;
  for (const item of Array.isArray(payload.included) ? payload.included : []) {
    const row = asObject(item);
    if (normalize(row.type) === "campaign-message" && normalize(row.id)) return normalize(row.id);
  }
  return "";
}

async function getSegment(apiKey: string, id: string): Promise<JsonObject> {
  const query = "?additional-fields[segment]=profile_count&fields[segment]=name,definition,is_active,is_processing,profile_count,created,updated";
  return asObject((await must(apiKey, `/api/segments/${encodeURIComponent(id)}${query}`)).data);
}

async function findSegmentByName(apiKey: string, name: string): Promise<JsonObject | null> {
  const params = new URLSearchParams();
  params.set("filter", `equals(name,'${name.replace(/'/g, "\\'")}')`);
  params.set("page[size]", "10");
  params.set("fields[segment]", "name,definition,is_active,is_processing,created,updated");
  const payload = await must(apiKey, "/api/segments?" + params.toString());
  for (const item of Array.isArray(payload.data) ? payload.data : []) {
    const row = asObject(item);
    if (normalize(asObject(row.attributes).name) === name) return row;
  }
  return null;
}

function segmentDefinition(segment: JsonObject): JsonObject {
  return asObject(asObject(segment.attributes).definition);
}

function groups(definition: JsonObject): JsonObject[] {
  return Array.isArray(definition.condition_groups) ? definition.condition_groups.map(asObject) : [];
}

function conditions(group: JsonObject): JsonObject[] {
  return Array.isArray(group.conditions) ? group.conditions.map(asObject) : [];
}

function timeframe(condition: JsonObject): JsonObject {
  return asObject(condition.timeframe_filter);
}

function measurement(condition: JsonObject): JsonObject {
  return asObject(condition.measurement_filter);
}

function approximateDays(filter: JsonObject): number {
  const quantity = Number(filter.quantity);
  const unit = normalize(filter.unit);
  if (unit === "day") return quantity;
  if (unit === "week") return quantity * 7;
  if (unit === "month") return quantity * 30;
  return Number.NaN;
}

function isZeroOrder30Group(group: JsonObject): boolean {
  const rows = conditions(group);
  return rows.length > 0 && rows.every((item) => {
    const when = timeframe(item);
    const amount = measurement(item);
    return normalize(item.type) === "profile-metric" && Number(amount.value) === 0 &&
      approximateDays(when) === 30;
  });
}

function isKwayPurchaseGroup(group: JsonObject): boolean {
  const rows = conditions(group);
  return rows.length >= 2 && rows.every((item) => normalize(item.type) === "profile-metric") && /k[\s-]?way/i.test(JSON.stringify(group));
}

function isOpened90Group(group: JsonObject): boolean {
  const rows = conditions(group);
  if (rows.length !== 1 || normalize(rows[0].type) !== "profile-metric") return false;
  const when = timeframe(rows[0]);
  const amount = measurement(rows[0]);
  const operator = normalize(amount.operator);
  const value = Number(amount.value);
  const hasOpened = (operator === "greater-than" && value === 0) || value >= 1;
  return approximateDays(when) === 90 && hasOpened;
}

function withCountAndWindow(condition: JsonObject, count: number, days: number | null): JsonObject {
  const copy = clone(condition);
  copy.measurement = "count";
  copy.measurement_filter = { type: "numeric", operator: count === 0 ? "equals" : "greater-than-or-equal", value: count };
  copy.timeframe_filter = days === null
    ? { type: "date", operator: "alltime" }
    : { type: "date", operator: "in-the-last", quantity: days, unit: "day" };
  return copy;
}

function buildCohortDefinitions(engaged: JsonObject, historical: JsonObject): { engaged: JsonObject; historical: JsonObject } {
  const engagedGroups = groups(segmentDefinition(engaged));
  const historicalGroups = groups(segmentDefinition(historical));
  const openedGroup = engagedGroups.find(isOpened90Group);
  const purchaseGroup = historicalGroups.find(isKwayPurchaseGroup);
  if (!openedGroup) throw new Error("engaged_source_opened90_condition_not_found");
  if (!purchaseGroup) throw new Error("historical_source_kway_purchase_condition_not_found");

  const zeroKwayGroups = conditions(purchaseGroup).map((condition) => ({ conditions: [withCountAndWindow(condition, 0, 14)] }));
  const engagedDefinition = {
    condition_groups: engagedGroups.filter((group) => !isZeroOrder30Group(group)).concat(zeroKwayGroups),
  };

  const historicalDefinitionGroups = historicalGroups.map((group) => {
    if (!isKwayPurchaseGroup(group)) return clone(group);
    return { conditions: conditions(group).map((condition) => withCountAndWindow(condition, 1, null)) };
  });
  const openedCondition = conditions(openedGroup)[0];
  historicalDefinitionGroups.push({ conditions: [withCountAndWindow(openedCondition, 0, 90)] });

  return {
    engaged: engagedDefinition,
    historical: { condition_groups: historicalDefinitionGroups },
  };
}

async function createOrReuseSegment(apiKey: string, name: string, definition: JsonObject): Promise<JsonObject> {
  const existing = await findSegmentByName(apiKey, name);
  if (existing) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const full = await getSegment(apiKey, normalize(existing.id));
    if (JSON.stringify(segmentDefinition(full)) !== JSON.stringify(definition)) throw new Error(`existing_segment_definition_mismatch:${name}`);
    return full;
  }
  const payload = await must(apiKey, "/api/segments", {
    method: "POST",
    body: JSON.stringify({ data: { type: "segment", attributes: { name, definition, is_starred: false } } }),
  });
  const id = normalize(asObject(payload.data).id);
  if (!id) throw new Error(`segment_created_without_id:${name}`);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  return getSegment(apiKey, id);
}

async function waitForSegment(apiKey: string, id: string): Promise<JsonObject> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  let latest = await getSegment(apiKey, id);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const attributes = asObject(latest.attributes);
    if (attributes.is_processing === false && Number.isFinite(Number(attributes.profile_count))) return latest;
    await new Promise((resolve) => setTimeout(resolve, 4000));
    latest = await getSegment(apiKey, id);
  }
  return latest;
}

async function sender(apiKey: string): Promise<{ from_email: string; from_label: string; reply_to_email: string }> {
  const campaign = await must(apiKey, `/api/campaigns/${SOURCE_SENDER_CAMPAIGN}?include=campaign-messages`);
  const id = messageId(campaign);
  if (!id) throw new Error("source_sender_message_missing");
  const message = await must(apiKey, `/api/campaign-messages/${id}`);
  const content = asObject(asObject(asObject(message.data).attributes).definition);
  const values = asObject(content.content);
  const fromEmail = normalize(values.from_email);
  const fromLabel = normalize(values.from_label);
  const replyTo = normalize(values.reply_to_email) || fromEmail;
  if (!fromEmail || !fromLabel || !replyTo) throw new Error("source_sender_identity_missing");
  return { from_email: fromEmail, from_label: fromLabel, reply_to_email: replyTo };
}

function trackedUrl(url: string, content: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}utm_source=klaviyo&utm_medium=email&utm_campaign=kway_final_sale_180826&utm_content=${content}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function emailHtml(utmContent: string): string {
  const productRows = PRODUCTS.map((product) => {
    const link = escapeAttribute(trackedUrl(product.url, utmContent));
    return `<tr><td class="product-pad" style="padding:0 36px 28px"><a href="${link}" style="text-decoration:none;color:#111"><img src="${escapeAttribute(product.image)}" width="528" alt="${escapeAttribute(product.name)}" style="display:block;width:100%;max-width:528px;height:auto;border:0"><div style="padding:18px 0 0;font:700 11px/16px Helvetica,Arial,sans-serif;letter-spacing:2px;color:#d71920">${product.category}</div><div style="padding:6px 0 5px;font:700 23px/29px 'Playfair Display',Georgia,serif;color:#111">${product.name}</div><div style="font:14px/22px Helvetica,Arial,sans-serif;color:#666"><span style="text-decoration:line-through">${product.compareAt}</span>&nbsp;&nbsp;<strong style="color:#111">${product.price}</strong>&nbsp;&nbsp;<strong style="color:#d71920">${product.discount}</strong></div><div style="padding-top:13px;font:700 12px/18px Helvetica,Arial,sans-serif;letter-spacing:1.4px;color:#111">SCOPRI ${product.category} →</div></a></td></tr>`;
  }).join("");
  const home = escapeAttribute(trackedUrl(HOME, utmContent));
  const collection = escapeAttribute(trackedUrl(COLLECTION, utmContent));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>body{margin:0!important;padding:0!important;background:#ececec}.preheader{display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all}@media(max-width:620px){.wrap{width:100%!important}.hero{padding:38px 24px 32px!important}.headline{font-size:48px!important;line-height:48px!important}.product-pad{padding-left:20px!important;padding-right:20px!important}.footer{padding-left:22px!important;padding-right:22px!important}}@media(prefers-color-scheme:dark){.force-white{background:#fff!important;color:#111!important}.force-black{background:#080808!important;color:#fff!important}}</style></head><body><div class="preheader">${PREVIEW}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ececec"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" class="wrap force-white" style="width:600px;max-width:600px;background:#fff"><tr><td align="center" class="force-black" style="background:#080808;padding:24px 38px"><a href="${home}"><img src="${LOGO}" width="220" alt="Devid Label" style="display:block;width:220px;max-width:70%;height:auto;border:0"></a></td></tr><tr><td class="hero" style="padding:50px 38px 38px;text-align:center"><div style="font:700 11px/16px Helvetica,Arial,sans-serif;letter-spacing:2.5px;color:#d71920">K-WAY FINAL SALE</div><div class="headline" style="padding:14px 0 5px;font:700 64px/62px 'Playfair Display',Georgia,serif;letter-spacing:-1px;color:#111">FINO AL -50%</div><div style="font:700 19px/28px Helvetica,Arial,sans-serif;color:#111">Ultime taglie. Ultimi pezzi.</div><p style="max-width:470px;margin:20px auto 25px;font:16px/25px Helvetica,Arial,sans-serif;color:#333">Una delle selezioni più richieste del momento entra nella fase finale dei saldi. Se hai adocchiato un K-Way, questo è il momento giusto.</p><a href="${collection}" style="display:inline-block;background:#080808;color:#fff;text-decoration:none;font:700 12px/18px Helvetica,Arial,sans-serif;letter-spacing:1.8px;padding:16px 25px">SCOPRI K-WAY</a></td></tr><tr><td style="padding:0 36px 30px"><div style="height:1px;background:#ddd"></div></td></tr>${productRows}<tr><td align="center" class="force-black" style="background:#080808;padding:36px 30px 40px"><div style="font:700 27px/34px 'Playfair Display',Georgia,serif;color:#fff">Le disponibilità migliori stanno terminando.</div><p style="margin:10px 0 23px;font:14px/22px Helvetica,Arial,sans-serif;color:#ddd">Il prezzo è sceso. Ora è la disponibilità a decidere.</p><a href="${collection}" style="display:inline-block;background:#fff;color:#111;text-decoration:none;font:700 12px/18px Helvetica,Arial,sans-serif;letter-spacing:1.6px;padding:15px 23px">VEDI IL FINAL SALE</a></td></tr><tr><td class="footer" align="center" style="padding:28px 34px 32px;font:11px/18px Helvetica,Arial,sans-serif;color:#777">Devid Label · M.A.R.E. Srl<br>Via Guglielmo Marconi 3 · 40122 Bologna (BO)<br>P.IVA 03986981201<br><a href="${collection}" style="color:#111">K-Way su Devid Label</a> · {% unsubscribe %}</td></tr></table></td></tr></table></body></html>`;
}

async function createTemplate(apiKey: string, name: string, html: string): Promise<string> {
  const payload = await must(apiKey, "/api/templates", {
    method: "POST",
    body: JSON.stringify({ data: { type: "template", attributes: { name, editor_type: "CODE", html } } }),
  });
  const id = normalize(asObject(payload.data).id);
  if (!id) throw new Error(`template_created_without_id:${name}`);
  return id;
}

async function assignTemplate(apiKey: string, campaignMessageId: string, templateId: string): Promise<void> {
  await must(apiKey, "/api/campaign-message-assign-template", {
    method: "POST",
    body: JSON.stringify({ data: { type: "campaign-message", id: campaignMessageId, relationships: { template: { data: { type: "template", id: templateId } } } } }),
  });
}

async function findCampaign(apiKey: string, name: string): Promise<JsonObject | null> {
  const params = new URLSearchParams();
  params.set("filter", `and(equals(messages.channel,'email'),contains(name,'${name.replace(/'/g, "\\'")}'))`);
  params.set("include", "campaign-messages");
  params.set("page[size]", "10");
  const payload = await must(apiKey, "/api/campaigns?" + params.toString());
  for (const item of Array.isArray(payload.data) ? payload.data : []) {
    const row = asObject(item);
    if (normalize(asObject(row.attributes).name) === name) return row;
  }
  return null;
}

async function createCampaign(apiKey: string, name: string, audienceId: string, excludedId: string, senderIdentity: { from_email: string; from_label: string; reply_to_email: string }): Promise<{ id: string; messageId: string; reused: boolean }> {
  const existing = await findCampaign(apiKey, name);
  if (existing) {
    const status = normalize(asObject(existing.attributes).status);
    if (status !== "Draft") throw new Error(`campaign_exists_not_draft:${name}:${status}`);
    const id = normalize(existing.id);
    const full = await must(apiKey, `/api/campaigns/${id}?include=campaign-messages`);
    const existingMessageId = messageId(full);
    if (!existingMessageId) throw new Error(`existing_campaign_message_missing:${name}`);
    return { id, messageId: existingMessageId, reused: true };
  }
  const payload = await must(apiKey, "/api/campaigns", {
    method: "POST",
    body: JSON.stringify({ data: { type: "campaign", attributes: {
      name,
      audiences: { included: [audienceId], excluded: [excludedId] },
      send_strategy: { method: "static", datetime: SEND_AT, options: { is_local: false } },
      send_options: { use_smart_sending: false },
      tracking_options: { add_tracking_params: true, custom_tracking_params: [], is_tracking_clicks: true, is_tracking_opens: true },
      "campaign-messages": { data: [{ type: "campaign-message", attributes: { definition: { channel: "email", label: name, content: {
        subject: SUBJECT,
        preview_text: PREVIEW,
        from_email: senderIdentity.from_email,
        from_label: senderIdentity.from_label,
        reply_to_email: senderIdentity.reply_to_email,
      } } } }] },
    } } }),
  });
  const id = normalize(asObject(payload.data).id);
  const createdMessageId = messageId(payload);
  if (!id || !createdMessageId) throw new Error(`campaign_or_message_id_missing:${name}`);
  return { id, messageId: createdMessageId, reused: false };
}

async function patchCampaignMessage(apiKey: string, campaign: { id: string; messageId: string }, audienceId: string, excludedId: string, senderIdentity: { from_email: string; from_label: string; reply_to_email: string }): Promise<void> {
  await must(apiKey, `/api/campaigns/${campaign.id}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "campaign", id: campaign.id, attributes: {
      audiences: { included: [audienceId], excluded: [excludedId] },
      send_options: { use_smart_sending: false },
      tracking_options: { add_tracking_params: true, custom_tracking_params: [], is_tracking_clicks: true, is_tracking_opens: true },
    } } }),
  });
  await must(apiKey, `/api/campaign-messages/${campaign.messageId}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { type: "campaign-message", id: campaign.messageId, attributes: { definition: { channel: "email", content: {
      subject: SUBJECT,
      preview_text: PREVIEW,
      from_email: senderIdentity.from_email,
      from_label: senderIdentity.from_label,
      reply_to_email: senderIdentity.reply_to_email,
    } } } } }),
  });
}

async function estimateRecipients(apiKey: string, campaignId: string): Promise<number> {
  await must(apiKey, "/api/campaign-recipient-estimation-jobs", {
    method: "POST",
    body: JSON.stringify({ data: { type: "campaign-recipient-estimation-job", id: campaignId } }),
  });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const job = await must(apiKey, `/api/campaign-recipient-estimation-jobs/${campaignId}`);
    const status = normalize(asObject(asObject(job.data).attributes).status);
    if (status === "complete") break;
    if (status === "cancelled") return 0;
  }
  const estimate = await must(apiKey, `/api/campaign-recipient-estimations/${campaignId}`);
  return Number(asObject(asObject(estimate.data).attributes).estimated_recipient_count || 0);
}

async function campaignReadback(apiKey: string, campaignId: string): Promise<JsonObject> {
  const campaign = await must(apiKey, `/api/campaigns/${campaignId}?include=campaign-messages`);
  const row = asObject(campaign.data);
  const attributes = asObject(row.attributes);
  const id = messageId(campaign);
  const message = id ? await must(apiKey, `/api/campaign-messages/${id}`) : {};
  const messageAttributes = asObject(asObject(message.data).attributes);
  const content = asObject(asObject(messageAttributes.definition).content);
  return {
    campaign_id: normalize(row.id),
    campaign_message_id: id || null,
    name: normalize(attributes.name),
    status: normalize(attributes.status),
    audiences: attributes.audiences ?? null,
    send_strategy: attributes.send_strategy ?? null,
    send_options: attributes.send_options ?? null,
    tracking_options: attributes.tracking_options ?? null,
    scheduled_at: attributes.scheduled_at ?? null,
    subject: normalize(content.subject) || null,
    preview_text: normalize(content.preview_text) || null,
    from_email: normalize(content.from_email) || null,
    from_label: normalize(content.from_label) || null,
    reply_to_email: normalize(content.reply_to_email) || null,
  };
}

async function schedule(apiKey: string, campaignId: string): Promise<void> {
  await must(apiKey, "/api/campaign-send-jobs", {
    method: "POST",
    body: JSON.stringify({ data: { type: "campaign-send-job", id: campaignId } }),
  });
}

async function conflicts(apiKey: string): Promise<JsonObject[]> {
  const filter = encodeURIComponent("equals(messages.channel,'email')");
  const payload = await must(apiKey, `/api/campaigns?filter=${filter}&page[size]=100&sort=-created_at`);
  const output: JsonObject[] = [];
  for (const item of Array.isArray(payload.data) ? payload.data : []) {
    const row = asObject(item);
    const attributes = asObject(row.attributes);
    const name = normalize(attributes.name);
    const strategy = asObject(attributes.send_strategy);
    const when = Date.parse(normalize(strategy.datetime));
    const status = normalize(attributes.status);
    if ([CAMPAIGN_A_NAME, CAMPAIGN_B_NAME].includes(name)) continue;
    if (status === "Scheduled" && Number.isFinite(when) && Math.abs(when - SEND_AT_MS) <= 2 * 60 * 60 * 1000) {
      output.push({ id: normalize(row.id), name, status, send_strategy: attributes.send_strategy ?? null });
    }
  }
  return output;
}

async function validateProducts(): Promise<JsonObject[]> {
  const output: JsonObject[] = [];
  for (const product of PRODUCTS) {
    const page = await fetch(product.url, { redirect: "follow", headers: { "User-Agent": "MARE-Klaviyo-QA/1.0" } });
    const image = await fetch(product.image, { method: "GET", redirect: "follow" });
    output.push({ name: product.name, stock: product.stock, discount: product.discount, page_status: page.status, image_status: image.status, ok: page.ok && image.ok && product.stock > 0 });
  }
  return output;
}

async function preflight(env: KwayFinalSaleEnv): Promise<JsonObject> {
  const apiKey = normalize(env.KLAVIYO_OPERATIONS_API_KEY) || normalize(env.KLAVIYO_PRIVATE_API_KEY);
  if (!apiKey) return { ok: false, operation: "kway_final_sale_preflight", error: "klaviyo_key_missing" };
  const marketplace = await findSegmentByName(apiKey, MARKETPLACE_NAME);
  const engagedSource = await getSegment(apiKey, SOURCE_ENGAGED);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const historicalSource = await getSegment(apiKey, SOURCE_HISTORICAL);
  let definitions: { engaged: JsonObject; historical: JsonObject };
  try {
    definitions = buildCohortDefinitions(engagedSource, historicalSource);
  } catch (error) {
    return {
      ok: false,
      operation: "kway_final_sale_preflight",
      mutation_performed: false,
      error: error instanceof Error ? error.message : "segment_definition_error",
      source_definitions: {
        engaged: segmentDefinition(engagedSource),
        historical: segmentDefinition(historicalSource),
      },
    };
  }
  const productQa = await validateProducts();
  const overlap = await conflicts(apiKey);
  const wrongDraft = await campaignReadback(apiKey, WRONG_DRAFT_ID);
  return {
    ok: Boolean(marketplace) && productQa.every((item) => item.ok === true) && overlap.length === 0,
    operation: "kway_final_sale_preflight",
    mutation_performed: false,
    generated_at: new Date().toISOString(),
    target: { datetime: SEND_AT, timezone: "Europe/Rome", local: "2026-08-18 18:30" },
    source_segments: {
      engaged: { id: SOURCE_ENGAGED, name: normalize(asObject(engagedSource.attributes).name), profile_count: asObject(engagedSource.attributes).profile_count ?? null },
      historical: { id: SOURCE_HISTORICAL, name: normalize(asObject(historicalSource.attributes).name), profile_count: asObject(historicalSource.attributes).profile_count ?? null },
    },
    generated_definitions: { engaged_condition_groups: groups(definitions.engaged).length, historical_condition_groups: groups(definitions.historical).length },
    marketplace_exclusion: marketplace ? { id: normalize(marketplace.id), name: MARKETPLACE_NAME } : null,
    conflicts: overlap,
    products: productQa,
    wrong_draft: wrongDraft,
  };
}

async function execute(env: KwayFinalSaleEnv): Promise<JsonObject> {
  const apiKey = normalize(env.KLAVIYO_OPERATIONS_API_KEY);
  if (!apiKey) return { ok: false, operation: "kway_final_sale_execute", error: "klaviyo_operations_key_missing" };
  const overlap = await conflicts(apiKey);
  if (overlap.length) return { ok: false, operation: "kway_final_sale_execute", error: "scheduled_campaign_conflict", conflicts: overlap };
  const productQa = await validateProducts();
  if (!productQa.every((item) => item.ok === true)) return { ok: false, operation: "kway_final_sale_execute", error: "product_qa_failed", products: productQa };

  const marketplace = await findSegmentByName(apiKey, MARKETPLACE_NAME);
  if (!marketplace) return { ok: false, operation: "kway_final_sale_execute", error: "marketplace_exclusion_not_found" };
  const engagedSource = await getSegment(apiKey, SOURCE_ENGAGED);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const historicalSource = await getSegment(apiKey, SOURCE_HISTORICAL);
  const definitions = buildCohortDefinitions(engagedSource, historicalSource);

  let cohortA = await createOrReuseSegment(apiKey, COHORT_A_NAME, definitions.engaged);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  let cohortB = await createOrReuseSegment(apiKey, COHORT_B_NAME, definitions.historical);
  cohortA = await waitForSegment(apiKey, normalize(cohortA.id));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  cohortB = await waitForSegment(apiKey, normalize(cohortB.id));
  const cohortACount = Number(asObject(cohortA.attributes).profile_count || 0);
  const cohortBCount = Number(asObject(cohortB.attributes).profile_count || 0);
  if (cohortACount <= 0 || cohortBCount <= 0) {
    return { ok: false, operation: "kway_final_sale_execute", error: "cohort_count_zero", cohorts: { engaged90: { id: normalize(cohortA.id), count: cohortACount }, historical_kway: { id: normalize(cohortB.id), count: cohortBCount } } };
  }

  const senderIdentity = await sender(apiKey);
  const excludedId = normalize(marketplace.id);
  const campaignA = await createCampaign(apiKey, CAMPAIGN_A_NAME, normalize(cohortA.id), excludedId, senderIdentity);
  const campaignB = await createCampaign(apiKey, CAMPAIGN_B_NAME, normalize(cohortB.id), excludedId, senderIdentity);
  // The create payload already contains the complete campaign configuration. Klaviyo rejects
  // PATCHes that repeat a static send_strategy after its timestamp has passed, even while the
  // campaign remains a Draft. Only refresh the message envelope here so interrupted executions
  // can safely resume and finish the creative without altering the intended audience or timing.
  await patchCampaignMessage(apiKey, campaignA, normalize(cohortA.id), excludedId, senderIdentity);
  await patchCampaignMessage(apiKey, campaignB, normalize(cohortB.id), excludedId, senderIdentity);

  const templateA = await createTemplate(apiKey, "DL | K-WAY FINAL SALE | ENGAGED90 | 180826", emailHtml("engaged90"));
  const templateB = await createTemplate(apiKey, "DL | K-WAY FINAL SALE | HISTORICAL K-WAY | 180826", emailHtml("historical_kway"));
  await assignTemplate(apiKey, campaignA.messageId, templateA);
  await assignTemplate(apiKey, campaignB.messageId, templateB);

  const recipientsA = await estimateRecipients(apiKey, campaignA.id);
  const recipientsB = await estimateRecipients(apiKey, campaignB.id);
  const drafts = {
    engaged90: await campaignReadback(apiKey, campaignA.id),
    historical_kway: await campaignReadback(apiKey, campaignB.id),
  };
  if (recipientsA <= 0 || recipientsB <= 0) {
    return { ok: false, operation: "kway_final_sale_execute", error: "recipient_estimation_zero", cohorts: { engaged90: { id: normalize(cohortA.id), count: cohortACount }, historical_kway: { id: normalize(cohortB.id), count: cohortBCount } }, estimates: { engaged90: recipientsA, historical_kway: recipientsB }, drafts };
  }
  if (Date.now() > SEND_AT_MS - 5 * 60 * 1000) {
    return {
      ok: false,
      operation: "kway_final_sale_execute",
      error: "schedule_window_too_close",
      generated_at: new Date().toISOString(),
      target: { datetime: SEND_AT, timezone: "Europe/Rome", local: "2026-08-18 18:30" },
      cohorts: { engaged90: { id: normalize(cohortA.id), count: cohortACount }, historical_kway: { id: normalize(cohortB.id), count: cohortBCount } },
      estimates: { engaged90: recipientsA, historical_kway: recipientsB, deduplicated_total: recipientsA + recipientsB },
      marketplace_exclusion: { id: excludedId, name: MARKETPLACE_NAME },
      smart_sending: false,
      templates: { engaged90: templateA, historical_kway: templateB },
      products: PRODUCTS.map((product) => ({ category: product.category, name: product.name, url: product.url, stock: product.stock, discount: product.discount })),
      drafts,
    };
  }

  await schedule(apiKey, campaignA.id);
  await schedule(apiKey, campaignB.id);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const readback = {
    engaged90: await campaignReadback(apiKey, campaignA.id),
    historical_kway: await campaignReadback(apiKey, campaignB.id),
  };
  const statuses = [normalize(readback.engaged90.status), normalize(readback.historical_kway.status)];
  const ok = statuses.every((status) => ["Scheduled", "Preparing to schedule"].includes(status));
  return {
    ok,
    operation: "kway_final_sale_execute",
    generated_at: new Date().toISOString(),
    target: { datetime: SEND_AT, timezone: "Europe/Rome", local: "2026-08-18 18:30" },
    cohorts: { engaged90: { id: normalize(cohortA.id), count: cohortACount }, historical_kway: { id: normalize(cohortB.id), count: cohortBCount } },
    estimates: { engaged90: recipientsA, historical_kway: recipientsB, deduplicated_total: recipientsA + recipientsB },
    marketplace_exclusion: { id: excludedId, name: MARKETPLACE_NAME },
    smart_sending: false,
    templates: { engaged90: templateA, historical_kway: templateB },
    products: PRODUCTS.map((product) => ({ category: product.category, name: product.name, url: product.url, stock: product.stock, discount: product.discount })),
    readback,
  };
}

async function status(env: KwayFinalSaleEnv): Promise<JsonObject> {
  const apiKey = normalize(env.KLAVIYO_OPERATIONS_API_KEY) || normalize(env.KLAVIYO_PRIVATE_API_KEY);
  if (!apiKey) return { ok: false, operation: "kway_final_sale_status", error: "klaviyo_key_missing" };
  const campaignA = await findCampaign(apiKey, CAMPAIGN_A_NAME);
  const campaignB = await findCampaign(apiKey, CAMPAIGN_B_NAME);
  return {
    ok: true,
    operation: "kway_final_sale_status",
    generated_at: new Date().toISOString(),
    campaigns: {
      engaged90: campaignA ? await campaignReadback(apiKey, normalize(campaignA.id)) : null,
      historical_kway: campaignB ? await campaignReadback(apiKey, normalize(campaignB.id)) : null,
    },
  };
}

export async function handleKwayFinalSale180826(request: Request, env: KwayFinalSaleEnv): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null;
  if (!(await authorized(request))) return response({ ok: false, operation: "kway_final_sale", reason: "not_found" }, 404);
  try {
    if (request.method === "GET") {
      const mode = new URL(request.url).searchParams.get("mode");
      return response(mode === "status" ? await status(env) : await preflight(env));
    }
    if (request.method === "POST") return response(await execute(env));
    return response({ ok: false, operation: "kway_final_sale", reason: "method_not_allowed" }, 405);
  } catch (error) {
    return response({ ok: false, operation: "kway_final_sale", error: error instanceof Error ? error.message : "operation_failed" }, 500);
  }
}
