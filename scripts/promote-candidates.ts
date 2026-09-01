import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { conferencesFromJson } from "../src/model.ts";
import { writePromotionBatch } from "../src/promotion.ts";

const observations = process.argv[2];
if (!observations) {
  process.stderr.write(
    "usage: node scripts/promote-candidates.ts <observations.jsonl> [--out outdir] [--existing data.json]\n",
  );
  process.exitCode = 2;
} else {
  const outIndex = process.argv.indexOf("--out");
  const outdir =
    (outIndex >= 0 ? process.argv[outIndex + 1] : process.argv[3]) ?? dirname(observations);
  const existingIndex = process.argv.indexOf("--existing");
  const existingPath =
    existingIndex >= 0
      ? process.argv[existingIndex + 1]
      : join(process.cwd(), "data", "snapshot.json");
  if (existingIndex >= 0 && !existingPath) {
    process.stderr.write("--existing requires a data.json path\n");
    process.exitCode = 2;
  } else {
    const existingConferences = existsSync(existingPath)
      ? conferencesFromJson(JSON.parse(readFileSync(existingPath, "utf8")))
      : undefined;
    mkdirSync(outdir, { recursive: true });
    const batchObservations = join(outdir, "observations.jsonl");
    if (resolve(observations) !== resolve(batchObservations))
      copyFileSync(observations, batchObservations);
    const resolutions = writePromotionBatch(
      batchObservations,
      join(outdir, "resolutions.json"),
      join(outdir, "manifest.json"),
      {
        sourceBaseDir: dirname(resolve(observations)),
        existingConferences,
      },
    );
    const canonical = Object.fromEntries(
      [...new Set(resolutions.map((item) => item.canonicalization?.decision).filter(Boolean))].map(
        (decision) => [
          decision,
          resolutions.filter((item) => item.canonicalization?.decision === decision).length,
        ],
      ),
    );
    process.stdout.write(
      `${JSON.stringify({
        promoted: resolutions.filter((item) => item.decision === "promote").length,
        canonical,
        total: resolutions.length,
      })}\n`,
    );
  }
}
