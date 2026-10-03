import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateData } from "../scripts/validate-data.ts";
import { toJson } from "../src/build.ts";
import { applyOverrides, mergeSources, normalizeConfiguredVenueIdentities } from "../src/merge.ts";
import { conferencesFromJson } from "../src/model.ts";

describe("captured hosted updater failure", () => {
  it("fixes all 20 errors while retaining each historical edition year and original held dates", () => {
    const captured = JSON.parse(
      readFileSync("tests/fixtures/autoupdate-hosted-regression.json", "utf8"),
    );
    const before = validateData(captured);
    expect(before.errors).toHaveLength(20);
    expect(
      before.errors.filter((error) => error.startsWith("duplicate venue edition")),
    ).toHaveLength(7);
    const config = load(readFileSync("config.yaml", "utf8")) as Record<string, unknown>;
    const overrides = load(readFileSync("data/overrides.yaml", "utf8")) as {
      conferences: Record<string, { editions?: Record<string, Record<string, unknown>> }>;
    };
    const merged = mergeSources(
      [normalizeConfiguredVenueIdentities(conferencesFromJson(captured), config)],
      config,
    );
    const reviewPatches = Object.fromEntries(
      merged.map((conf) => [
        conf.key,
        {
          editions: Object.fromEntries(
            Object.entries(overrides.conferences[conf.key]?.editions ?? {}).filter(
              ([id, patch]) =>
                patch.event_review && conf.editions.some((ed) => ed.edition_id === id),
            ),
          ),
        },
      ]),
    );
    const output = toJson(
      applyOverrides(merged, { conferences: reviewPatches }),
      config,
      new Date("2026-10-03"),
    );
    expect(validateData(output).errors).toEqual([]);
    const conferences = output.conferences as Array<{
      key: string;
      editions: Array<Record<string, unknown>>;
    }>;
    expect(conferences).toHaveLength(14);
    for (const key of ["adma", "dai", "focs", "mobicom", "slt", "wasa", "probml"]) {
      const original = captured.conferences.find((conf: { key: string }) => conf.key === key)
        .editions[0];
      const edition = conferences.find((conf) => conf.key === key)?.editions[0];
      expect(edition).toMatchObject(
        Object.fromEntries(
          ["id", "year", "date_text", "event_start", "event_end"].map((field) => [
            field,
            original[field],
          ]),
        ),
      );
    }
  });

  it("keeps a branch canary read-only and reports actual skipped/failed gates", () => {
    const workflow = load(readFileSync(".github/workflows/update-data.yml", "utf8")) as {
      jobs: Record<
        string,
        {
          if?: string;
          steps: Array<{ id?: string; name?: string; with?: Record<string, string>; run?: string }>;
        }
      >;
    };
    const generate = workflow.jobs["generate-data"];
    expect(generate.steps.find((step) => step.name === "Checkout update source")?.with?.ref).toBe(
      `\${{ inputs.dry_run && github.ref || 'main' }}`,
    );
    expect(workflow.jobs["write-data-pr"].if).toBe(`\${{ !inputs.dry_run }}`);
    expect(generate.steps.find((step) => step.id === "validate")?.name).toBe(
      "Validate generated production data",
    );
    expect(generate.steps.find((step) => step.id === "health")?.name).toBe("Health gate");
    const summary = generate.steps.find((step) => step.name === "Summarize blocked update")?.run;
    expect(summary).toContain(`\${{ steps.validate.outcome }}`);
    expect(summary).toContain(`\${{ steps.health.outcome }}`);
    expect(summary).not.toContain("blocked by health gate");
  });
});
