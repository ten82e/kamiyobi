import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { conferencesFromJson } from "../src/model.ts";
import { writePromotionBatch } from "../src/promotion.ts";

const observations = process.argv[2];
if (!observations) {
  process.stderr.write(
    "usage: node scripts/promote-candidates.ts <observations.jsonl> [--out outdir] [--existing data.json]\n",
  );
  process.exitCode = 2;
} else {
  const options = process.argv.slice(3);
  let optionError = "";
  for (let index = 0; index < options.length; ) {
    const option = options[index];
    if (option !== "--out" && option !== "--existing") {
      optionError = `unknown option: ${option}`;
      break;
    }
    const value = options[index + 1];
    if (!value || value.startsWith("--")) {
      optionError = `${option} requires a value`;
      break;
    }
    index += 2;
  }
  const outIndex = process.argv.indexOf("--out");
  const outdir =
    outIndex >= 0 ? (process.argv[outIndex + 1] ?? dirname(observations)) : dirname(observations);
  const existingIndex = process.argv.indexOf("--existing");
  const existingPath =
    existingIndex >= 0
      ? process.argv[existingIndex + 1]
      : join(process.cwd(), "data", "snapshot.json");
  if (optionError) {
    process.stderr.write(`${optionError}\n`);
    process.exitCode = 2;
  } else {
    const existingConferences = existsSync(existingPath)
      ? conferencesFromJson(JSON.parse(readFileSync(existingPath, "utf8")))
      : undefined;
    const config = loadYaml(readFileSync(join(process.cwd(), "config.yaml"), "utf8")) as {
      promotion?: { canonicalization_margin?: unknown };
    };
    const configuredMargin = Number(config.promotion?.canonicalization_margin);
    const canonicalizationMargin =
      Number.isFinite(configuredMargin) && configuredMargin >= 0 ? configuredMargin : 40;
    const batchObservations = join(outdir, "observations.jsonl");
    const resolutions = writePromotionBatch(
      observations,
      join(outdir, "resolutions.json"),
      join(outdir, "manifest.json"),
      {
        sourceBaseDir: dirname(resolve(observations)),
        outputObservationsPath: batchObservations,
        existingConferences,
        canonicalizationMargin,
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
