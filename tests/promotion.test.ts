import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCurated } from "../scripts/generate-curated.ts";
import { observeCfp } from "../scripts/observe-cfp.ts";
import type { Conference } from "../src/model.ts";
import {
  type CfpCapture,
  canonicalJson,
  extractCfpCandidates,
  isOfficialUrl,
  type PromotionObservation,
  providerIdentityFromUrl,
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
    const acronymOnly = makeConference({
      key: "exampleconf",
      title: "Entirely Different Conference",
      link: "https://different.example/cfp",
      identity: { venueId: "exampleconf", officialDomains: ["different.example"] },
      editions: [
        makeEdition({
          year: 2027,
          link: "https://different.example/cfp",
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
        existingConferences: [acronymOnly],
      }).canonicalization,
    ).toMatchObject({ decision: "hold", autoApplicable: false });
  });

  it("keeps shared providers scoped and honors explicit catalog identities", () => {
    const providerObservation = (
      url: string,
      overrides: Partial<PromotionObservation> = {},
    ): PromotionObservation => {
      const providerIdentity = providerIdentityFromUrl(url);
      const hostname = new URL(url).hostname;
      return observation({
        candidate: "incoming",
        sourceUrl: url,
        officialDomains: [hostname],
        providerIdentity,
        evidence: { ...evidence, sourceUrl: url },
        capture: {
          ...defaultCapture,
          requestedUrl: url,
          finalUrl: url,
          officialDomains: [hostname],
          providerIdentity,
        },
        ...overrides,
      });
    };
    const existing = (link: string, overrides: Partial<Conference> = {}) =>
      makeConference({
        key: "existing",
        title: "ExampleConf",
        full_name: "ExampleConf",
        link,
        identity: { officialDomains: [new URL(link).hostname] },
        editions: [
          makeEdition({
            year: 2027,
            edition_id: "existing-2027",
            link,
            deadlines: [
              {
                ...makeDeadline(
                  "paper",
                  "Paper submission deadline",
                  new Date("2027-01-03T11:59:00Z"),
                  "AoE",
                  2,
                ),
                track: "main",
              },
            ],
          }),
        ],
        ...overrides,
      });

    expect(providerIdentityFromUrl("https://easychair.org/cfp/ICCR2026")).toMatchObject({
      provider: "easychair",
      providerKey: "cfp/iccr2026",
      strength: "provider-scoped",
    });
    expect(
      providerIdentityFromUrl("https://openreview.net/group?id=ICLR.cc/2027/Conference"),
    ).toMatchObject({
      provider: "openreview",
      providerKey: "iclr.cc/2027/conference",
      strength: "provider-scoped",
    });
    expect(providerIdentityFromUrl("https://foo2027.github.io/cfp/")).toMatchObject({
      provider: "github-pages",
      providerKey: "foo2027.github.io/cfp",
      strength: "provider-scoped",
    });
    expect(providerIdentityFromUrl("https://conference-example.org/cfp")).toMatchObject({
      provider: "dedicated-domain",
      providerKey: "conference-example.org",
      strength: "dedicated-domain",
    });
    expect(
      providerIdentityFromUrl("https://ieeexplore.ieee.org/xpl/conhome.jsp?punumber=111"),
    ).not.toEqual(
      providerIdentityFromUrl("https://ieeexplore.ieee.org/xpl/conhome.jsp?punumber=222"),
    );
    expect(providerIdentityFromUrl("https://dl.acm.org/event.cfm?id=111")).not.toEqual(
      providerIdentityFromUrl("https://dl.acm.org/event.cfm?id=222"),
    );
    expect(providerIdentityFromUrl("https://sigcomm2027.acm.org/cfp")).not.toEqual(
      providerIdentityFromUrl("https://sigmod2027.acm.org/cfp"),
    );
    expect(providerIdentityFromUrl("https://infocom2027.ieee.org/cfp")).not.toEqual(
      providerIdentityFromUrl("https://ispa2027.ieee.org/cfp"),
    );

    const easychair = "https://easychair.org/cfp/ICCR2026";
    expect(
      resolvePromotionAgainst(providerObservation(easychair), {
        existingConferences: [existing("https://easychair.org/cfp/other2026")],
      }).canonicalization,
    ).toMatchObject({ decision: "hold" });
    expect(
      resolvePromotionAgainst(providerObservation(easychair), {
        existingConferences: [existing(easychair)],
      }).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedBy: expect.arrayContaining(["provider-identity"]),
    });

    const openReview = "https://openreview.net/group?id=ICLR.cc/2027/Conference";
    expect(
      resolvePromotionAgainst(providerObservation(openReview), {
        existingConferences: [existing("https://openreview.net/group?id=ICLR.cc/2027/Workshop")],
      }).canonicalization,
    ).toMatchObject({ decision: "hold" });

    expect(
      resolvePromotionAgainst(providerObservation("https://sigcomm2027.acm.org/cfp"), {
        existingConferences: [existing("https://sigmod2027.acm.org/cfp")],
      }).canonicalization,
    ).toMatchObject({ decision: "hold" });

    const dedicated = "https://conference-example.org/cfp";
    expect(
      resolvePromotionAgainst(providerObservation(dedicated), {
        existingConferences: [existing(dedicated)],
      }).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedBy: expect.arrayContaining(["provider-identity"]),
    });
    expect(
      resolvePromotionAgainst(providerObservation(dedicated), {
        existingConferences: [
          existing("https://conference-example.org/other-event", {
            key: "other-event",
            title: "Other Event",
            full_name: "Other Event",
          }),
        ],
      }).canonicalization,
    ).toMatchObject({ decision: "hold", autoApplicable: false });

    const stableVenue = existing("https://easychair.org/cfp/other", {
      identity: { venueId: "venue-1", officialDomains: ["easychair.org"] },
    });
    expect(
      resolvePromotionAgainst(
        providerObservation("https://easychair.org/cfp/incoming", { venueId: "venue-1" }),
        { existingConferences: [stableVenue] },
      ).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedBy: expect.arrayContaining(["stable-venue-id"]),
    });

    const stableEdition = existing("https://example.test/cfp", {
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "stable-edition",
          link: "https://edition.example.test/cfp",
          deadlines: [
            {
              ...makeDeadline(
                "paper",
                "Paper submission deadline",
                new Date("2027-01-03T11:59:00Z"),
                "AoE",
                2,
              ),
              track: "main",
            },
          ],
        }),
      ],
    });
    expect(
      resolvePromotionAgainst(
        providerObservation("https://example.test/cfp", { editionId: "stable-edition" }),
        { existingConferences: [stableEdition] },
      ).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedBy: expect.arrayContaining(["stable-edition-id"]),
    });
    expect(
      resolvePromotionAgainst(
        providerObservation("https://incoming.example/cfp", {
          candidate: "old-example",
          title: "Unrelated Conference",
          officialDomains: ["incoming.example"],
        }),
        {
          existingConferences: [
            existing("https://existing.example/cfp", { legacy_keys: ["old-example"] }),
          ],
        },
      ).canonicalization,
    ).toMatchObject({
      decision: "add-new-edition",
      matchedVenueKey: "existing",
      matchedBy: expect.arrayContaining(["legacy-key"]),
    });
    expect(
      resolvePromotionAgainst(
        providerObservation("https://incoming.example/cfp", {
          candidate: "unrelated",
          title: "Unrelated Conference",
          officialDomains: ["incoming.example"],
          editionId: "stable-edition",
        }),
        { existingConferences: [stableEdition] },
      ).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedVenueKey: "existing",
      matchedBy: expect.arrayContaining(["stable-edition-id"]),
    });

    const callIdentity = {
      seriesId: "example",
      editionId: "call-edition",
      callId: "call-1",
      parentEventId: null,
    } as const;
    const callExisting = existing("https://example.test/cfp", {
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "other-edition",
          link: "https://edition.example.test/cfp",
          call_identity: callIdentity,
          deadlines: [
            {
              ...makeDeadline(
                "paper",
                "Paper submission deadline",
                new Date("2027-01-03T11:59:00Z"),
                "AoE",
                2,
              ),
              track: "main",
            },
          ],
        }),
      ],
    });
    expect(
      resolvePromotionAgainst(providerObservation("https://example.test/cfp", { callIdentity }), {
        existingConferences: [callExisting],
      }).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedBy: expect.arrayContaining(["call-identity"]),
    });
    expect(
      resolvePromotionAgainst(
        providerObservation("https://incoming.example/cfp", {
          candidate: "unrelated",
          title: "Unrelated Conference",
          officialDomains: ["incoming.example"],
          callIdentity,
        }),
        { existingConferences: [callExisting] },
      ).canonicalization,
    ).toMatchObject({
      decision: "duplicate",
      matchedBy: expect.arrayContaining(["call-identity"]),
    });
    expect(
      resolvePromotionAgainst(
        providerObservation("https://example.test/cfp", {
          callIdentity: { ...callIdentity, callId: "other-call" },
        }),
        { existingConferences: [callExisting] },
      ).canonicalization,
    ).toMatchObject({ decision: "add-new-edition" });

    const ambiguous = [
      existing(dedicated),
      makeConference({ ...existing(dedicated), key: "other" }),
    ];
    expect(
      resolvePromotionAgainst(providerObservation(dedicated), {
        existingConferences: ambiguous,
        canonicalizationMargin: 40,
      }).canonicalization,
    ).toMatchObject({ decision: "hold", margin: 0, autoApplicable: false });
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
    const files = ["observations.jsonl", "resolutions.json", "manifest.json"];
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
    expect(JSON.parse(first["manifest.json"])).toMatchObject({
      id: expect.any(String),
      bodies: [
        {
          path: expect.stringMatching(/^evidence\/blobs\/[0-9a-f]{64}\.body$/),
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
    });
    expect(JSON.parse(first["manifest.json"]).extra).toBeUndefined();
    expect(existsSync(join(dir, "extra.yaml"))).toBe(false);
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
    expect(existsSync(join(generated, "extra.yaml"))).toBe(false);
    const generatedManifest = JSON.parse(readFileSync(join(generated, "manifest.json"), "utf8"));
    expect(existsSync(join(generated, generatedManifest.bodies[0].path))).toBe(true);

    const withoutOut = spawnSync(
      "node",
      [
        "scripts/promote-candidates.ts",
        observations,
        "--existing",
        join(REPO_ROOT, "data/snapshot.json"),
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(withoutOut.status).toBe(0);
    expect(existsSync(join(dir, "manifest.json"))).toBe(true);
  });

  it("does not verify a replacement batch against its stale output manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-promotion-replace-"));
    const observations = join(dir, "observations.jsonl");
    const resolutions = join(dir, "resolutions.json");
    const manifest = join(dir, "manifest.json");
    writeFileSync(observations, `${JSON.stringify(observation())}\n`);
    expect(writePromotionBatch(observations, resolutions, manifest)[0]?.decision).toBe("promote");

    const body = "Paper deadline: February 2, 2027 23:59 AoE";
    const bodyPath = join(dir, "updated.html");
    const contentHash = createHash("sha256").update(body).digest("hex");
    writeFileSync(bodyPath, body);
    writeFileSync(
      observations,
      `${JSON.stringify(
        observation({
          deadline: {
            date: "2027-02-02",
            time: "23:59:00",
            timezone: "AoE",
            kind: "paper",
            round: 2,
            track: "main",
          },
          rawExcerpt: body,
          evidence: {
            ...evidence,
            sourceRevision: `sha256:${contentHash}`,
            contentHash,
          },
          capture: {
            ...defaultCapture,
            headers: {},
            bodyPath,
            excerpt: body,
            candidates: extractCfpCandidates(body),
            sourceRevision: `sha256:${contentHash}`,
            contentHash,
          },
        }),
      )}\n`,
    );

    expect(writePromotionBatch(observations, resolutions, manifest)[0]?.decision).toBe("promote");
  });

  it("does not rewrite batch files when replacement validation throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-promotion-invalid-replace-"));
    const observations = join(dir, "observations.jsonl");
    const resolutions = join(dir, "resolutions.json");
    const manifest = join(dir, "manifest.json");
    const invalidObservation = JSON.stringify(
      observation({ categoryReviewState: { systems: "invalid" } as never, capture: undefined }),
    );
    writeFileSync(observations, invalidObservation);
    writeFileSync(resolutions, "previous resolutions\n");
    writeFileSync(manifest, "previous manifest\n");

    expect(() => writePromotionBatch(observations, resolutions, manifest)).toThrow(
      /category review state/,
    );
    expect(readFileSync(observations, "utf8")).toBe(invalidObservation);
    expect(readFileSync(resolutions, "utf8")).toBe("previous resolutions\n");
    expect(readFileSync(manifest, "utf8")).toBe("previous manifest\n");
  });

  it("relocates a flat capture when the CLI writes to another directory", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "kamiyobi-promotion-flat-source-"));
    const outDir = join(mkdtempSync(join(tmpdir(), "kamiyobi-promotion-flat-out-")), "batch");
    const bodyPath = join(sourceDir, "capture.body");
    writeFileSync(bodyPath, capturedBody);
    const { bodyPath: _ignored, ...flatCapture } = defaultCapture;
    const source = join(sourceDir, "observations.jsonl");
    writeFileSync(
      source,
      `${JSON.stringify(
        observation({ capture: undefined, ...flatCapture, bodyPath: "capture.body" }),
      )}\n`,
    );

    const promoted = spawnSync(
      "node",
      [
        "scripts/promote-candidates.ts",
        source,
        "--out",
        outDir,
        "--existing",
        join(sourceDir, "missing.json"),
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    expect(promoted.status).toBe(0);
    const written = JSON.parse(readFileSync(join(outDir, "observations.jsonl"), "utf8"));
    expect(written.capture).toBeUndefined();
    expect(written.bodyPath).toMatch(/^evidence\/blobs\/[0-9a-f]{64}\.body$/);
    expect(verifyBatch(join(outDir, "observations.jsonl"))[0]?.decision).toBe("promote");
  });

  it("does not rewrite CLI batch files when validation throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-promotion-cli-invalid-"));
    const source = join(dir, "invalid.jsonl");
    const outDir = join(dir, "batch");
    const files = ["observations.jsonl", "resolutions.json", "manifest.json"];
    writeFileSync(
      source,
      JSON.stringify(
        observation({ categoryReviewState: { systems: "invalid" } as never, capture: undefined }),
      ),
    );
    for (const file of files) {
      const path = join(outDir, file);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path, `previous ${file}\n`);
    }

    const promoted = spawnSync(
      "node",
      [
        "scripts/promote-candidates.ts",
        source,
        "--out",
        outDir,
        "--existing",
        join(dir, "missing.json"),
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );

    expect(promoted.status).not.toBe(0);
    for (const file of files)
      expect(readFileSync(join(outDir, file), "utf8")).toBe(`previous ${file}\n`);
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
    writeFileSync(
      observations,
      `${JSON.stringify(observation({ capture }))}\n${JSON.stringify(
        observation({ candidate: "hold", title: undefined, capture }),
      )}\n`,
    );
    writePromotionBatch(observations, join(dir, "resolutions.json"), join(dir, "manifest.json"));
    const originalObservation = readFileSync(observations, "utf8");
    const [firstObservation, ...remainingObservations] = originalObservation.trimEnd().split("\n");
    const changedObservation = JSON.parse(firstObservation!);
    changedObservation.candidate = "tampered";
    writeFileSync(
      observations,
      `${[JSON.stringify(changedObservation), ...remainingObservations].join("\n")}\n`,
    );
    const tampered = spawnSync("node", ["scripts/verify-cfp.ts", "--file", observations], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("manifest observations hash mismatch");
    writeFileSync(observations, originalObservation);
    const resolutions = join(dir, "resolutions.json");
    const originalResolutions = readFileSync(resolutions, "utf8");
    writeFileSync(
      resolutions,
      originalResolutions.replace('"candidate": "exampleconf"', '"candidate": "tampered"'),
    );
    const tamperedResolutions = spawnSync(
      "node",
      ["scripts/verify-cfp.ts", "--file", observations],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(tamperedResolutions.status).toBe(1);
    expect(tamperedResolutions.stderr).toContain("manifest resolutions hash mismatch");
    writeFileSync(resolutions, originalResolutions);
    const semanticTamper = JSON.parse(originalResolutions);
    semanticTamper[0].normalized.deadline.date = "2099-01-01";
    const semanticTamperText = `${JSON.stringify(semanticTamper, null, 2)}\n`;
    writeFileSync(resolutions, semanticTamperText);
    const manifestPath = join(dir, "manifest.json");
    const semanticManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    semanticManifest.resolutions.sha256 = createHash("sha256")
      .update(semanticTamperText)
      .digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(semanticManifest, null, 2)}\n`);
    const semanticallyTampered = spawnSync(
      "node",
      ["scripts/verify-cfp.ts", "--file", observations],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(semanticallyTampered.status).toBe(1);
    expect(semanticallyTampered.stderr).toContain("stored promotion resolution semantics mismatch");
    const evidenceTamper = JSON.parse(originalResolutions);
    evidenceTamper[0].normalized.deadline.evidence[0].sourceUrl = "https://evil.test/cfp";
    const evidenceTamperText = `${JSON.stringify(evidenceTamper, null, 2)}\n`;
    writeFileSync(resolutions, evidenceTamperText);
    semanticManifest.resolutions.sha256 = createHash("sha256")
      .update(evidenceTamperText)
      .digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(semanticManifest, null, 2)}\n`);
    expect(() => verifyBatch(observations)).toThrow(
      "stored promotion resolution evidence mismatch",
    );
    const duplicateIds = JSON.parse(originalResolutions);
    duplicateIds[1].resolution_id = duplicateIds[0].resolution_id;
    const duplicateIdsText = `${JSON.stringify(duplicateIds, null, 2)}\n`;
    writeFileSync(resolutions, duplicateIdsText);
    semanticManifest.resolutions.sha256 = createHash("sha256")
      .update(duplicateIdsText)
      .digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(semanticManifest, null, 2)}\n`);
    expect(() => verifyBatch(observations)).toThrow(
      "stored promotion resolution IDs must be present and unique",
    );
    writeFileSync(resolutions, originalResolutions);
    semanticManifest.resolutions.sha256 = createHash("sha256")
      .update(originalResolutions)
      .digest("hex");
    writeFileSync(manifestPath, `${JSON.stringify(semanticManifest, null, 2)}\n`);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    manifest.bodies[0].sha256 = "0".repeat(64);
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    expect(verifyBatch(observations)[0]).toMatchObject({
      decision: "hold",
      verification: { errors: expect.arrayContaining(["manifest body hash mismatch"]) },
    });
    const verified = spawnSync("node", ["scripts/verify-cfp.ts", "--file", observations], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(verified.status).toBe(1);
    expect(JSON.parse(verified.stdout)[0]).toMatchObject({
      decision: "hold",
      verification: { errors: expect.arrayContaining(["manifest body hash mismatch"]) },
    });
    manifest.bodies[0].path = "../outside.body";
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    expect(() => verifyBatch(observations)).toThrow("manifest bodies must contain path and sha256");
  });

  it("does not rewrite curated data from a semantically altered resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curated-semantic-tamper-"));
    const dataDir = join(root, "data");
    const batchDir = join(dataDir, "promotions", "batch");
    mkdirSync(batchDir, { recursive: true });
    const emptyYaml = "schema_version: 1\nconferences: []\n";
    const extra = join(dataDir, "extra.yaml");
    const manual = join(dataDir, "manual.yaml");
    const curated = join(dataDir, "curated.generated.yaml");
    writeFileSync(extra, emptyYaml);
    writeFileSync(manual, emptyYaml);
    writeFileSync(curated, emptyYaml);
    const observations = join(batchDir, "observations.jsonl");
    const resolutions = join(batchDir, "resolutions.json");
    const manifest = join(batchDir, "manifest.json");
    writeFileSync(observations, `${JSON.stringify(observation())}\n`);
    writePromotionBatch(observations, resolutions, manifest);

    const changed = JSON.parse(readFileSync(resolutions, "utf8"));
    changed[0].canonicalization = {
      decision: "add-new-edition",
      matchedVenueKey: "missing",
      score: 100,
      matchedBy: ["tampered"],
      reason: "tampered",
    };
    const changedText = `${JSON.stringify(changed, null, 2)}\n`;
    writeFileSync(resolutions, changedText);
    const changedManifest = JSON.parse(readFileSync(manifest, "utf8"));
    changedManifest.resolutions.sha256 = createHash("sha256").update(changedText).digest("hex");
    writeFileSync(manifest, `${JSON.stringify(changedManifest, null, 2)}\n`);
    const files = [extra, manual, curated, observations, resolutions, manifest];
    const before = files.map((path) => readFileSync(path, "utf8"));

    expect(() => generateCurated(root)).toThrow(
      "stored promotion resolution ID does not match its semantics",
    );
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("rejects deleting an applied add-new-edition decision", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-curated-canonical-deletion-"));
    const dataDir = join(root, "data");
    const batchDir = join(dataDir, "promotions", "batch");
    mkdirSync(batchDir, { recursive: true });
    const catalog = [
      "conferences:",
      "  - key: demo",
      "    title: ExampleConf",
      "    link: https://example.test/",
      "    identity:",
      "      venueId: demo-series",
      "      sourceIds: {official: demo}",
      "    editions:",
      "      - {year: 2026, id: demo-2026}",
      "",
    ].join("\n");
    const extra = join(dataDir, "extra.yaml");
    const manual = join(dataDir, "manual.yaml");
    const curated = join(dataDir, "curated.generated.yaml");
    writeFileSync(extra, catalog);
    writeFileSync(manual, catalog);
    const observations = join(batchDir, "observations.jsonl");
    const resolutions = join(batchDir, "resolutions.json");
    const manifest = join(batchDir, "manifest.json");
    const promoted = observation({
      candidate: "old-demo",
      venueIdentity: { venueId: "demo-series", sourceIds: { official: "demo" } },
    });
    writeFileSync(observations, `${JSON.stringify(promoted)}\n`);
    const existing = makeConference({
      key: "demo",
      title: "ExampleConf",
      link: "https://example.test/",
      identity: { venueId: "demo-series", sourceIds: { official: "demo" } },
      editions: [makeEdition({ year: 2026, edition_id: "demo-2026" })],
    });
    const [written] = writePromotionBatch(observations, resolutions, manifest, {
      existingConferences: [existing],
    });
    expect(written?.canonicalization).toMatchObject({
      decision: "add-new-edition",
      matchedVenueKey: "demo",
    });
    writeFileSync(
      curated,
      `conferences:\n  - key: demo\n    editions:\n      - year: 2027\n        id: old-demo-2027\n        deadlines:\n          - {kind: paper, round: 2, track: main, promotion_ref: {batch: batch, resolution: ${written!.resolution_id}}}\n`,
    );

    const changed = JSON.parse(readFileSync(resolutions, "utf8"));
    delete changed[0].canonicalization;
    const changedText = `${JSON.stringify(changed, null, 2)}\n`;
    writeFileSync(resolutions, changedText);
    const changedManifest = JSON.parse(readFileSync(manifest, "utf8"));
    changedManifest.resolutions.sha256 = createHash("sha256").update(changedText).digest("hex");
    writeFileSync(manifest, `${JSON.stringify(changedManifest, null, 2)}\n`);
    const files = [extra, manual, curated, observations, resolutions, manifest];
    const before = files.map((path) => readFileSync(path, "utf8"));

    expect(() => generateCurated(root)).toThrow(
      "stored promotion resolution ID does not match its published deadline",
    );
    expect(files.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });
});
