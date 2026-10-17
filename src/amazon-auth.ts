export interface AmazonCredentials {
  AMAZON_SP_API_CLIENT_ID?: string;
  AMAZON_SP_API_CLIENT_SECRET?: string;
  AMAZON_SP_API_REFRESH_TOKEN?: string;
}

export async function getAmazonAccessToken(env: AmazonCredentials): Promise<string> {
  const clientId = env.AMAZON_SP_API_CLIENT_ID;
  const clientSecret = env.AMAZON_SP_API_CLIENT_SECRET;
  const refreshToken = env.AMAZON_SP_API_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error("amazon_credentials_missing");
  const response = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!response.ok) throw new Error("amazon_lwa_failed_" + response.status);
  const body = await response.json() as { access_token?: string };
  if (!body.access_token) throw new Error("amazon_access_token_missing");
  return body.access_token;
}
