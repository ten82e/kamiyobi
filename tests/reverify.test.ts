import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyVerificationLedger, reverifyData } from "../src/reverify.ts";
import { makeConference, makeDeadline, makeEdition } from "./helpers.ts";

function dataFile(dir: string): string {
  const path = join(dir, "data.json");
  writeFileSync(
    path,
    JSON.stringify({
      conferences: [
        {
          key: "demo",
          title: "Demo",
          link: "https://example.test/cfp",
          editions: [
            {
              year: 2027,
              id: "demo-2027",
              link: "https://example.test/cfp",
              deadlines: [
                {
                  kind: "paper",
                  label: "Paper submission deadline",
                  round: 1,
                  track: "",
                  precision: "date-only",
                  local_date: "2027-01-02",
                  verification: {
                    official_url: "https://example.test/cfp",
                    next_check_at: "2026-08-30T00:00:00.000Z",
                    status: "pending",
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  return path;
}

it("persists due verification, stores the body, and records a changed deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-"));
  const dataPath = dataFile(dir);
  const ledgerPath = join(dir, "verification-ledger.json");
  const firstBody = "Paper submission deadline: January 2, 2027";
  const first = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response(firstBody),
  });
  const firstHash = createHash("sha256").update(firstBody).digest("hex");
  expect(first).toMatchObject({ processed: 1, statuses: { verified: 1 } });
  expect(first.ledger.entries["demo|demo-2027|paper|1|"]).toMatchObject({
    status: "verified",
    content_hash: firstHash,
    body_ref: `evidence/blobs/${firstHash}.body`,
  });
  expect(existsSync(join(dir, "evidence", "blobs", `${firstHash}.body`))).toBe(true);
  const applied = applyVerificationLedger(
    [
      makeConference({
        key: "demo",
        title: "Demo",
        editions: [
          makeEdition({
            year: 2027,
            edition_id: "demo-2027",
            deadlines: [
              makeDeadline(
                "paper",
                "Paper submission deadline",
                new Date("2027-01-02T00:00:00.000Z"),
              ),
            ],
          }),
        ],
      }),
    ],
    first.ledger,
  );
  expect(applied[0]?.editions[0]?.deadlines[0]?.verification).toMatchObject({
    status: "verified",
    content_hash: firstHash,
  });

  const second = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-09-08T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("Paper submission deadline: January 3, 2027"),
  });
  expect(second).toMatchObject({ processed: 1, statuses: { changed: 1 } });
  expect(second.ledger.resolutions).toHaveLength(1);
  expect(JSON.parse(readFileSync(ledgerPath, "utf8")).schema_version).toBe(1);
});

it("records an unreachable source without overwriting the last verified value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-unreachable-"));
  const dataPath = dataFile(dir);
  const ledgerPath = join(dir, "verification-ledger.json");
  await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027"),
  });
  const result = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-09-08T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  expect(result.statuses).toEqual({ "source-unreachable": 1 });
  expect(result.ledger.entries["demo|demo-2027|paper|1|"]?.last_verified_at).toBe(
    "2026-08-31T00:00:00.000Z",
  );
});
