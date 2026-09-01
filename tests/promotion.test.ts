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
  resolvePromotionAgainst,
  verifyBatch,
  verifyCapture,
  verifyPromotionObservation,
  writePromotionBatch,
} from "../src/promotion.ts";
import { makeConference, makeDeadline, makeEdition, REPO_ROOT } from "./helpers.ts";

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

  it("extracts labels and dates from cells in the same table row", () => {
    expect(
      extractCfpCandidates(
        "<table><tr><th>Abstract registration deadline</th><td>September 1, 2026</td></tr>" +
          "<tr><td>Submission deadline</td><td>September 8, 2026</td></tr></table>",
      ),
    ).toMatchObject([
      { kind: "abstract", date: "2026-09-01" },
      { kind: "paper", date: "2026-09-08" },
    ]);
  });

  it("extracts multiple round dates and their following times from one line", () => {
    expect(
      extractCfpCandidates(
        "Submission Deadline: 31 July 2026, 18:00 CEST (First intake), " +
          "6 September 2026, 19:30 CEST (Second Intake)",
      ),
    ).toMatchObject([
      { date: "2026-07-31", time: "18:00:00", timezone: "CEST" },
      { date: "2026-09-06", time: "19:30:00", timezone: "CEST" },
    ]);
    expect(
      extractCfpCandidates(
        "Submission Deadline: 6 September 2026, 19:30 CEST, 31 July 2026, 18:00 CEST",
      ),
    ).toMatchObject([
      { date: "2026-09-06", time: "19:30:00" },
      { date: "2026-07-31", time: "18:00:00" },
    ]);
    expect(
      extractCfpCandidates("Submission Deadline: 2026-02-30 18:00 UTC, 2026-03-01 19:00 UTC"),
    ).toMatchObject([{ date: "2026-03-01", time: "19:00:00", timezone: "UTC" }]);
  });

  it("applies an explicit page-wide deadline time without treating the event date as a deadline", () => {
    const [deadline, notification, event] = extractCfpCandidates(
      "<li>Paper Submission Deadline <b>October 10, 2026</b></li>" +
        "<li>Author Notification <b>November 12, 2026 20:00 UTC</b></li>" +
        "<li>Conference Dates <b>December 14, 2026</b></li>" +
        "<p>All deadlines are 23:59 AoE (Anywhere on Earth).</p>",
    );
    expect(deadline).toMatchObject({
      date: "2026-10-10",
      time: "23:59:00",
      timezone: "AoE",
    });
    expect(notification).toMatchObject({
      date: "2026-11-12",
      time: "20:00:00",
      timezone: "UTC",
    });
    expect(event).not.toHaveProperty("time");
    expect(event).not.toHaveProperty("timezone");
  });

  it("extracts a deadline whose label and date are in adjacent blocks", () => {
    expect(
      extractCfpCandidates("<h1>Manuscript Submission Deadline</h1><p>November 17, 2026</p>"),
    ).toMatchObject([{ date: "2026-11-17", kind: "paper" }]);
  });

  it.each(["Preconference", "Eventual"])(
    "consumes a combined adjacent date line once: %s",
    (prefix) => {
      expect(
        extractCfpCandidates(`<h1>Paper Deadline</h1><p>${prefix} November 20, 2026</p>`),
      ).toHaveLength(1);
    },
  );

  it.each(["Conference Date", "Submissions Open", "Workshop starts", "Another milestone begins"])(
    "does not treat an adjacent %s label as a deadline",
    (label) => {
      expect(extractCfpCandidates(`<h1>${label}</h1><p>November 17, 2026</p>`)).toEqual([]);
    },
  );

  it.each([
    "Submissions open November 20, 2026",
    "Event November 20, 2026",
    "Conference begins November 20, 2026",
  ])("does not fall through to a blocked adjacent date line: %s", (line) => {
    expect(extractCfpCandidates(`<h1>Paper Deadline</h1><p>${line}</p>`)).toEqual([]);
  });

  it("does not treat a page-wide timing rule as an adjacent deadline label", () => {
    expect(
      extractCfpCandidates("<p>All deadlines are 23:59 AoE</p><p>November 17, 2026</p>"),
    ).toEqual([]);
  });

  it.each([
    ["Notification: November 18, 2026", "notification"],
    ["Camera-ready: November 19, 2026", "camera_ready"],
  ])("preserves an independent adjacent deadline milestone: %s", (line, kind) => {
    expect(extractCfpCandidates(`<h1>Paper Deadline</h1><p>${line}</p>`)).toMatchObject([{ kind }]);
  });

  it("applies page-wide timing only to the deadline in mixed and opening rows", () => {
    const rows = extractCfpCandidates(
      "Submission Deadline: October 10, 2026; Conference Dates: December 14, 2026\n" +
        "Paper submissions open October 1, 2026\n" +
        "Conference registration opens October 2, 2026\n" +
        "All deadlines are 23:59 AoE",
    );
    expect(rows[0]).toMatchObject({ time: "23:59:00", timezone: "AoE" });
    for (const row of rows.slice(1)) {
      expect(row).not.toHaveProperty("time");
      expect(row).not.toHaveProperty("timezone");
    }
  });

  it("does not combine a named row time with the page-wide default", () => {
    for (const rowTime of [
      "noon UTC",
      "5 PM UTC",
      "25:00 UTC",
      "at 1700 UTC",
      "1700 UTC",
      "1700",
    ]) {
      const [deadline] = extractCfpCandidates(
        `Paper deadline October 10, 2026 ${rowTime}\nAll deadlines are 23:59 UTC`,
      );
      expect(deadline).not.toHaveProperty("time");
      if (rowTime.includes("UTC")) expect(deadline).toMatchObject({ timezone: "UTC" });
      else expect(deadline).not.toHaveProperty("timezone");
    }
  });

  it.each([
    "All deadlines are not 23:59 AoE",
    "All deadlines are never 23:59 AoE",
    "All deadlines except the abstract deadline are 23:59 AoE",
    "All deadlines are 23:59 AoE, excluding the abstract deadline",
    "All deadlines are 23:59 AoE (except the abstract deadline).",
    "All deadlines are 23:59 AoE unless otherwise noted",
  ])("ignores a conditional or negated page-wide rule: %s", (rule) => {
    const [deadline] = extractCfpCandidates(`Paper deadline October 10, 2026\n${rule}`);
    expect(deadline).not.toHaveProperty("time");
    expect(deadline).not.toHaveProperty("timezone");
  });

  it("applies page-wide timing to a row containing only multiple deadlines", () => {
    expect(
      extractCfpCandidates(
        "Paper deadlines: Round 1 October 10, 2026; Round 2 November 10, 2026\n" +
          "All deadlines are 23:59 AoE",
      ),
    ).toMatchObject([
      { date: "2026-10-10", time: "23:59:00", timezone: "AoE" },
      { date: "2026-11-10", time: "23:59:00", timezone: "AoE" },
    ]);
  });

  it("does not guess timing for multiple dates whose times precede the dates", () => {
    const rows = extractCfpCandidates(
      "Paper deadlines: Round 1 at 17:00 UTC October 10, 2026; " +
        "Round 2 at 18:00 UTC November 10, 2026\nAll deadlines are 23:59 UTC",
    );
    for (const row of rows) {
      expect(row).not.toHaveProperty("time");
      expect(row).not.toHaveProperty("timezone");
    }
  });

  it("keeps main conference paper deadlines eligible for page-wide timing", () => {
    expect(
      extractCfpCandidates(
        "ExampleConf 2026 Main Conference Paper Deadline October 10, 2026\n" +
          "All deadlines are 23:59 AoE",
      ),
    ).toMatchObject([{ date: "2026-10-10", time: "23:59:00", timezone: "AoE" }]);
  });

  it("inherits a deadline header only when the next date has no label", () => {
    expect(
      extractCfpCandidates(
        "Paper deadlines: October 10, 2026; November 10, 2026\n" + "All deadlines are 23:59 AoE",
      ),
    ).toMatchObject([
      { date: "2026-10-10", time: "23:59:00", timezone: "AoE" },
      { date: "2026-11-10", time: "23:59:00", timezone: "AoE" },
    ]);
  });

  it("recognizes a deadline label after the only date", () => {
    expect(
      extractCfpCandidates("October 10, 2026 — Paper Deadline\nAll deadlines are 23:59 AoE"),
    ).toMatchObject([{ date: "2026-10-10", time: "23:59:00", timezone: "AoE" }]);
  });

  it.each([
    "October 10, 2026 — Paper Deadline; December 14, 2026 — Conference",
    "Paper Deadline: October 10, 2026; November 1, 2026 — Submissions Open",
  ])("does not inherit a label that belongs after another date: %s", (row) => {
    const candidates = extractCfpCandidates(`${row}\nAll deadlines are 23:59 AoE`);
    expect(candidates.at(-1)).not.toHaveProperty("time");
    expect(candidates.at(-1)).not.toHaveProperty("timezone");
  });

  it("recognizes comma-separated labels before multiple dates", () => {
    expect(
      extractCfpCandidates(
        "Paper Deadline, October 10, 2026; Notification, November 12, 2026\n" +
          "All deadlines are 23:59 AoE",
      ),
    ).toMatchObject([
      { date: "2026-10-10", time: "23:59:00", timezone: "AoE" },
      { date: "2026-11-12", time: "23:59:00", timezone: "AoE" },
    ]);
  });

  it.each(["-", "–", "—"])("recognizes a %s bullet before a deadline", (bullet) => {
    expect(
      extractCfpCandidates(
        `${bullet} Paper Deadline October 10, 2026\nAll deadlines are 23:59 AoE`,
      ),
    ).toMatchObject([{ date: "2026-10-10", time: "23:59:00", timezone: "AoE" }]);
  });

  it.each([
    "Conference: December 14, 2026; Paper Deadline: October 10, 2026",
    "Conference takes place December 14, 2026; Paper Deadline October 10, 2026",
    "Workshop: December 14, 2026; Paper Deadline: October 10, 2026",
  ])("does not apply page-wide timing to mixed event/deadline rows: %s", (row) => {
    const candidates = extractCfpCandidates(`${row}\nAll deadlines are 23:59 AoE`);
    expect(candidates[0]).not.toHaveProperty("time");
    expect(candidates[0]).not.toHaveProperty("timezone");
    expect(candidates[1]).toMatchObject({ time: "23:59:00", timezone: "AoE" });
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

  it("canonicalizes verified promotions against existing venue and edition identities", () => {
    const existing = makeConference({
      key: "exampleconf",
      title: "ExampleConf",
      link: "https://example.test/cfp",
      identity: { officialDomains: ["example.test"] },
      editions: [
        makeEdition({
          year: 2027,
          link: "https://example.test/cfp",
          event_start: new Date("2027-04-01T00:00:00Z"),
          event_end: new Date("2027-04-03T00:00:00Z"),
          deadlines: [
            {
              ...makeDeadline("paper", "Paper", new Date("2027-01-03T11:59:00Z"), "AoE", 2),
              track: "main",
            },
          ],
        }),
      ],
    });
    expect(
      resolvePromotionAgainst(observation(), {
        now: "2026-08-25T00:03:00.000Z",
        existingConferences: [existing],
      }).canonicalization,
    ).toMatchObject({ decision: "duplicate", matchedVenueKey: "exampleconf" });
    expect(
      resolvePromotionAgainst(observation({ deadline: { ...observation().deadline!, round: 3 } }), {
        now: "2026-08-25T00:03:00.000Z",
        existingConferences: [existing],
      }).canonicalization?.decision,
    ).toBe("enrich-existing-edition");
    expect(
      resolvePromotionAgainst(observation(), {
        now: "2026-08-25T00:03:00.000Z",
        existingConferences: [
          makeConference({
            key: "exampleconf-2026",
            title: "ExampleConf",
            link: "https://other.test/cfp",
            identity: { officialDomains: ["other.test"] },
          }),
        ],
      }).canonicalization?.decision,
    ).toBe("hold");
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
