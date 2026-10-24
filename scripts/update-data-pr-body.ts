import { readFileSync } from "node:fs";
import { join } from "node:path";

interface UpdateDiagnostics {
  health: { tracked_venues: number; source_failures: string[]; parse_warning_count: number };
  recommendation: { changed_top5: string[]; new_venues_in_top5: string[] };
  categoryChanges: string;
  deadlineChanges: string;
  runUrl: string;
}

/** Keep complete diagnostics in the artifact and bound only their PR presentation. */
function preview(text: string, limit: number): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  const note =
    "\n\n… Preview shortened. Complete diagnostics are in the generated-update artifact.";
  const budget = limit - note.length;
  let end = value.lastIndexOf("\n", budget);
  if (end < budget / 2) end = budget;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end) + note;
}

export function formatUpdateDataPrBody(input: UpdateDiagnostics): string {
  const { health, recommendation } = input;
  const body = `${[
    "## Automated data update",
    `- health: tracked venues ${health.tracked_venues}; source failures: ${preview(health.source_failures.join(", ") || "none", 2048)}; warnings: ${health.parse_warning_count}`,
    `- recommendation Top-5 changes: ${recommendation.changed_top5.length} cases; ${preview(recommendation.changed_top5.join(", ") || "none", 2048)}`,
    `- new venues in Top-5: ${recommendation.new_venues_in_top5.length}; ${preview(recommendation.new_venues_in_top5.join(", ") || "none", 2048)}`,
    `\nComplete diagnostics: [generated-update artifact](${input.runUrl}). The artifact retains the full category and deadline changes.`,
    "\n## Validator category changes",
    preview(input.categoryChanges, 20000),
    "\n## Deadline semantic changes",
    preview(input.deadlineChanges, 20000),
  ].join("\n")}\n`;
  if (body.length > 60000) throw new Error("Data PR body exceeds its safe presentation budget");
  return body;
}

if (process.argv[1]?.endsWith("update-data-pr-body.ts")) {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node scripts/update-data-pr-body.ts <artifact-directory>");
  const runUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(runUrl))
    throw new Error("Missing or invalid GitHub run identity");
  process.stdout.write(
    formatUpdateDataPrBody({
      health: JSON.parse(readFileSync(join(dir, "health.json"), "utf8")),
      recommendation: JSON.parse(readFileSync(join(dir, "recommendation-delta.json"), "utf8")),
      categoryChanges: readFileSync(join(dir, "category-delta.md"), "utf8"),
      deadlineChanges: readFileSync(join(dir, "deadline-delta.md"), "utf8"),
      runUrl,
    }),
  );
}
