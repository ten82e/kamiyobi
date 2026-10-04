import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { applyOverrides } from "../src/merge.ts";
import { parseFile } from "../src/sources/local.ts";
import { makeConference, makeDeadline, makeEdition, REPO_ROOT } from "./helpers.ts";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

const deadline = { kind: "paper", utc: "2026-11-27T23:59:00Z" };
function rows(key: string, title: string, link = "") {
  return Recommender.candidateRows({
    conferences: [{ key, title, link, editions: [{ year: 2027, deadlines: [deadline] }] }],
  });
}
function matches(query: string, source: ReturnType<typeof rows>) {
  return source.filter((row) => Recommender.searchMatcher(query)(row.hay));
}

it("日本語の学会名と略称で、英語名称の特集号と日本語名称の研究会に到達できる", () => {
  for (const [key, title, japanese, acronym] of [
    ["ipsj-27-m-security", "IPSJ 論文誌 特集号", "情報処理学会", "IPSJ"],
    ["ipsj-sigsec", "情報処理学会 CSEC 研究会", "情報処理学会", "IPSJ"],
    ["ieice-cpsy", "電子情報通信学会 CPSY 研究会", "電子情報通信学会", "IEICE"],
  ]) {
    const source = rows(key, title);
    expect(matches(japanese, source)).toEqual(source);
    expect(matches(acronym, source)).toEqual(source);
  }
  expect(
    matches("情報処理学会", rows("jip", "JIP", "https://www.ipsj.or.jp/journal/cfp/")),
  ).toHaveLength(1);
});

it("他団体・学会名の部分文字列・紛らわしいドメインに所属を追加しない", () => {
  for (const source of [
    rows("ipsj-wiss", "WISS", "https://www.wiss.org/"),
    rows("other", "XIPSJX"),
    rows("other", "Unrelated", "https://ipsj.or.jp.example.com/"),
  ])
    expect(matches("情報処理学会", source)).toHaveLength(0);
});

it("旧略称 NIPS で同じ開催年の NeurIPS 締切に到達できる", () => {
  const source = rows("neurips", "NeurIPS");
  expect(matches("NIPS 2027", source)).toEqual(matches("NeurIPS 2027", source));
  expect(matches("NIPS 2027", source)).toHaveLength(1);
  expect(matches("NIPS 2026年の締切", source)).toEqual(source);
  expect(matches("NIPS 2028", source)).toHaveLength(0);
});

it("一覧の期間外に確認済み締切がある回を、締切未定と案内しない", () => {
  const source = {
    conferences: [
      {
        key: "neurips",
        title: "NeurIPS",
        editions: [
          { year: 2026, event_start: "2026-12-06", deadlines: [], schedule_deadlines: [deadline] },
          { year: 2027, event_start: "2027-12-06", deadlines: [] },
        ],
      },
    ],
  };
  expect(Recommender.scheduleOnlyEditions(source).map((m) => m.eventStart)).toEqual(["2027-12-06"]);
});

it("推定非表示の ICML 年度検索で、語の変更が必要だと誤案内しない", () => {
  const hint = deadlineHintFunction()({
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    est: false,
    hiddenKindWords: [],
    hidden: { past: 213, est: 67 },
    query: "ICML 2027",
    urlQuery: false,
    queryMatch: { catalog: 3, journal: 0 },
    catalogConferences: 12,
    termCounts: [
      { term: "icml", count: 3 },
      { term: "2027", count: 548 },
    ],
  });
  expect(hint).toContain("推定締切を含める");
  expect(hint).toContain("収録済み");
  expect(hint).not.toContain("語をすべて含む行はありません");
  expect(hint).not.toContain("いずれかの語を外すと増えます");
});

it("SecureComm の古い exact 値を公式の2回の暦日に訂正し、時刻を作らない", () => {
  const overrides = loadYaml(
    readFileSync(join(REPO_ROOT, "data/overrides.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const input = [
    makeConference({
      key: "securecomm",
      title: "SecureComm",
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "securecomm27",
          deadlines: [
            makeDeadline(
              "paper",
              "Full Paper Submission",
              new Date("2027-03-01T23:59:00Z"),
              "UTC",
              1,
            ),
            makeDeadline(
              "paper",
              "Full Paper Submission",
              new Date("2027-04-16T11:59:59Z"),
              "AoE",
              2,
            ),
          ],
        }),
      ],
    }),
  ];
  const actual = applyOverrides(input, overrides)[0].editions[0].deadlines;
  expect(actual).toHaveLength(2);
  expect(actual.map((d) => [d.round, d.precision, "local_date" in d ? d.local_date : ""])).toEqual([
    [1, "date-only", "2027-02-01"],
    [2, "date-only", "2027-04-15"],
  ]);
  for (const d of actual) {
    expect(d).not.toHaveProperty("at_utc");
    expect(d).not.toHaveProperty("utc");
    const evidence = d.evidence?.find(
      (e) => e.source_url === "https://securecomm.eai-conferences.org/2027/",
    );
    expect(evidence?.verifiedFields).toEqual(["date", "kind", "round"]);
    const body = readFileSync(join(REPO_ROOT, String(evidence?.evidenceRef)));
    expect(createHash("sha256").update(body).digest("hex")).toBe(evidence?.contentHash);
    expect(body.toString()).toContain("February");
    expect(body.toString()).toContain("April");
  }
});

it("IPSJ の日付だけの募集を翌日の JST に変換せず、JIP の同じ募集にも適用する", () => {
  const overrides = loadYaml(
    readFileSync(join(REPO_ROOT, "data/overrides.yaml"), "utf8"),
  ) as Record<string, unknown>;
  const corrected = applyOverrides(parseFile(join(REPO_ROOT, "data/manual.yaml")), overrides);
  for (const [key, edition, date] of [
    ["ipsj-27-m-security", "ipsj-27-m26", "2026-11-27"],
    ["ipsj-27-p-ubiquitous", "ipsj-27-p26", "2026-12-04"],
    ["ipsj-27-r-compsac", "ipsj-27-r26", "2026-12-01"],
    ["jip", "jip-compsac2027-si", "2026-12-01"],
  ]) {
    const d = corrected.find((c) => c.key === key)?.editions.find((e) => e.edition_id === edition)
      ?.deadlines[0];
    expect(d).toMatchObject({ precision: "date-only", local_date: date });
    expect(d).not.toHaveProperty("at_utc");
    const ev = d?.evidence?.find((e) => e.sourceClass === "official-cfp");
    expect(ev?.verifiedFields).toEqual(["date", "kind"]);
    expect(
      createHash("sha256")
        .update(readFileSync(join(REPO_ROOT, String(ev?.evidenceRef))))
        .digest("hex"),
    ).toBe(ev?.contentHash);
  }
});

it("同じ会議の重なる会期で、別出典の空の回を締切未定と案内しない", () => {
  const data = {
    conferences: [
      {
        key: "neurips",
        title: "NeurIPS",
        editions: [
          {
            year: 2026,
            event_start: "2026-12-06",
            event_end: "2026-12-12",
            deadlines: [],
            schedule_deadlines: [deadline],
          },
          { year: 2026, event_start: "2026-12-08", event_end: "2026-12-13", deadlines: [] },
          { year: 2027, event_start: "2027-12-06", event_end: "2027-12-12", deadlines: [] },
        ],
      },
    ],
  };
  const matches = new Function(
    "DATA",
    "searchQuery",
    "Recommender",
    "windowLimitMs",
    `return (${jsFunction(siteRuntime(), "scheduleOnlyMatches")});`,
  )(data, "NeurIPS", Recommender, () => Number.POSITIVE_INFINITY) as (
    filter: object,
  ) => Array<{ eventStart: string }>;
  expect(
    matches({ window: "all", cats: [], domestic: false, online: false }).map((m) => m.eventStart),
  ).toEqual(["2027-12-06"]);
});
