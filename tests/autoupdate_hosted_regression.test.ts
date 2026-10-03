import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateData } from "../scripts/validate-data.ts";
import { evaluateHealthGate, healthReport, toJson } from "../src/build.ts";
import { applyOverrides, mergeSources, normalizeConfiguredVenueIdentities } from "../src/merge.ts";
import { conferencesFromJson } from "../src/model.ts";

describe("captured hosted updater failure", () => {
  it("reconciles captured earlier-date and disappearing-track transitions with official evidence", () => {
    const captured = JSON.parse(
      readFileSync("tests/fixtures/autoupdate-deadline-transitions.json", "utf8"),
    );
    const now = new Date("2026-10-03T06:00:00Z");
    const options = { profileHash: "official-transition-review" };
    const previous = healthReport(captured.baseline, now, options);
    expect(
      evaluateHealthGate(healthReport(captured.current, now, options), previous).reasons,
    ).toHaveLength(5);
    const overrides = load(readFileSync("data/overrides.yaml", "utf8")) as Record<string, unknown>;
    const config = load(readFileSync("config.yaml", "utf8")) as Record<string, unknown>;
    const output = toJson(
      applyOverrides(conferencesFromJson(captured.current), overrides),
      config,
      now,
    );
    const report = healthReport(output, now, options);
    expect(evaluateHealthGate(report, previous).reasons).toEqual([]);
    expect(
      report.deadline_refs!.find((ref) => ref.deadline_id === "iscas|iscas27|paper|1|")?.at_utc,
    ).toBe("2026-10-14T04:59:59.000Z");
    expect(
      report.deadline_refs!.find((ref) => ref.deadline_id.startsWith("dasfaa|dasfaa27|paper"))
        ?.at_utc,
    ).toBe("2026-11-26T11:59:00.000Z");
    const evo = report.deadline_refs!.find((ref) => ref.deadline_id.startsWith("evomusart-2027|"))!;
    expect(evo.local_date).toBe("2026-11-01");
    expect(evo.at_utc).toBeUndefined();
    const changed = structuredClone(previous);
    changed.deadline_refs!.find(
      (ref) => ref.deadline_id === "wsdm|wsdm27-ccfddl-wsdm27|paper|2|",
    )!.at_utc = "2026-11-19T11:59:59.000Z";
    changed.deadline_refs!.find(
      (ref) => ref.deadline_id === "wsdm|wsdm27-ccfddl-wsdm27|paper|2|",
    )!.earliest_utc = "2026-11-19T11:59:59.000Z";
    changed.deadline_refs!.find(
      (ref) => ref.deadline_id === "wsdm|wsdm27-ccfddl-wsdm27|paper|2|",
    )!.latest_utc = "2026-11-19T11:59:59.000Z";
    expect(evaluateHealthGate(report, changed).ok).toBe(false);
    expect(() =>
      toJson(
        conferencesFromJson(captured.current),
        { ...config, deadline_identity_migrations: [{}] },
        now,
      ),
    ).toThrow("invalid reviewed identity migrations");
  });
  it("resolves official CFP corrections without hiding unknown times or dropping other EG slots", () => {
    const captured = JSON.parse(
      readFileSync("tests/fixtures/autoupdate-deadline-conflicts.json", "utf8"),
    );
    const now = new Date("2026-10-03T05:00:00Z");
    const options = { profileHash: "official-cfp-review" };
    const before = healthReport(captured.current, now, options);
    expect(
      evaluateHealthGate(before, healthReport(captured.baseline, now, options)).reasons,
    ).toHaveLength(3);
    const overrides = load(readFileSync("data/overrides.yaml", "utf8")) as Record<string, unknown>;
    const output = toJson(
      applyOverrides(conferencesFromJson(captured.current), overrides),
      {},
      now,
    );
    expect(
      evaluateHealthGate(
        healthReport(output, now, options),
        healthReport(captured.baseline, now, options),
      ).ok,
    ).toBe(true);
    const conferences = output.conferences as typeof captured.current.conferences;
    const eg = conferences.find((conf: { key: string }) => conf.key === "eurographics").editions[0];
    const oldEg = captured.current.conferences.find(
      (conf: { key: string }) => conf.key === "eurographics",
    ).editions[0];
    expect(eg.deadlines).toEqual(
      oldEg.deadlines.filter(
        (deadline: { kind: string }) => !["abstract", "paper"].includes(deadline.kind),
      ),
    );
    const secure = conferences.find((conf: { key: string }) => conf.key === "securecomm")
      .editions[0];
    expect(
      secure.deadlines.map((deadline: Record<string, unknown>) => [
        deadline.round,
        deadline.local_date,
        deadline.at_utc,
      ]),
    ).toEqual([
      [1, "2027-02-01", undefined],
      [2, "2027-04-15", undefined],
    ]);
    expect(secure.deadlines[0].superseded_deadlines[0].value).toBe("2027-03-01T23:59:00Z");
    for (const deadline of secure.deadlines) {
      const evidence = deadline.evidence[0];
      expect(evidence.verifiedFields).not.toContain("time");
      expect(evidence.verifiedFields).not.toContain("timezone");
    }
    const revised = conferencesFromJson(captured.current);
    const paper = revised
      .find((conf) => conf.key === "eurographics")!
      .editions[0].deadlines.find((deadline) => deadline.kind === "paper")!;
    if ("at_utc" in paper) paper.at_utc = new Date("2026-10-08T23:59:00Z");
    const next = applyOverrides(revised, overrides).find((conf) => conf.key === "eurographics")!
      .editions[0];
    expect(next.deadlines.some((deadline) => deadline.kind === "paper")).toBe(true);
  });

  it("carries refreshed source snapshots through the actual artifact capture and restore steps", () => {
    const workflow = load(readFileSync(".github/workflows/update-data.yml", "utf8")) as {
      jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
    };
    const capture = workflow.jobs["generate-data"].steps.find(
      (step) => step.name === "Summarize category changes",
    )!.run!;
    const copy = capture.slice(
      capture.indexOf("          cp public/health.json"),
      capture.indexOf("          mkdir -p /tmp/kamiyobi-update/baseline"),
    );
    // YAML block scalars are de-indented by the parser.
    const block =
      copy ||
      capture.slice(
        capture.indexOf("cp public/health.json"),
        capture.indexOf("mkdir -p /tmp/kamiyobi-update/baseline"),
      );
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-source-handoff-"));
    try {
      for (const dir of ["data/source-snapshots", "public", "artifact/data", "restored/data"])
        mkdirSync(join(root, dir), { recursive: true });
      for (const name of ["snapshot.json", "primary_overrides.yaml", "discovered_candidates.yaml"])
        writeFileSync(join(root, "data", name), "{}");
      writeFileSync(join(root, "public/health.json"), "{}");
      for (const name of ["ccfddl", "aideadlines", "local", "primary"])
        writeFileSync(
          join(root, "data/source-snapshots", `${name}.json`),
          JSON.stringify({ revision: `${name}-fresh`, fetchedAt: "2026-10-03T05:00:00Z" }),
        );
      execFileSync(
        "bash",
        ["-c", block.replaceAll("/tmp/kamiyobi-update", join(root, "artifact"))],
        { cwd: root },
      );
      const restore = workflow.jobs["write-data-pr"].steps.find(
        (step) => step.name === "Restore generated data",
      )!.run!;
      execFileSync(
        "bash",
        ["-c", restore.replaceAll("/tmp/kamiyobi-update", join(root, "artifact"))],
        { cwd: join(root, "restored") },
      );
      for (const name of ["ccfddl", "aideadlines", "local", "primary"])
        expect(
          JSON.parse(
            readFileSync(join(root, "restored/data/source-snapshots", `${name}.json`), "utf8"),
          ).revision,
        ).toBe(`${name}-fresh`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
