import fs from "node:fs";
import { runSneakerCatalogPilot } from "./amazon-sneakers-catalog-pilot.mjs";

const report = await runSneakerCatalogPilot({
  bearer: process.env.DAILY_PULSE_ACCESS_TOKEN || "",
  sampleOffset: 4,
  limitPerMarket: 4,
  delayMs: 2200
});
fs.writeFileSync("/tmp/amazon-sneakers-catalog-batch2.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
