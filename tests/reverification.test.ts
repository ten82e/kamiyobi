import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toJson } from "../src/build.ts";
import type { Conference } from "../src/model.ts";
import { reverifyDue, stableDeadlineId } from "../src/reverification.ts";
import { makeConference, makeDeadline, makeEdition } from "./helpers.ts";

const NOW = new Date("2026-08-31T00:00:00.000Z");

function fixtureConference(): Conference {
  const deadline = makeDeadline(
    "paper",
    "Paper deadline",
    new Date("2026-09-20T23:59:00.000Z"),
    "UTC",
  );
  deadline.verification = {
    official_url: "https://example.test/cfp",
    last_attempt_at: null,
    last_verified_at: null,
    next_check_at: NOW.toISOString(),
    content_hash: null,
    status: "pending",
  };
  return makeConference({
    key: "example",
    title: "Example",
    identity: { venueId: "example" },
    editions: [
      makeEdition({
        year: 2026,
        edition_id: "example-2026",
        identity: { editionId: "example-2026" },
        link: "https://example.test/cfp",
        deadlines: [deadline],
      }),
    ],
  });
}

function paths() {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverification-"));
  return {
    root,
    dataPath: join(root, "data.json"),
    ledgerPath: join(root, "verification-ledger.json"),
    resolutionsPath: join(root, "reverification-resolutions.json"),
    evidenceDir: join(root, "evidence", "blobs"),
  };
}

function writeData(path: string, conference = fixtureConference()): void {
  writeFileSync(path, JSON.stringify(toJson([conference], {}, NOW)), "utf8");
}

describe("persistent deadline reverification", () => {
  it("records an official deadline change without overwriting the live value", async () => {
    const file = paths();
    const conference = fixtureConference();
    writeData(file.dataPath, conference);
    const result = await reverifyDue({
      ...file,
      now: NOW,
      fetcher: async () => ({
        status: 200,
        body: "Paper deadline: September 21, 2026 23:59 UTC",
      }),
    });
    const id = stableDeadlineId(
      conference,
      conference.editions[0]!,
      conference.editions[0]!.deadlines[0]!,
    );
    expect(result).toMatchObject({ processed: 1, due: 1, updated: 1, changed: 1 });
    expect(result.ledger[id]).toMatchObject({
      status: "changed",
      observed_value: "2026-09-21T23:59:00.000Z",
    });
    expect(result.resolutions).toContainEqual(
      expect.objectContaining({
        deadline_id: id,
        status: "changed",
        old_value: "2026-09-20T23:59:00.000Z",
        new_value: "2026-09-21T23:59:00.000Z",
        raw_excerpt: "Paper deadline: September 21, 2026 23:59 UTC",
      }),
    );
    expect(
      JSON.parse(readFileSync(file.dataPath, "utf8")).conferences[0].editions[0].deadlines[0].utc,
    ).toBe("2026-09-20T23:59:00Z");
    expect(
      readFileSync(join(file.evidenceDir, `${result.ledger[id]!.content_hash}.body`), "utf8"),
    ).toContain("September 21");
    expect(result.ledger[id]!.body_ref).toBe(
      `evidence/blobs/${result.ledger[id]!.content_hash}.body`,
    );
  });

  it("marks an unchanged date-only deadline verified and reuses the content blob", async () => {
    const file = paths();
    const conference = fixtureConference();
    const deadline = conference.editions[0]!.deadlines[0]!;
    deadline.precision = "date-only";
    delete (deadline as { at_utc?: Date }).at_utc;
    deadline.local_date = "2026-09-20";
    delete (deadline as { tz_raw?: string }).tz_raw;
    writeData(file.dataPath, conference);
    const body = "Paper deadline: September 20, 2026 23:59 UTC";
    const first = await reverifyDue({
      ...file,
      now: NOW,
      fetcher: async () => ({ status: 200, body }),
    });
    const second = await reverifyDue({
      ...file,
      now: new Date("2026-09-01T00:00:00.000Z"),
      fetcher: async () => ({ status: 200, body }),
    });
    const id = stableDeadlineId(conference, conference.editions[0]!, deadline);
    expect(first.ledger[id]).toMatchObject({ status: "verified" });
    expect(second.processed).toBe(1);
    expect(first.ledger[id]!.content_hash).toBe(second.ledger[id]!.content_hash);
  });

  it("checks an initially pending deadline even when its cadence is in the future", async () => {
    const file = paths();
    const conference = fixtureConference();
    conference.editions[0]!.deadlines[0]!.verification!.next_check_at = "2026-09-07T00:00:00.000Z";
    writeData(file.dataPath, conference);
    const result = await reverifyDue({
      ...file,
      now: NOW,
      fetcher: async () => ({
        status: 200,
        body: "Paper deadline: September 20, 2026 23:59 UTC",
      }),
    });
    expect(result).toMatchObject({ processed: 1, due: 1, updated: 1 });
    const id = stableDeadlineId(
      conference,
      conference.editions[0]!,
      conference.editions[0]!.deadlines[0]!,
    );
    expect(result.ledger[id]!.status).toBe("verified");
  });

  it("separates unreachable sources and parser failures from changes", async () => {
    const file = paths();
    const conference = fixtureConference();
    conference.editions[0]!.deadlines.push({
      ...conference.editions[0]!.deadlines[0]!,
      label: "Notification",
      kind: "notification",
      verification: {
        ...conference.editions[0]!.deadlines[0]!.verification!,
        next_check_at: NOW.toISOString(),
      },
    });
    writeData(file.dataPath, conference);
    let calls = 0;
    const result = await reverifyDue({
      ...file,
      now: NOW,
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network down");
        return { status: 200, body: "The call for papers is open." };
      },
    });
    expect(result.statuses["source-unreachable"]).toBe(1);
    expect(result.statuses["parser-failed"]).toBe(1);
    expect(result.resolutions.map((item) => item.status).sort()).toEqual([
      "parser-failed",
      "source-unreachable",
    ]);
  });
});
