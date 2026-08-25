import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writePromotionBatch } from "../src/promotion.ts";

const observations = process.argv[2];
if (!observations) {
  process.stderr.write(
    "usage: node scripts/promote-candidates.ts <observations.jsonl> [--out outdir]\n",
  );
  process.exitCode = 2;
} else {
  const outIndex = process.argv.indexOf("--out");
  const outdir =
    (outIndex >= 0 ? process.argv[outIndex + 1] : process.argv[3]) ?? dirname(observations);
  mkdirSync(outdir, { recursive: true });
  const batchObservations = join(outdir, "observations.jsonl");
  if (resolve(observations) !== resolve(batchObservations))
    copyFileSync(observations, batchObservations);
  const resolutions = writePromotionBatch(
    batchObservations,
    join(outdir, "resolutions.json"),
    join(outdir, "manifest.json"),
    { sourceBaseDir: dirname(resolve(observations)) },
  );
  process.stdout.write(
    `${JSON.stringify({ promoted: resolutions.filter((item) => item.decision === "promote").length, total: resolutions.length })}\n`,
  );
}
