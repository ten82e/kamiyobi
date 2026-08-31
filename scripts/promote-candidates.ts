import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conferencesFromJson } from "../src/model.ts";
import { writePromotionBatch } from "../src/promotion.ts";

const ROOT = dirname(fileURLToPath(new URL("..", import.meta.url)));
const observations = process.argv[2];
if (!observations) {
  process.stderr.write(
    "usage: node scripts/promote-candidates.ts <observations.jsonl> [--out outdir] [--existing data.json] [--evidence dir]\n",
  );
  process.exitCode = 2;
} else {
  const outIndex = process.argv.indexOf("--out");
  const outdir =
    (outIndex >= 0 ? process.argv[outIndex + 1] : process.argv[3]) ?? dirname(observations);
  const existingIndex = process.argv.indexOf("--existing");
  const existingPath = existingIndex >= 0 ? process.argv[existingIndex + 1] : "public/data.json";
  const evidenceIndex = process.argv.indexOf("--evidence");
  const evidenceDir =
    (evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined) ??
    join(ROOT, "data", "evidence", "blobs");
  const existingConferences =
    existingPath && existsSync(resolve(existingPath))
      ? conferencesFromJson(JSON.parse(readFileSync(resolve(existingPath), "utf8")))
      : undefined;
  mkdirSync(outdir, { recursive: true });
  const batchObservations = join(outdir, "observations.jsonl");
  if (resolve(observations) !== resolve(batchObservations))
    copyFileSync(observations, batchObservations);
  const resolutions = writePromotionBatch(
    batchObservations,
    join(outdir, "resolutions.json"),
    join(outdir, "manifest.json"),
    { sourceBaseDir: dirname(resolve(observations)), existingConferences, evidenceDir },
  );
  process.stdout.write(
    `${JSON.stringify({
      promoted: resolutions.filter((item) =>
        [
          "promote",
          "add-new-venue",
          "add-new-edition",
          "enrich-existing-edition",
          "supersede-existing-deadline",
        ].includes(item.decision),
      ).length,
      total: resolutions.length,
      decisions: Object.fromEntries(
        [...new Set(resolutions.map((item) => item.decision))]
          .sort()
          .map((decision) => [
            decision,
            resolutions.filter((item) => item.decision === decision).length,
          ]),
      ),
    })}\n`,
  );
}
