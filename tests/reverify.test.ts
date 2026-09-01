import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { capturePage } from "../src/capture.ts";
import {
  applyVerificationLedger,
  collectVerificationTargets,
  loadVerificationLedger,
  reverifyData,
  transitionVerificationResolution,
} from "../src/reverify.ts";
import { makeConference, makeDeadline, makeEdition } from "./helpers.ts";

function dataFile(
  dir: string,
  deadlines: Array<Record<string, unknown>> = [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      track: "",
      precision: "date-only",
      local_date: "2027-01-02",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ],
): string {
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
              deadlines,
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
    fetchImpl: async () =>
      new Response("Official deadline extension: Paper submission deadline: January 3, 2027"),
  });
  expect(second).toMatchObject({ processed: 1, statuses: { changed: 1 } });
  expect(second.ledger.resolutions).toHaveLength(1);
  expect(JSON.parse(readFileSync(ledgerPath, "utf8")).schema_version).toBe(2);
});

it("bootstraps fresh official evidence without fetching it again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-bootstrap-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      track: "",
      precision: "date-only",
      local_date: "2027-01-02",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        last_attempt_at: "2026-08-25T00:00:00.000Z",
        last_verified_at: "2026-08-25T00:00:00.000Z",
        next_check_at: "2026-09-02T00:00:00.000Z",
        content_hash: "a".repeat(64),
        status: "verified",
      },
    },
  ]);
  let fetches = 0;
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("fresh evidence should not be fetched");
    },
  });
  expect(fetches).toBe(0);
  expect(result).toMatchObject({ processed: 0, pages: 0, statuses: {} });
  expect(Object.values(result.ledger.deadlines)[0]).toMatchObject({
    status: "verified",
    content_hash: "a".repeat(64),
  });
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

it("fetches one page once and distributes its four slots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-page-"));
  const kinds = ["abstract", "paper", "notification", "camera_ready"];
  const labels = [
    "Abstract submission deadline",
    "Paper submission deadline",
    "Notification deadline",
    "Camera-ready deadline",
  ];
  const deadlines = kinds.map((kind, index) => ({
    kind,
    label: labels[index],
    round: 1,
    track: "",
    precision: "date-only",
    local_date: `2027-01-0${index + 2}`,
    verification: {
      official_url: "https://example.test/cfp",
      source_class: "official-cfp",
      next_check_at: "2026-08-30T00:00:00.000Z",
      status: "pending",
    },
  }));
  const dataPath = dataFile(dir, deadlines);
  let fetches = 0;
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => {
      fetches += 1;
      return new Response(
        [
          "Abstract submission deadline: January 2, 2027",
          "Paper submission deadline: January 3, 2027",
          "Notification deadline: January 4, 2027",
          "Camera-ready deadline: January 5, 2027",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    },
  });
  expect(fetches).toBe(1);
  expect(result).toMatchObject({ processed: 4, pages: 1, statuses: { verified: 4 } });
  expect(Object.keys(result.ledger.pages)).toHaveLength(1);
});

it("uses conditional headers and reuses the old body on 304", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-304-"));
  const dataPath = dataFile(dir);
  const ledgerPath = join(dir, "verification-ledger.json");
  const bodyRoot = join(dir, "evidence", "blobs");
  const first = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot,
    fetchImpl: async () =>
      new Response("Paper submission deadline: January 2, 2027", {
        headers: { etag: '"v1"', "last-modified": "Mon, 31 Aug 2026 00:00:00 GMT" },
      }),
  });
  const pageId = Object.keys(first.ledger.pages)[0]!;
  const oldFiles = readdirSync(bodyRoot);
  let requestHeaders = new Headers();
  const second = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-09-01T00:00:00.000Z"),
    due: false,
    bodyRoot,
    fetchImpl: async (_url, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    },
  });
  expect(requestHeaders.get("if-none-match")).toBe('"v1"');
  expect(requestHeaders.get("if-modified-since")).toBe("Mon, 31 Aug 2026 00:00:00 GMT");
  expect(second.statuses).toEqual({ verified: 1 });
  expect(second.ledger.pages[pageId]?.content_hash).toBe(first.ledger.pages[pageId]?.content_hash);
  expect(readdirSync(bodyRoot)).toEqual(oldFiles);
});

it("marks 429 as retryable and rejects oversized/private redirected pages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-limits-"));
  const result = await reverifyData({
    dataPath: dataFile(dir),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () =>
      new Response(null, { status: 429, headers: { "retry-after": "1209600" } }),
  });
  const page = Object.values(result.ledger.pages)[0]!;
  expect(result.statuses).toEqual({ retryable: 1 });
  expect(page.headers.retryAfter).toBe("1209600");
  expect(
    Date.parse(result.ledger.entries["demo|demo-2027|paper|1|"]!.next_check_at),
  ).toBeGreaterThanOrEqual(Date.parse("2026-09-14T00:00:00.000Z"));
  await expect(
    capturePage("https://example.test/cfp", {
      maxBodyBytes: 4,
      fetchImpl: async () => new Response("12345"),
    }),
  ).rejects.toMatchObject({ code: "body-too-large" });
  await expect(
    capturePage("https://example.test/cfp", {
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }),
    }),
  ).rejects.toMatchObject({ code: "unsafe-url" });
  await expect(
    capturePage("https://private.example/cfp", {
      dnsLookup: async () => [{ address: "10.0.0.1" }],
      fetchImpl: async () => new Response("unreachable"),
    }),
  ).rejects.toMatchObject({ code: "unsafe-url" });
  await expect(
    capturePage("https://[::1]/cfp", {
      fetchImpl: async () => new Response("unreachable"),
    }),
  ).rejects.toMatchObject({ code: "unsafe-url" });
});

it("routes pull-in and exact-to-date-only changes to manual resolution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-change-"));
  const exactData = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      track: "",
      precision: "exact",
      utc: "2027-01-05T23:59:00.000Z",
      tz_raw: "UTC",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const ledgerPath = join(dir, "verification-ledger.json");
  const result = await reverifyData({
    dataPath: exactData,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027 23:59 UTC"),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
  expect(result.ledger.resolutions[0]).toMatchObject({
    state: "open",
    status: "manual-required",
    change_kind: "pull-in",
  });
  const resolutionId = result.ledger.resolutions[0]!.resolution_id;
  expect(() => transitionVerificationResolution(ledgerPath, resolutionId, "applied")).toThrow(
    /needs accepted state/,
  );
  transitionVerificationResolution(ledgerPath, resolutionId, "accepted");
  expect(
    transitionVerificationResolution(ledgerPath, resolutionId, "applied").resolutions[0],
  ).toMatchObject({
    state: "applied",
  });

  const downgradeDir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-downgrade-"));
  const downgrade = await reverifyData({
    dataPath: dataFile(downgradeDir, [
      {
        kind: "paper",
        label: "Paper submission deadline",
        round: 1,
        track: "",
        precision: "exact",
        utc: "2027-01-02T23:59:00.000Z",
        tz_raw: "UTC",
        verification: {
          official_url: "https://example.test/cfp",
          source_class: "official-cfp",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]),
    ledgerPath: join(downgradeDir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => new Response("Paper submission deadline: January 3, 2027"),
  });
  expect(downgrade.statuses).toEqual({ "manual-required": 1 });
  expect(downgrade.ledger.resolutions[0]?.change_kind).toBe("precision-downgrade");
});

it("migrates V1 entries and fails loudly on malformed entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-ledger-"));
  const path = join(dir, "ledger.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: {
        legacy: {
          official_url: "https://example.test/cfp",
          venue_key: "demo",
          edition_id: "demo-2027",
          kind: "paper",
          round: 1,
          track: "",
          last_attempt_at: "2026-08-31T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-01T00:00:00.000Z",
          content_hash: null,
          status: "pending",
        },
      },
      resolutions: [],
    }),
  );
  const migrated = loadVerificationLedger(path);
  expect(migrated.schema_version).toBe(2);
  expect(Object.keys(migrated.pages)).toHaveLength(1);
  expect(migrated.deadlines.legacy?.page_id).toBe(Object.keys(migrated.pages)[0]);

  const invalid = join(dir, "invalid.json");
  writeFileSync(
    invalid,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: {
        bad: { official_url: "https://example.test/cfp", next_check_at: "not-a-date" },
      },
      resolutions: [],
    }),
  );
  expect(() => loadVerificationLedger(invalid)).toThrow(
    /invalid verification ledger entry:\nbad: next_check_at is invalid/,
  );
});

it("moves legacy venue and edition identifiers to the canonical ledger slot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-legacy-ids-"));
  const dataPath = join(dir, "data.json");
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(
    dataPath,
    JSON.stringify({
      conferences: [
        {
          key: "canonical",
          legacy_keys: ["legacy"],
          editions: [
            {
              year: 2027,
              id: "canonical-edition",
              legacy_ids: ["legacy-edition"],
              call_identity: { editionId: "canonical-edition", callId: "canonical-2027" },
              deadlines: [
                {
                  kind: "paper",
                  label: "Paper submission deadline",
                  round: 1,
                  precision: "date-only",
                  local_date: "2027-01-02",
                  verification: {
                    official_url: "https://example.test/cfp",
                    source_class: "official-cfp",
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
  const legacyId = "legacy|legacy-edition|paper|1|";
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: {
        [legacyId]: {
          official_url: "https://example.test/cfp",
          venue_key: "legacy",
          edition_id: "legacy-edition",
          kind: "paper",
          round: 1,
          track: "",
          label: "Paper submission deadline",
          last_attempt_at: "2026-08-30T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-08-30T00:00:00.000Z",
          content_hash: null,
          status: "pending",
        },
      },
      resolutions: [],
    }),
  );
  const result = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027"),
  });
  const canonicalId = "canonical|canonical-edition|paper|1|";
  expect(result.ledger.aliases[legacyId]).toBe(canonicalId);
  expect(result.ledger.deadlines[canonicalId]).toBeDefined();
  expect(result.ledger.deadlines[legacyId]).toBeUndefined();
});

it("uses the shared date-only uncertainty boundary for target scheduling", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-date-only-"));
  const dataPath = dataFile(dir);
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const ledger = loadVerificationLedger(join(dir, "missing-ledger.json"));
  const beforeLatest = collectVerificationTargets(
    data,
    ledger,
    new Date("2027-01-03T11:59:59.998Z"),
  );
  const afterLatest = collectVerificationTargets(
    data,
    ledger,
    new Date("2027-01-03T12:00:00.000Z"),
  );
  expect(beforeLatest).toHaveLength(1);
  expect(afterLatest).toHaveLength(0);
});
