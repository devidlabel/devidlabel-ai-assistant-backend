import assistantWorker from "./worker-v2";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleShopifyReportingRequest } from "./shopify-reporting";

type WorkerEnv = Parameters<typeof assistantWorker.fetch>[1] & {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
  SHOPIFY_REPORT_ACCESS_TOKEN?: string;
  COMMERCE_TENANT_ID?: string;
};
type WorkerExecutionContext = Parameters<typeof assistantWorker.fetch>[2];

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const shopifyResponse = await handleShopifyReportingRequest(request, env);
    if (shopifyResponse) return shopifyResponse;

    const klaviyoResponse = await handleKlaviyoReportingRequest(request, env);
    if (klaviyoResponse) return klaviyoResponse;

    return assistantWorker.fetch(request, env, context);
  },
};
