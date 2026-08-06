import { googleServiceAccountAccessToken, parseGoogleServiceAccount } from "./google-service-account.js";

type JsonObject = Record<string, unknown>;

export type GoogleAdsOperationsEnv = {
  GOOGLE_ADS_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  GOOGLE_ADS_API_VERSION?: string;
  [key: string]: unknown;
};

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ADS_BASE = "https://googleads.googleapis.com";
const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const DEFAULT_API_VERSION = "v25";
const STANDARD_CONFIRMATION = "EXECUTE GOOGLE ADS CHANGE";
const ENABLE_CONFIRMATION = "ENABLE GOOGLE ADS CAMPAIGN";
const BUDGET_CONFIRMATION = "CHANGE GOOGLE ADS BUDGET";

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function digits(value: unknown): string {
  return normalize(value).replace(/\D/g, "");
}

function apiVersion(env: GoogleAdsOperationsEnv): string {
  const value = normalize(env.GOOGLE_ADS_API_VERSION);
  return /^v\d+$/.test(value) ? value : DEFAULT_API_VERSION;
}

function authMode(env: GoogleAdsOperationsEnv): "service_account" | "user_oauth" | "unconfigured" {
  if (parseGoogleServiceAccount(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON)) return "service_account";
  if (normalize(env.GOOGLE_ADS_CLIENT_ID) && normalize(env.GOOGLE_ADS_CLIENT_SECRET) && normalize(env.GOOGLE_ADS_REFRESH_TOKEN)) {
    return "user_oauth";
  }
  return "unconfigured";
}

function configured(env: GoogleAdsOperationsEnv): boolean {
  return authMode(env) !== "unconfigured"
    && Boolean(normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN))
    && /^\d{5,20}$/.test(digits(env.GOOGLE_ADS_CUSTOMER_ID));
}

export function googleAdsOperationsConfiguration(env: GoogleAdsOperationsEnv): JsonObject {
  return {
    configured: configured(env),
    credential_mode: authMode(env),
    api_version: apiVersion(env),
    oauth_scope: GOOGLE_ADS_SCOPE,
    required_account_role: "STANDARD or higher",
    supported_actions: ["update campaign name", "pause campaign", "enable campaign", "update campaign daily budget"],
    blocked_actions: ["remove campaign", "arbitrary bulk mutate", "enable without separate confirmation"],
  };
}

async function accessToken(env: GoogleAdsOperationsEnv): Promise<string> {
  if (authMode(env) === "service_account") {
    return googleServiceAccountAccessToken(env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON, GOOGLE_ADS_SCOPE);
  }
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: normalize(env.GOOGLE_ADS_CLIENT_ID),
      client_secret: normalize(env.GOOGLE_ADS_CLIENT_SECRET),
      refresh_token: normalize(env.GOOGLE_ADS_REFRESH_TOKEN),
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json() as JsonObject;
  if (!response.ok || typeof body.access_token !== "string") throw new Error(`google_ads_oauth_failed_${response.status}`);
  return body.access_token;
}

async function googleAdsRequest(
  env: GoogleAdsOperationsEnv,
  path: string,
  body: JsonObject,
): Promise<JsonObject | JsonObject[]> {
  const oauthToken = await accessToken(env);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${oauthToken}`,
    "developer-token": normalize(env.GOOGLE_ADS_DEVELOPER_TOKEN),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const loginCustomerId = digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
  const response = await fetch(`${GOOGLE_ADS_BASE}/${apiVersion(env)}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let payload: JsonObject | JsonObject[] = {};
  try {
    payload = await response.json() as JsonObject | JsonObject[];
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const error = new Error(`google_ads_api_failed_${response.status}`) as Error & { detail?: unknown };
    error.detail = payload;
    throw error;
  }
  return payload;
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function campaignSnapshot(
  env: GoogleAdsOperationsEnv,
  customerId: string,
  campaignId: string,
): Promise<{ resourceName: string; status: string; name: string; budgetResourceName: string; budgetMicros: number }> {
  const query = `
    SELECT
      campaign.resource_name,
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.campaign_budget,
      campaign_budget.amount_micros
    FROM campaign
    WHERE campaign.id = ${campaignId}
    LIMIT 1
  `.trim();
  const raw = await googleAdsRequest(env, `/customers/${customerId}/googleAds:searchStream`, { query });
  const batches = Array.isArray(raw) ? raw : [];
  const firstBatch = batches.length ? batches[0] as JsonObject : {};
  const results = Array.isArray(firstBatch.results) ? firstBatch.results : [];
  if (!results.length) throw new Error("google_ads_campaign_not_found");
  const row = results[0] as JsonObject;
  const campaign = row.campaign && typeof row.campaign === "object" ? row.campaign as JsonObject : {};
  const budget = row.campaignBudget && typeof row.campaignBudget === "object" ? row.campaignBudget as JsonObject : {};
  return {
    resourceName: normalize(campaign.resourceName),
    status: normalize(campaign.status),
    name: normalize(campaign.name),
    budgetResourceName: normalize(campaign.campaignBudget),
    budgetMicros: numberValue(budget.amountMicros),
  };
}

function validateCampaignId(value: string): boolean {
  return /^\d{5,30}$/.test(value);
}

function validateName(value: string): boolean {
  return !value || (value.length >= 3 && value.length <= 255);
}

export async function updateGoogleAdsCampaign(args: JsonObject, env: GoogleAdsOperationsEnv): Promise<JsonObject> {
  if (!configured(env)) throw new Error("google_ads_operations_not_configured");
  const customerId = digits(env.GOOGLE_ADS_CUSTOMER_ID);
  const campaignId = digits(args.campaign_id);
  const name = normalize(args.name);
  const status = normalize(args.status);
  const dailyBudgetEur = args.daily_budget_eur === undefined ? null : Number(args.daily_budget_eur);

  if (!validateCampaignId(campaignId)) throw new Error("invalid_google_ads_campaign_id");
  if (!validateName(name)) throw new Error("invalid_google_ads_campaign_name");
  if (status && !["PAUSED", "ENABLED"].includes(status)) throw new Error("unsupported_google_ads_status");
  if (dailyBudgetEur !== null && (!Number.isFinite(dailyBudgetEur) || dailyBudgetEur <= 0 || dailyBudgetEur > 100000)) {
    throw new Error("invalid_google_ads_daily_budget");
  }
  if (!name && !status && dailyBudgetEur === null) throw new Error("no_google_ads_changes_requested");

  if (status === "ENABLED" && normalize(args.approval_confirmation) !== ENABLE_CONFIRMATION) {
    throw new Error("google_ads_enable_confirmation_required");
  }
  if (status !== "ENABLED" && normalize(args.approval_confirmation) !== STANDARD_CONFIRMATION) {
    throw new Error("google_ads_execution_confirmation_required");
  }
  if (dailyBudgetEur !== null && normalize(args.budget_approval_confirmation) !== BUDGET_CONFIRMATION) {
    throw new Error("google_ads_budget_confirmation_required");
  }

  const before = await campaignSnapshot(env, customerId, campaignId);
  const operations: Array<{ resource: string; response: unknown }> = [];

  if (dailyBudgetEur !== null) {
    if (!before.budgetResourceName) throw new Error("google_ads_campaign_budget_not_found");
    const amountMicros = Math.round(dailyBudgetEur * 1_000_000);
    const response = await googleAdsRequest(env, `/customers/${customerId}/campaignBudgets:mutate`, {
      operations: [{
        updateMask: "amount_micros",
        update: {
          resourceName: before.budgetResourceName,
          amountMicros: String(amountMicros),
        },
      }],
      partialFailure: false,
      validateOnly: false,
      responseContentType: "MUTABLE_RESOURCE",
    });
    operations.push({ resource: "campaign_budget", response });
  }

  if (name || status) {
    const update: JsonObject = { resourceName: before.resourceName || `customers/${customerId}/campaigns/${campaignId}` };
    const masks: string[] = [];
    if (name) {
      update.name = name;
      masks.push("name");
    }
    if (status) {
      update.status = status;
      masks.push("status");
    }
    const response = await googleAdsRequest(env, `/customers/${customerId}/campaigns:mutate`, {
      operations: [{ updateMask: masks.join(","), update }],
      partialFailure: false,
      validateOnly: false,
      responseContentType: "MUTABLE_RESOURCE",
    });
    operations.push({ resource: "campaign", response });
  }

  return {
    ok: true,
    operation: "google_ads_campaign_update",
    status: "executed",
    external_write_performed: true,
    customer_id: customerId,
    campaign_id: campaignId,
    before: {
      name: before.name,
      status: before.status,
      daily_budget_eur: before.budgetMicros / 1_000_000,
    },
    requested: {
      name: name || null,
      status: status || null,
      daily_budget_eur: dailyBudgetEur,
    },
    mutation_results: operations,
    safety: {
      remove_exposed: false,
      enable_confirmation_verified: status === "ENABLED" ? true : null,
      budget_confirmation_verified: dailyBudgetEur !== null ? true : null,
      requires_human_review: true,
    },
  };
}
