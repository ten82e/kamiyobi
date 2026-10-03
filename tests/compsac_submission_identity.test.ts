import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import {
  assignShareIdentities,
  COMPSAC_JIP_CALL,
  consolidateReviewedSubmissions,
  reviewedSubmission,
} from "../site/submission-identity.ts";
import { icsEventRows, recordsOf, toJson } from "../src/build.ts";
import { applyOverrides } from "../src/merge.ts";
import { parseFile } from "../src/sources/local.ts";
import { REPO_ROOT } from "./helpers.ts";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

const now = new Date("2026-10-03T06:00:00Z");
const source = applyOverrides(
  parseFile(join(REPO_ROOT, "data/manual.yaml")),
  loadYaml(readFileSync(join(REPO_ROOT, "data/overrides.yaml"), "utf8")) as Record<string, unknown>,
).filter((c) => ["jip", "ipsj-27-r-compsac"].includes(c.key));
const key = (r: ReturnType<typeof Recommender.candidateRows>[number]) =>
  `${r.conf.key}|${r.ed.year}|${r.kind}|${Math.trunc(r.t)}`;
const raw = Recommender.candidateRows(toJson(source, {}, now));
const relevant = raw.filter((r) => r.localDate === "2026-12-01");

it("同じ公式募集を1件にし、両方の元ID・年度とdate-onlyの締切を保持する", () => {
  expect(relevant).toHaveLength(2);
  const before = JSON.stringify(raw);
  const shown = consolidateReviewedSubmissions(raw, key);
  expect(shown).toHaveLength(raw.length - 1);
  const group = shown.find((r) => r.submission);
  expect(group).toMatchObject({
    conf: { key: "jip" },
    ed: { year: 2027, event_start: "", event_end: "", date_text: COMPSAC_JIP_CALL.issueLabel },
    dateOnly: true,
    localDate: "2026-12-01",
  });
  expect(group?.conf.tags).toContain("special-issue");
  expect(group?.dl).toBe(relevant.find((r) => r.conf.key === "jip")?.dl);
  expect(group?.submission?.shareAliases.sort()).toEqual(relevant.map(key).sort());
  expect(group?.submission?.sourceRecords).toEqual(
    expect.arrayContaining([
      { venueKey: "jip", editionId: "jip-compsac2027-si", year: 2027 },
      { venueKey: "ipsj-27-r-compsac", editionId: "ipsj-27-r26", year: 2026 },
    ]),
  );
  expect(JSON.stringify(raw)).toBe(before);
  expect(
    consolidateReviewedSubmissions([...raw].reverse(), key).find((r) => r.submission)?.conf.key,
  ).toBe("jip");
});

it("日本語名・旧名称・英語名・投稿年・掲載年の検索から同じ1件に到達する", () => {
  const shown = consolidateReviewedSubmissions(relevant, key);
  for (const query of [
    "情報処理学会",
    "IPSJ",
    "JIP",
    "Applications and the Internet",
    "COMPSAC 2026",
    "JIP 2027",
    "12月1日",
    "ipsj-27-r-compsac",
    "英語論文",
  ])
    expect(
      shown.filter((r) => Recommender.searchMatcher(query)(r.hay)),
      query,
    ).toHaveLength(1);
});

it("画面CSVは投稿締切1件と掲載予定を出し、月全体を開催期間にしない", () => {
  const shown = consolidateReviewedSubmissions(relevant, key);
  expect(Recommender.eventCellJa(shown[0])).toBe(COMPSAC_JIP_CALL.issueLabel);
  const csv = Recommender.deadlinesToCsv(
    shown.map((r) => ({ ...r })),
    now.getTime(),
  );
  expect(csv.trim().split("\n")).toHaveLength(2);
  expect(csv).toContain("2026-12-01");
  expect(csv).toContain("時刻未確認");
  expect(csv).toContain(COMPSAC_JIP_CALL.issueLabel);
  expect(csv).not.toMatch(/2027-09-(?:01|30)/);
});

it.each([
  { kind: "abstract" },
  { round: 2 },
  { track: "workshop" },
  { precision: "exact" },
  { localDate: "2026-12-02" },
  { officialUrl: "https://www.ipsj.or.jp/journal/cfp/other.html" },
  { editionId: "jip-other-si" },
  { venueKey: "other" },
])("異なる募集条件 %j は統合しない", (change) => {
  expect(
    reviewedSubmission({
      venueKey: "jip",
      editionId: "jip-compsac2027-si",
      editionYear: 2027,
      label: "投稿締切",
      officialUrl: COMPSAC_JIP_CALL.officialUrl,
      kind: "paper",
      round: 1,
      precision: "date-only",
      localDate: "2026-12-01",
      ...change,
    }),
  ).toBeNull();
});

it("片方の記録しかない場合も募集を失わず、元の共有キーを受け入れる", () => {
  for (const row of relevant) {
    const shown = consolidateReviewedSubmissions([row], key);
    expect(shown).toHaveLength(1);
    expect(shown[0].submission?.shareAliases).toEqual([key(row)]);
    expect(shown[0].dl).toBe(row.dl);
  }
});

it("実際のUI行生成に統合が接続され、アーカイブJSONの元記録は残る", () => {
  const buildRows = new Function(
    "Recommender",
    "consolidateReviewedSubmissions",
    "assignShareIdentities",
    "rowShareKeyJa",
    `return (${jsFunction(siteRuntime(), "buildRows")});`,
  )(Recommender, consolidateReviewedSubmissions, assignShareIdentities, key);
  expect(
    buildRows(toJson(source, {}, now)).filter((r: { submission?: unknown }) => r.submission),
  ).toHaveLength(1);
  expect(
    (
      toJson(source, {}, now).conferences as Array<{
        key: string;
        editions: Array<{ id: string; year: number }>;
      }>
    ).find((c) => c.key === "ipsj-27-r-compsac")?.editions[0],
  ).toMatchObject({ id: "ipsj-27-r26", year: 2026 });
});

it("ICSは既存JIP UIDの終日締切1件を出し、別種別と原記録は失わない", () => {
  const records = recordsOf(source);
  const before = JSON.stringify(records);
  const canonical = records.filter((r) => r.conf.key === "jip");
  const originalUid = icsEventRows(canonical, now)
    .find((r) => r.body.join("\n").includes("jip-compsac2027-si"))
    ?.body.find((line) => line.startsWith("UID:"));
  const merged = icsEventRows(records, now).filter((r) =>
    r.body.join("\n").includes(COMPSAC_JIP_CALL.officialUrl),
  );
  expect(merged).toHaveLength(1);
  expect(merged[0].body).toContain(originalUid);
  expect(merged[0].body).toContain("DTSTART;VALUE=DATE:20261201");
  expect(merged[0].body.join("\n")).toContain("2027年9月号");
  expect(merged[0].body.join("\n")).toContain("英語論文のみ");
  expect(merged[0].body.join("\n")).not.toContain("2027-09-01");
  expect(JSON.stringify(records)).toBe(before);
  const aliasOnly = records.filter((r) => r.conf.key === "ipsj-27-r-compsac");
  expect(icsEventRows(aliasOnly, now)).toHaveLength(1);
});

it("公式CFP根拠の改変を検知し、掲載月・投稿日・英語限定を照合する", () => {
  const body = readFileSync(join(REPO_ROOT, COMPSAC_JIP_CALL.evidenceRef));
  expect(createHash("sha256").update(body).digest("hex")).toBe(
    "9972268f811c33df5e345fc94570018d6ea5ec55be146ca81b95744b7fd4f3bd",
  );
  const text = body.toString().replace(/<[^>]*>/g, "");
  expect(text).toContain("2026年12月1日");
  expect(text).toContain("2027年9月号");
  expect(text).toContain("英語論文のみ");
});
