import { getAmazonAccessToken, type AmazonCredentials } from "./amazon-auth";
import { AMAZON_EU_MARKETPLACES } from "./amazon-marketplaces";

/** Metadata only. Does not request report creation or download report contents. */
export async function readAmazonListingReportMetadata(
  env: AmazonCredentials,
  market: keyof typeof AMAZON_EU_MARKETPLACES
): Promise<unknown> {
  const marketplaceId = AMAZON_EU_MARKETPLACES[market];
  if (!marketplaceId) throw new Error("amazon_invalid_marketplace");
  const accessToken = await getAmazonAccessToken(env);
  const url = new URL("https://sellingpartnerapi-eu.amazon.com/reports/2021-06-30/reports");
  url.searchParams.set("reportTypes", "GET_MERCHANT_LISTINGS_ALL_DATA");
  url.searchParams.set("marketplaceIds", marketplaceId);
  url.searchParams.set("pageSize", "20");
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { "x-amz-access-token": accessToken, Accept: "application/json" }
  });
  if (!response.ok) throw new Error("amazon_reports_read_failed_" + response.status);
  const body = await response.json() as { reports?: Array<Record<string, unknown>>; nextToken?: string };
  return {
    marketplace: market,
    marketplace_id: marketplaceId,
    reports: (body.reports || []).map(r => ({
      reportId: r.reportId,
      reportType: r.reportType,
      processingStatus: r.processingStatus,
      createdTime: r.createdTime,
      processingEndTime: r.processingEndTime,
      reportDocumentAvailable: Boolean(r.reportDocumentId)
    })),
    has_more: Boolean(body.nextToken)
  };
}
