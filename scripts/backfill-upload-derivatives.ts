import path from "node:path";
import { config } from "../src/config.js";
import { backfillUploadDerivatives } from "../src/lib/uploadDerivativeBackfill.js";

interface CliOptions {
  dryRun: boolean;
  limit: number;
  concurrency: number;
  since?: Date;
  maxSizeBytes: number;
  maxPixels: number;
  timeoutMsPerFile: number;
}

const parseInteger = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
};

const parseArgs = (argv: string[]): CliOptions => {
  const readValue = (flag: string): string | undefined => {
    const index = argv.findIndex((arg) => arg === flag);
    if (index < 0) return undefined;
    return argv[index + 1];
  };

  const dryRun = argv.includes("--dry-run");
  const limit = parseInteger(readValue("--limit"), 500);
  const concurrency = parseInteger(readValue("--concurrency"), 2);
  const maxPixels = parseInteger(readValue("--max-pixels"), 40_000_000);
  const maxSizeMb = parseInteger(readValue("--max-size-mb"), 24);
  const timeoutMsPerFile = parseInteger(readValue("--timeout-ms"), 20_000);

  const sinceRaw = readValue("--since");
  const sinceDate = sinceRaw ? new Date(sinceRaw) : undefined;
  const since = sinceDate && Number.isFinite(sinceDate.getTime()) ? sinceDate : undefined;

  return {
    dryRun,
    limit,
    concurrency,
    since,
    maxSizeBytes: maxSizeMb * 1024 * 1024,
    maxPixels,
    timeoutMsPerFile
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs(process.argv.slice(2));
  const uploadRootDir = path.resolve(config.uploadDir);

  console.log("[backfill] start");
  console.log(
    `[backfill] options dryRun=${options.dryRun} limit=${options.limit} concurrency=${options.concurrency} since=${options.since?.toISOString() ?? "none"} maxSizeBytes=${options.maxSizeBytes} maxPixels=${options.maxPixels} timeoutMs=${options.timeoutMsPerFile}`
  );

  const summary = await backfillUploadDerivatives({
    uploadRootDir,
    ...options,
    log: (line) => console.log(`[backfill] ${line}`)
  });

  console.log(
    `[backfill] summary scanned=${summary.scanned} eligible=${summary.eligible} converted=${summary.converted} skipped=${summary.skipped} errors=${summary.errors}`
  );

  if (summary.errors > 0) {
    process.exitCode = 1;
  }
};

void main();
