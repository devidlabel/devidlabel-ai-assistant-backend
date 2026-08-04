const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

type JsonObject = Record<string, unknown>;

export type GoogleServiceAccountCredentials = {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
};

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlJson(value: JsonObject): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemPkcs8Buffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) throw new Error("Google service-account private key is empty");
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

export function parseGoogleServiceAccount(rawValue: unknown): GoogleServiceAccountCredentials | null {
  const raw = normalize(rawValue);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as JsonObject;
    const clientEmail = normalize(parsed.client_email);
    const privateKey = normalize(parsed.private_key);
    const privateKeyId = normalize(parsed.private_key_id);
    const tokenUri = normalize(parsed.token_uri);
    if (!clientEmail || !privateKey) return null;
    return {
      client_email: clientEmail,
      private_key: privateKey,
      ...(privateKeyId ? { private_key_id: privateKeyId } : {}),
      ...(tokenUri ? { token_uri: tokenUri } : {}),
    };
  } catch {
    return null;
  }
}

export async function googleServiceAccountAccessToken(rawValue: unknown, scope: string): Promise<string> {
  const credentials = parseGoogleServiceAccount(rawValue);
  if (!credentials) throw new Error("Google service-account credentials are not configured");
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || GOOGLE_OAUTH_TOKEN_URL;
  const header: JsonObject = {
    alg: "RS256",
    typ: "JWT",
    ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}),
  };
  const claims: JsonObject = {
    iss: credentials.client_email,
    scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemPkcs8Buffer(credentials.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json() as JsonObject;
  if (!response.ok || typeof payload.access_token !== "string") {
    const error = new Error(`Google service-account OAuth failed (${response.status})`);
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload.access_token;
}
