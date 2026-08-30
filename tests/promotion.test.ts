import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { observeCfp } from "../scripts/observe-cfp.ts";
import {
  type CfpCapture,
  canonicalJson,
  extractCfpCandidates,
  isOfficialUrl,
  type PromotionObservation,
  resolvePromotion,
  verifyBatch,
  verifyCapture,
  verifyPromotionObservation,
  writePromotionBatch,
} from "../src/promotion.ts";
import { REPO_ROOT } from "./helpers.ts";

const evidence = {
  sourceRevision: "rev-1",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  verifiedAt: "2026-08-25T00:01:00.000Z",
  contentHash: "",
};

const capturedBody =
  "Paper deadline: January 2, 2027 23:59 AoE\nNotification: January 3, 2027 23:59 AoE";
const capturedBodyPath = join(mkdtempSync(join(tmpdir(), "kamiyobi-promotion-body-")), "cfp.html");
writeFileSync(capturedBodyPath, capturedBody);
const capturedHash = createHash("sha256").update(capturedBody).digest("hex");
evidence.contentHash = capturedHash;

const defaultCapture: CfpCapture = {
  requestedUrl: "https://example.test/cfp",
  finalUrl: "https://example.test/cfp",
  status: 200,
  headers: { etag: "rev-1" },
  retrievedAt: evidence.retrievedAt,
  contentHash: capturedHash,
  parserVersion: "test/1",
  bodyPath: capturedBodyPath,
  excerpt: capturedBody,
  candidates: [
    {
      rawExcerpt: capturedBody,
      date: "2027-01-02",
      time: "23:59:00",
      timezone: "AoE",
      editionYear: 2027,
    },
  ],
  sourceRevision: "rev-1",
  officialDomains: ["example.test"],
};

function observation(overrides: Partial<PromotionObservation> = {}): PromotionObservation {
  return {
    candidate: "exampleconf",
    sourceUrl: "https://example.test/cfp",
    sourceClass: "official-cfp",
    officialDomains: ["example.test"],
    title: "ExampleConf",
    categories: ["systems"],
    tags: ["workshop"],
    reviewState: "reviewed",
    categoryReviewState: "reviewed",
    deadline: {
      date: "2027-01-02",
      time: "23:59:00",
      timezone: "AoE",
      kind: "paper",
      round: 2,
      track: "main",
    },
    eventDate: "2027-04-01",
    eventEndDate: "2027-04-03",
    rawExcerpt: "Paper deadline: January 2, 2027 23:59 AoE",
    evidence,
    capture: defaultCapture,
    ...overrides,
  };
}

describe("promotion batch", () => {
  it("extracts notification and camera-ready dates across inline markup", () => {
    expect(
      extractCfpCandidates(
        "<li>Notification of Acceptance: <b>October 23, 202</b>6</li>" +
          "<li>Camera-ready: <strong>November 9, 2026</strong></li>",
      ),
    ).toMatchObject([
      { date: "2026-10-23", kind: "notification" },
      { date: "2026-11-09", kind: "camera_ready" },
    ]);
  });

  it("requires explicit venue and category review before promotion", () => {
    expect(resolvePromotion(observation({ reviewState: undefined })).decision).toBe("hold");
    expect(resolvePromotion(observation({ categories: [] })).decision).toBe("hold");
    expect(resolvePromotion(observation({ categoryReviewState: "pending" })).decision).toBe("hold");
    expect(resolvePromotion(observation()).decision).toBe("promote");
  });

  it("requires the extracted deadline kind to match", () => {
    expect(
      resolvePromotion(
        observation({ deadline: { ...observation().deadline!, kind: "notification" } }),
      ).decision,
    ).toBe("hold");
  });

  it("promotes exact and date-only primary observations with normalized field evidence", () => {
    const exact = resolvePromotion(observation());
    expect(exact).toMatchObject({
      decision: "promote",
      normalized: {
        venue: { key: "exampleconf", categories: ["systems"], tags: ["workshop"] },
        edition: { year: 2027, event_start: "2027-04-01", event_end: "2027-04-03" },
        deadline: { precision: "exact", kind: "paper", round: 2, track: "main", tz: "AoE" },
      },
    });
    const dateOnly = resolvePromotion(
      observation({ deadline: { date: "2027-01-02", kind: "paper", round: 1 } }),
    );
    expect(dateOnly.normalized?.deadline).toMatchObject({
      precision: "date-only",
      date: "2027-01-02",
    });
    const dateOnlyEvidence = dateOnly.normalized!.deadline.evidence as Array<
      Record<string, unknown>
    >;
    expect(dateOnlyEvidence[0]).toMatchObject({
      sourceClass: "official-cfp",
      sourceRevision: "rev-1",
      contentHash: capturedHash,
      verifiedFields: ["date", "kind", "round"],
    });
  });

  it("holds missing primary fields and rejects non-primary observations", () => {
    expect(
      resolvePromotion(observation({ evidence: { ...evidence, contentHash: "" } })).decision,
    ).toBe("hold");
    expect(resolvePromotion(observation({ sourceClass: "aggregator" })).decision).toBe("reject");
    expect(resolvePromotion(observation({ capture: undefined })).decision).toBe("hold");
  });

  it("holds impossible dates, times, zones, and incoherent edition years", () => {
    expect(
      resolvePromotion(
        observation({
          title: "ExampleConf 2027",
          eventDate: undefined,
          deadline: { date: "2026-99-99", time: "99:99", timezone: "Mars/Phobos" },
        }),
      ).decision,
    ).toBe("hold");
    expect(resolvePromotion(observation({ eventEndDate: undefined })).decision).toBe("hold");
    const previousYearBody = "Paper deadline: January 2, 2026 23:59 UTC";
    const previousYearBodyPath = join(
      mkdtempSync(join(tmpdir(), "kamiyobi-promotion-previous-year-")),
      "cfp.html",
    );
    writeFileSync(previousYearBodyPath, previousYearBody);
    const previousYearHash = createHash("sha256").update(previousYearBody).digest("hex");
    const previousYearDeadline = resolvePromotion(
      observation({
        title: "ExampleConf 2027",
        eventDate: undefined,
        eventEndDate: undefined,
        deadline: { date: "2026-01-02", time: "23:59", timezone: "UTC" },
        capture: {
          ...defaultCapture,
          bodyPath: previousYearBodyPath,
          contentHash: previousYearHash,
          excerpt: previousYearBody,
          candidates: [
            {
              rawExcerpt: previousYearBody,
              date: "2026-01-02",
              time: "23:59:00",
              timezone: "UTC",
              editionYear: 2027,
            },
          ],
        },
        evidence: { ...evidence, contentHash: previousYearHash, rawExcerpt: previousYearBody },
      }),
    );
    expect(previousYearDeadline).toMatchObject({
      decision: "promote",
      normalized: { edition: { year: 2027 } },
    });
    expect(
      resolvePromotion(
        observation({
          title: "ExampleConf 2028",
          eventDate: "2027-04-01",
          eventEndDate: "2027-04-03",
          deadline: { date: "2026-01-02", time: "23:59", timezone: "UTC" },
        }),
      ).decision,
    ).toBe("hold");
  });

  it("writes byte-identical isolated batch artifacts and verifies JSONL files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-promotion-"));
    const observations = join(dir, "observations.jsonl");
    writeFileSync(
      observations,
      `${JSON.stringify(observation())}\n${JSON.stringify(
        observation({
          deadline: {
            date: "2027-01-03",
            time: "23:59:00",
            timezone: "AoE",
            kind: "notification",
            round: 2,
            track: "main",
          },
          rawExcerpt: "Notification: January 3, 2027 23:59 AoE",
        }),
      )}\n${JSON.stringify(observation({ candidate: "hold", title: undefined }))}\n`,
    );
    const files = ["observations.jsonl", "resolutions.json", "manifest.json", "extra.yaml"];
    const run = () =>
      writePromotionBatch(observations, join(dir, "resolutions.json"), join(dir, "manifest.json"));
    expect(run().map((resolution) => resolution.decision)).toEqual(["promote", "promote", "hold"]);
    const first = Object.fromEntries(
      files.map((file) => [file, readFileSync(join(dir, file), "utf8")]),
    );
    run();
    expect(
      Object.fromEntries(files.map((file) => [file, readFileSync(join(dir, file), "utf8")])),
    ).toEqual(first);
    expect(first["extra.yaml"]).toContain("precision: exact");
    expect(first["extra.yaml"].match(/key: exampleconf/g)).toHaveLength(1);
    expect(first["extra.yaml"].match(/kind: /g)).toHaveLength(2);
    expect(JSON.parse(first["manifest.json"])).toMatchObject({
      id: expect.any(String),
      extra: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      bodies: [
        {
          path: expect.stringMatching(/^bodies\/[0-9a-f]{64}\.body$/),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
    });
    const verified = spawnSync("node", ["scripts/verify-cfp.ts", "--file", observations], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(verified.status).toBe(1);
    expect(JSON.parse(verified.stdout)).toHaveLength(3);

    const generated = join(dir, "generated");
    const promoted = spawnSync(
      "node",
      ["scripts/promote-candidates.ts", observations, "--out", generated],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(promoted.status).toBe(0);
    for (const file of files) expect(existsSync(join(generated, file))).toBe(true);
    const generatedManifest = JSON.parse(readFileSync(join(generated, "manifest.json"), "utf8"));
    expect(existsSync(join(generated, generatedManifest.bodies[0].path))).toBe(true);
  });

  it("captures a deterministic body and verifies hash, excerpt, domain, extraction, and freshness", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-cfp-"));
    const bodyPath = join(dir, "nested", "body.html");
    const body = "<h1>ExampleConf 2027</h1>\n<p>Paper deadline: January 2, 2027 23:59 AoE</p>";
    await expect(
      observeCfp({
        url: "https://example.test/cfp",
        fetch: async () => new Response(body),
      }),
    ).rejects.toThrow("saved body path is required");
    const capture = (await observeCfp({
      url: "https://example.test/cfp",
      bodyPath,
      retrievedAt: "2026-08-25T00:00:00.000Z",
      officialDomains: ["example.test"],
      fetch: async () =>
        new Response(body, {
          status: 200,
          headers: { etag: "rev-1", "content-type": "text/html", "set-cookie": "sid=secret" },
        }),
    })) as PromotionObservation & CfpCapture;
    expect(capture).toMatchObject({
      requestedUrl: "https://example.test/cfp",
      finalUrl: "https://example.test/cfp",
      status: 200,
      sourceRevision: "rev-1",
      contentHash: createHash("sha256").update(body).digest("hex"),
    });
    expect(capture.candidates).toEqual([
      expect.objectContaining({ date: "2027-01-02", time: "23:59:00", timezone: "AoE" }),
    ]);
    expect(capture.headers["set-cookie"]).toBeUndefined();
    expect(canonicalJson(capture)).toBe(canonicalJson({ ...capture }));
    expect(readFileSync(bodyPath, "utf8")).toBe(body);

    const verified = verifyCapture(capture, {
      now: "2026-08-25T00:01:00.000Z",
      maxAgeMs: 86_400_000,
    });
    expect(verified.valid).toBe(true);
    expect(verifyCapture({ ...capture, contentHash: "0".repeat(64) }).errors).toContain(
      "body hash mismatch",
    );
    expect(
      verifyCapture({ ...capture, excerpt: "missing" }, { officialDomains: ["example.test"] })
        .errors,
    ).toContain("excerpt is not contained in saved body");
    expect(
      verifyCapture(
        { ...capture, retrievedAt: "2026-01-01T00:00:00.000Z" },
        { now: "2026-08-25T00:00:00.000Z" },
      ).errors,
    ).toContain("source revision is stale");
    expect(isOfficialUrl("https://example.test.evil/cfp", ["example.test"])).toBe(false);

    expect(
      verifyCapture(
        {
          ...capture,
          retrievedAt: "2026-08-25T00:02:00.000Z",
          sourceRevision: "rev-2",
          headers: { ...capture.headers, etag: "rev-2" },
        },
        { now: "2026-08-25T00:03:00.000Z", previousCapture: capture },
      ).valid,
    ).toBe(true);
    expect(
      verifyCapture(
        { ...capture, retrievedAt: "2026-08-25T00:02:00.000Z" },
        { now: "2026-08-25T00:03:00.000Z", previousCapture: capture },
      ).errors,
    ).toContain("source revision is unchanged from previous capture");

    expect(
      resolvePromotion(observation({ capture: { ...capture }, previousCapture: { ...capture } }), {
        now: "2026-08-25T00:03:00.000Z",
      }).decision,
    ).toBe("hold");

    const promoted = observation({
      capture: capture as CfpCapture,
      officialDomains: ["example.test"],
      evidence: {
        ...evidence,
        sourceRevision: "rev-1",
        retrievedAt: capture.retrievedAt,
        contentHash: capture.contentHash,
        rawExcerpt: "Paper deadline: January 2, 2027 23:59 AoE",
      },
    });
    expect(verifyPromotionObservation(promoted, { now: "2026-08-25T00:01:00.000Z" }).valid).toBe(
      true,
    );
  });

  it("rejects altered, missing, injected, and manifest-mismatched CFP evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-cfp-evidence-"));
    const bodyPath = join(dir, "cfp.html");
    writeFileSync(bodyPath, capturedBody);
    const capture = { ...defaultCapture, bodyPath };

    writeFileSync(bodyPath, "Paper deadline: January 3, 2027 23:59 AoE");
    expect(verifyCapture(capture).errors).toContain("body hash mismatch");
    expect(
      verifyPromotionObservation(
        observation({
          capture: {
            ...capture,
            contentHash: createHash("sha256")
              .update("Paper deadline: January 3, 2027 23:59 AoE")
              .digest("hex"),
            candidates: defaultCapture.candidates,
          },
        }),
      ).errors,
    ).toContain("deadline fields were not found in extraction candidates");
    expect(
      verifyCapture({ ...defaultCapture, bodyPath: join(dir, "missing.html") }).errors,
    ).toContain("saved body missing");

    writeFileSync(bodyPath, capturedBody);
    const observations = join(dir, "observations.jsonl");
    writeFileSync(observations, `${JSON.stringify(observation({ capture }))}\n`);
    writePromotionBatch(observations, join(dir, "resolutions.json"), join(dir, "manifest.json"));
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.bodies[0].sha256 = "0".repeat(64);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    expect(verifyBatch(observations)[0]).toMatchObject({
      decision: "hold",
      verification: { errors: expect.arrayContaining(["manifest body hash mismatch"]) },
    });
    manifest.bodies[0].path = "../outside.body";
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    expect(() => verifyBatch(observations)).toThrow("manifest bodies must contain path and sha256");
  });
});
