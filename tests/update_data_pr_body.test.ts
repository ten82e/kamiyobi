import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatUpdateDataPrBody } from "../scripts/update-data-pr-body.ts";
import { tempWork } from "./helpers.ts";

const diagnostics = {
  health: { tracked_venues: 696, source_failures: [] as string[], parse_warning_count: 0 },
  recommendation: { changed_top5: ["paper-1"], new_venues_in_top5: ["venue-1"] },
  categoryChanges: "No validator category changes.",
  deadlineChanges: "Deadline changes: 1\n- IPDPS: official paper deadline updated",
  runUrl: "https://github.com/ten82e/kamiyobi/actions/runs/37198773535",
};

describe("bounded automatic data PR diagnostics", () => {
  it("preserves small reports and links their complete artifact", () => {
    const body = formatUpdateDataPrBody(diagnostics);
    expect(body).toContain(diagnostics.categoryChanges);
    expect(body).toContain(diagnostics.deadlineChanges);
    expect(body).toContain("tracked venues 696; source failures: none; warnings: 0");
    expect(body).toContain("1 cases; paper-1");
    expect(body).toContain(diagnostics.runUrl);
    expect(body).not.toContain("Preview shortened");
  });

  it("keeps large first-update reports within GitHub's limit without changing diagnostics", () => {
    const input = structuredClone(diagnostics);
    input.categoryChanges = `Category changes: 10000\n${"- 日本語の会議と分類の変更\n".repeat(10000)}`;
    input.deadlineChanges = `Deadline changes: 10000\n${"- 原文の締切・年度・ラウンドを保持\n".repeat(10000)}`;
    input.recommendation.changed_top5 = Array<string>(10000).fill("paper-1");
    input.recommendation.new_venues_in_top5 = Array<string>(10000).fill("venue-1");
    input.health.source_failures = Array<string>(10000).fill("source");
    const before = structuredClone(input);
    const body = formatUpdateDataPrBody(input);
    expect(body.length).toBeLessThan(60000);
    expect(body).toContain("10000 cases");
    expect(body).toContain("Category changes: 10000");
    expect(body).toContain("Deadline changes: 10000");
    expect(body).toContain("Preview shortened");
    expect(body).toContain(input.runUrl);
    expect(input).toEqual(before);
  });

  it("does not split surrogate pairs when a long diagnostic has no newline", () => {
    const body = formatUpdateDataPrBody({ ...diagnostics, deadlineChanges: "😀".repeat(40000) });
    expect(body.length).toBeLessThan(60000);
    expect(body).not.toMatch(/\ud83d(?!\ude00)/);
    expect(body).not.toMatch(/(?<!\ud83d)\ude00/);
  });

  it("renders the uploaded diagnostic files through the workflow CLI", () => {
    const dir = tempWork("update-pr-body-");
    writeFileSync(join(dir, "health.json"), JSON.stringify(diagnostics.health));
    writeFileSync(
      join(dir, "recommendation-delta.json"),
      JSON.stringify(diagnostics.recommendation),
    );
    writeFileSync(join(dir, "category-delta.md"), diagnostics.categoryChanges);
    const full = `Deadline changes: 6000\n${"- Original evidence-backed deadline change\n".repeat(6000)}`;
    writeFileSync(join(dir, "deadline-delta.md"), full);
    const body = execFileSync(process.execPath, ["scripts/update-data-pr-body.ts", dir], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_REPOSITORY: "ten82e/kamiyobi", GITHUB_RUN_ID: "37198773535" },
    });
    expect(body.length).toBeLessThan(65536);
    expect(body).toContain(diagnostics.runUrl);
    expect(body).toContain("Deadline changes: 6000");
    expect(readFileSync(join(dir, "deadline-delta.md"), "utf8")).toBe(full);
  });
});
