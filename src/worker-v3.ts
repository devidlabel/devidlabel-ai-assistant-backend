import assistantWorker from "./worker-v2";
import { handleKlaviyoReportingRequest } from "./klaviyo-reporting";
import { handleMetaReportingRequest } from "./meta-reporting";

type WorkerEnv = Parameters<typeof assistantWorker.fetch>[1] & {
  KLAVIYO_PRIVATE_API_KEY?: string;
  KLAVIYO_REPORT_ACCESS_TOKEN?: string;
  KLAVIYO_CONVERSION_METRIC_ID?: string;
  META_ADS_ACCESS_TOKEN?: string;
  META_AD_ACCOUNT_ID?: string;
  META_GRAPH_API_VERSION?: string;
  META_REPORT_ACCESS_TOKEN?: string;
};
type WorkerExecutionContext = Parameters<typeof assistantWorker.fetch>[2];

export default {
  async fetch(request: Request, env: WorkerEnv, context: WorkerExecutionContext): Promise<Response> {
    const klaviyoResponse = await handleKlaviyoReportingRequest(request, env);
    if (klaviyoResponse) return klaviyoResponse;

    const metaResponse = await handleMetaReportingRequest(request, env);
    if (metaResponse) return metaResponse;

    return assistantWorker.fetch(request, env, context);
  },
};
