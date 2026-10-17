import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";

export async function readAmazonMarketplaceParticipations(env: AmazonCredentials): Promise<unknown> {
  const accessToken = await getAmazonAccessToken(env);
  const response = await fetch("https://sellingpartnerapi-eu.amazon.com/sellers/v1/marketplaceParticipations", {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, "Accept": "application/json" }
  });
  if (!response.ok) throw new Error("amazon_marketplace_read_failed_" + response.status);
  return response.json();
}
