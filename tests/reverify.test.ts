import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { generateCurated } from "../scripts/generate-curated.ts";
import { assertSafePageUrl, capturePage, pinnedLookup, writeCasBody } from "../src/capture.ts";
import { applyResolutionSource } from "../src/cli.ts";
import { classifyDeadlineChange } from "../src/model.ts";
import { writePromotionBatch } from "../src/promotion.ts";
import {
  applyVerificationLedger,
  assertResolutionCanApply,
  collectVerificationTargets,
  deadlineId,
  loadVerificationLedger,
  pageIdForUrl,
  reverifyData,
  transitionVerificationResolution,
} from "../src/reverify.ts";
import { deadlinesOf } from "../src/sources/local.ts";
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

it("keeps the ledger loadable when non-auto sources are routed to manual review", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-manual-page-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      track: "",
      precision: "date-only",
      local_date: "2027-01-02",
      evidence: [{ sourceClass: "aggregator", sourceUrl: "https://example.test/list" }],
      verification: {
        official_url: "https://example.test/list",
        source_class: "aggregator",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const ledgerPath = join(dir, "verification-ledger.json");
  let fetched = 0;
  const result = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => {
      fetched += 1;
      return new Response("unused");
    },
  });
  expect(fetched).toBe(0);
  expect(result.statuses).toEqual({ "manual-required": 1 });
  // run が書いた台帳は、後続サブコマンドがそのまま読み戻せなければならない。
  const reloaded = loadVerificationLedger(ledgerPath);
  const entry = reloaded.deadlines["demo|demo-2027|paper|1|"];
  expect(entry?.status).toBe("manual-required");
  expect(entry?.page_id ? reloaded.pages[entry.page_id] : undefined).toBeTruthy();
});

it("keeps the ledger loadable when a non-auto source moves to a different URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-manual-move-"));
  const ledgerPath = join(dir, "verification-ledger.json");
  const deadlineFor = (url: string): Array<Record<string, unknown>> => [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      track: "",
      precision: "date-only",
      local_date: "2027-06-02",
      evidence: [{ sourceClass: "aggregator", sourceUrl: url }],
      verification: {
        official_url: url,
        source_class: "aggregator",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ];
  const dataPath = dataFile(dir, deadlineFor("https://aggregator-a.test/list"));
  await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("unused"),
  });
  // 同じ締切の集約元 URL が翌晩に変わっても、台帳は読み戻せなければならない。
  writeFileSync(
    dataPath,
    readFileSync(dataPath, "utf8").replaceAll(
      "https://aggregator-a.test/list",
      "https://aggregator-b.test/list",
    ),
  );
  const moved = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-09-30T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("unused"),
  });
  expect(moved.statuses).toEqual({ "manual-required": 1 });
  const reloaded = loadVerificationLedger(ledgerPath);
  const entry = reloaded.deadlines["demo|demo-2027|paper|1|"];
  expect(entry?.official_url).toBe("https://aggregator-b.test/list");
  const page = entry?.page_id ? reloaded.pages[entry.page_id] : undefined;
  expect(page?.requested_url).toBe("https://aggregator-b.test/list");
});

it("preserves a captured page when its deadline later degrades to a non-auto source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-manual-preserve-"));
  const ledgerPath = join(dir, "verification-ledger.json");
  const dataPath = dataFile(dir);
  const body = "Paper submission deadline: January 2, 2027";
  const first = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response(body),
  });
  expect(first.statuses).toEqual({ verified: 1 });
  const capturedHash = createHash("sha256").update(body).digest("hex");
  // 同一 URL のまま source_class だけ非 auto に落ちても、取得済み page を消さない。
  writeFileSync(
    dataPath,
    readFileSync(dataPath, "utf8").replaceAll('"official-cfp"', '"aggregator"'),
  );
  const degraded = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-09-30T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("unused"),
  });
  expect(degraded.statuses).toEqual({ "manual-required": 1 });
  const reloaded = loadVerificationLedger(ledgerPath);
  const entry = reloaded.deadlines["demo|demo-2027|paper|1|"];
  const page = entry?.page_id ? reloaded.pages[entry.page_id] : undefined;
  expect(page?.content_hash).toBe(capturedHash);
});

it("verifies both rounds of a multi-round venue from one official page", async () => {
  // 抽出候補は round/track を持たないため、既定値での不一致棄却は多ラウンド会場の
  // 照合を全滅させていた (#701)。値一致+兄弟スロットでの説明可能性で確認する。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-multiround-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Full paper submissions due (spring)",
      round: 1,
      track: "spring",
      precision: "exact",
      utc: "2027-04-24T03:59:00Z",
      tz_raw: "EDT",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
    {
      kind: "paper",
      label: "Full paper submissions due (fall)",
      round: 2,
      track: "fall",
      precision: "exact",
      utc: "2027-09-18T03:59:00Z",
      tz_raw: "EDT",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const ledgerPath = join(dir, "verification-ledger.json");
  const body =
    "Full paper submissions due: Thursday, April 23, 2027, 11:59 pm EDT\n" +
    "Full paper submissions due: Friday, September 17, 2027, 11:59 pm EDT\n";
  const result = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response(body),
  });
  expect(result.statuses).toEqual({ verified: 2 });
  expect(result.ledger.resolutions).toHaveLength(0);
});

it("confirms an exact deadline against a date-only official statement", async () => {
  // 原典に時刻表記が無い締切 (通知・camera-ready 等) は、保存 exact 値の公式 TZ での
  // 暦日一致で確認する (#701)。時刻の推測はしない。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-dateonly-"));
  const dataPath = dataFile(dir, [
    {
      kind: "notification",
      label: "Notification to authors",
      round: 1,
      track: "",
      precision: "exact",
      utc: "2026-12-08T23:59:59Z",
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
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("Notification to authors: Tuesday, December 8, 2026\n"),
  });
  expect(result.statuses).toEqual({ verified: 1 });
});

it("refuses to verify when an unexplained sibling candidate remains", async () => {
  // 保存値と一致する候補があっても、兄弟スロットで説明できない互換候補 (延長の
  // 新値かもしれない) が残る場合は verified にしない (#701 の安全側)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-unexplained-"));
  const dataPath = dataFile(dir);
  const ledgerPath = join(dir, "verification-ledger.json");
  const result = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Paper submission deadline: January 2, 2027\nPaper submission deadline: January 9, 2027\n",
      ),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
});

it("refuses to verify when a same-label candidate shows a different (earlier) date", async () => {
  // ラベル署名が完全一致で値が異なる候補 = 同一スロットの訂正の強い兆候。
  // 前倒し訂正の併記で旧値が verified になる誤りを防ぐ (#701 レビュー R1/R3)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-samelabel-"));
  const dataPath = dataFile(dir);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Paper submission deadline: January 2, 2027\nPaper submission deadline: December 20, 2026\n",
      ),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
});

it("refuses to verify when a change-marked candidate line shows a different date", async () => {
  // 'Extended deadline:' 等の変更語彙つき行はラベル署名が変形して互換候補から
  // 落ちるため、候補行スコープの変更語彙ガードで拒否する (#701 レビュー R6)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-marked-"));
  const dataPath = dataFile(dir);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Paper submission deadline: January 2, 2027\nUpdated deadline: December 20, 2026\n",
      ),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
});

it("refuses to verify sibling rounds whose stored order contradicts round order", async () => {
  // 同 kind の round 順序と保存値の時系列が食い違う (取り違えの疑い) 場合、
  // 値照合が相互に誤りを追認しないよう verified を拒否する (#701 レビュー R2)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-roundswap-"));
  const verification = {
    official_url: "https://example.test/cfp",
    source_class: "official-cfp",
    next_check_at: "2026-08-30T00:00:00.000Z",
    status: "pending",
  };
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Full paper submissions due (spring)",
      round: 1,
      track: "spring",
      precision: "exact",
      utc: "2027-09-18T03:59:00Z",
      tz_raw: "EDT",
      verification: { ...verification },
    },
    {
      kind: "paper",
      label: "Full paper submissions due (fall)",
      round: 2,
      track: "fall",
      precision: "exact",
      utc: "2027-04-24T03:59:00Z",
      tz_raw: "EDT",
      verification: { ...verification },
    },
  ]);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Full paper submissions due: Thursday, April 23, 2027, 11:59 pm EDT\n" +
          "Full paper submissions due: Friday, September 17, 2027, 11:59 pm EDT\n",
      ),
  });
  expect(result.statuses).toEqual({ "manual-required": 2 });
});

it("does not confirm a date-only statement against an unconfirmed timezone", async () => {
  // TZ 未確認の exact 値を UTC 暦日で照合すると誤 verified になる (#701 レビュー R5)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-unknowntz-"));
  const dataPath = dataFile(dir, [
    {
      kind: "notification",
      label: "Notification to authors",
      round: 1,
      track: "",
      precision: "exact",
      utc: "2026-12-08T23:59:59Z",
      tz_raw: "Narnia Standard Time",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("Notification to authors: Tuesday, December 8, 2026\n"),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
});

it("verifies when the same value appears in multiple page mentions", async () => {
  // CFP は Key dates 節と本文で同じ締切を二重掲載するのが一般形 (実例: genai4sg の
  // EasyChair メタデータ表 + 本文)。同一値の重複は裏付けの強化であって曖昧ではない —
  // 候補の「件数」でなく「異なり値の数」で一意性を判定する (#714)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-dupmention-"));
  const dataPath = dataFile(dir);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Submission deadline January 2, 2027\n" +
          "Tentative paper submission deadline: January 2, 2027\n",
      ),
  });
  expect(result.statuses).toEqual({ verified: 1 });
});

function publisherDeadline(): Array<Record<string, unknown>> {
  return [
    {
      kind: "paper",
      label: "Manuscript submission deadline (extended)",
      round: 1,
      track: "",
      precision: "date-only",
      local_date: "2026-09-15",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "publisher",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ];
}

async function reverifyPublisherBody(dir: string, body: string) {
  return reverifyData({
    dataPath: dataFile(dir, publisherDeadline()),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response(body),
  });
}

it("verifies a label whose signature carries a day-first date", async () => {
  // 実例: IEEE ComSoc 特集号 CFP (#716)。labelSignature が国際式日付
  // (15 September 2026) を除去できず、候補ラベルの署名に日付が残って
  // 保存ラベルとの包含照合が壊れていた。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-dayfirst-"));
  const result = await reverifyPublisherBody(
    dir,
    "Manuscript Submission Deadline: 15 September 2026 (Extended Deadline)\n" +
      "Final Manuscript Due: 1 March 2027\n",
  );
  expect(result.statuses).toEqual({ verified: 1 });
});

it("does not treat a revised-manuscript stage as a change announcement", async () => {
  // 実例: IEEE WCM 特集号 CFP (#716)。「Revised Manuscript Due」(改訂稿提出の
  // 編集段階) が CHANGE_LANGUAGE の revised に誤ヒットし、値一致候補の verified を
  // 阻止していた。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-revstage-"));
  const result = await reverifyPublisherBody(
    dir,
    "Manuscript Submission Deadline: 15 September 2026 (Extended Deadline)\n" +
      "Revised Manuscript Due: 1 December 2026\n" +
      "Final Manuscript Due: 1 March 2027\n",
  );
  expect(result.statuses).toEqual({ verified: 1 });
});

it("still refuses a genuine revised-deadline announcement with a different date", async () => {
  // 中和は 'revised manuscript' に限る保証 — 「Revised paper submission deadline:
  // 新日付」型の真の変更告知は引き続きガード(2)で manual に落とす
  // (中和を revised paper/version へ広げると素通りする。#716 反証レビューで実証)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-reviseddl-"));
  const result = await reverifyPublisherBody(
    dir,
    "Manuscript Submission Deadline: 15 September 2026\n" +
      "Revised paper submission deadline: 20 September 2026\n",
  );
  expect(result.statuses).toEqual({ "manual-required": 1 });
});

it("keeps ambiguous multi-candidate slots free of proposed observed values", async () => {
  // 複数互換で一意照合できないときも特定候補の値を提案しない (#701 レビュー R4)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-ambnoval-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 2,
      track: "",
      precision: "date-only",
      local_date: "2027-06-02",
      verification: {
        official_url: "https://example.test/cfp",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Paper submission deadline: June 11, 2027\nPaper submission deadline: July 9, 2027\n",
      ),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
  const entry = result.ledger.deadlines["demo|demo-2027|paper|2|"];
  expect(entry?.observed_value ?? "").toBe("");
  for (const resolution of result.ledger.resolutions) {
    expect(resolution.current_value ?? "").not.toContain("2027-06-11");
  }
});

it("ignores earlier untracked-cycle dates but blocks later unexplained ones", async () => {
  // 保存値より前の未説明候補 (追跡外サイクル) は verified を妨げない一方、
  // 後ろ向きの未説明候補 (延長の可能性) はブロックする (M4 変異の検出)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-backfilter-"));
  const verification = {
    official_url: "https://example.test/cfp",
    source_class: "official-cfp",
    next_check_at: "2026-08-30T00:00:00.000Z",
    status: "pending",
  };
  const fall = {
    kind: "notification",
    label: "Notification to authors (fall)",
    round: 2,
    track: "fall",
    precision: "exact",
    utc: "2026-12-08T23:59:59Z",
    tz_raw: "UTC",
    verification: { ...verification },
  };
  const dataPath = dataFile(dir, [fall]);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    // 追跡外 spring サイクルの 7/23 が先に載っていても fall の 12/8 は verified
    fetchImpl: async () =>
      new Response(
        "Notification to authors: Thursday, July 23, 2026\n" +
          "Notification to authors: Tuesday, December 8, 2026\n",
      ),
  });
  expect(result.statuses).toEqual({ verified: 1 });
});

it("classifies final-paper-files lines as camera-ready and strips US from label signatures", async () => {
  // M9 ('us' 除去) と M10 (camera_ready 分類) の変異検出。実 NSDI と同形の行。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-usenix-shape-"));
  const verification = {
    official_url: "https://example.test/cfp",
    source_class: "official-cfp",
    next_check_at: "2026-08-30T00:00:00.000Z",
    status: "pending",
  };
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Full paper submissions due (fall)",
      round: 2,
      track: "fall",
      precision: "exact",
      utc: "2026-09-18T03:59:00Z",
      tz_raw: "EDT",
      verification: { ...verification },
    },
    {
      kind: "camera_ready",
      label: "Final paper files due (fall)",
      round: 2,
      track: "fall",
      precision: "exact",
      utc: "2027-03-04T23:59:59Z",
      tz_raw: "UTC",
      verification: { ...verification },
    },
  ]);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () =>
      new Response(
        "Full paper submissions due: Thursday, September 17, 2026, 11:59 pm US EDT\n" +
          "Final paper files due: Thursday, March 4, 2027\n",
      ),
  });
  expect(result.statuses).toEqual({ verified: 2 });
});

it("does not record an unrelated candidate when no compatible deadline matches", async () => {
  // round/track 不一致でページ上の締切と照合できなかった場合、無関係な先頭候補を
  // observed_value として resolution に書かない (#701 の安全化)。
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-incompatible-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission (round 2)",
      round: 2,
      track: "fall",
      precision: "date-only",
      local_date: "2027-01-02",
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
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    // 抽出候補は round=1 の別トラック締切だけ (照合不能)
    fetchImpl: async () => new Response("Workshop deadline: February 9, 2027"),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
  const resolution = result.ledger.resolutions.find(
    (item) => item.deadline_id === "demo|demo-2027|paper|2|fall",
  );
  expect(resolution?.current_value ?? "").not.toContain("2027-02-09");
  expect(resolution?.raw_excerpt ?? "").not.toContain("February 9");
});

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

it("routes multiple compatible deadline values to manual review even when one is current", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-ambiguous-values-"));
  const dataPath = dataFile(dir);
  const ledgerPath = join(dir, "verification-ledger.json");
  const result = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () =>
      new Response(
        "<s>Paper submission deadline: January 2, 2027</s><p>Paper submission deadline: January 3, 2027</p>",
      ),
  });
  expect(result.statuses).toEqual({ "manual-required": 1 });
  expect(result.ledger.resolutions[0]).toMatchObject({
    status: "manual-required",
    change_kind: "ambiguous",
  });
  const unchanged = await reverifyData({
    dataPath,
    ledgerPath,
    now: new Date("2026-09-01T00:00:00.000Z"),
    due: false,
    fetchImpl: async () => new Response(null, { status: 304 }),
  });
  expect(unchanged.statuses).toEqual({ "manual-required": 1 });
});

it("matches changed HTML evidence by normalized deadline text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-html-evidence-"));
  const result = await reverifyData({
    dataPath: dataFile(dir, [
      {
        kind: "paper",
        label: "Paper submission deadline",
        round: 1,
        track: "",
        precision: "date-only",
        local_date: "2027-09-05",
        evidence: [
          {
            sourceUrl: "https://example.test/cfp",
            sourceClass: "official-cfp",
            rawExcerpt: "<tr><td>Paper submission deadline: September 5, 2027</td></tr>",
          },
        ],
        verification: {
          official_url: "https://example.test/cfp",
          source_class: "official-cfp",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () =>
      new Response("Official deadline extension: Paper submission deadline: September 6, 2027"),
  });
  expect(result.statuses).toEqual({ changed: 1 });
  expect(result.ledger.resolutions[0]?.change_kind).toBe("extension");
});

it("reverifies a production-shaped EasyChair target with its adapter and selector", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-easychair-adapter-"));
  const result = await reverifyData({
    dataPath: dataFile(dir, [
      {
        kind: "abstract",
        label: "Abstract submission",
        round: 1,
        track: "",
        precision: "date-only",
        local_date: "2027-09-15",
        adapter: "easychair-v1",
        selectorOrField: "table-row:deadline",
        verification: {
          official_url: "https://easychair.org/cfp/flowchallenge2",
          source_class: "official-cfp",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () =>
      new Response(
        "<table><tr><td>Abstract submission deadline: September 15, 2027</td></tr></table>",
        { headers: { "content-type": "text/html" } },
      ),
  });
  expect(result.statuses).toEqual({ verified: 1 });
  expect(result.ledger.deadlines["demo|demo-2027|abstract|1|"]).toMatchObject({
    adapter: "easychair-v1",
    selector_or_field: "table-row:deadline",
  });
});

it("verifies equivalent exact instants without requiring millisecond notation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-exact-instant-"));
  const result = await reverifyData({
    dataPath: dataFile(dir, [
      {
        kind: "paper",
        label: "Paper submission deadline",
        round: 1,
        track: "",
        precision: "exact",
        utc: "2027-01-02T23:59:00Z",
        tz_raw: "UTC",
        verification: {
          official_url: "https://example.test/cfp",
          source_class: "official-cfp",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027 23:59 UTC"),
  });
  expect(result.statuses).toEqual({ verified: 1 });
});

it("refreshes evidence on an existing resolution without creating a duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-resolution-refresh-"));
  const dataPath = dataFile(dir);
  const ledgerPath = join(dir, "verification-ledger.json");
  const body = "Official deadline extension: Paper submission deadline: January 3, 2027";
  const options = {
    dataPath,
    ledgerPath,
    due: true,
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response(body),
  };
  const first = await reverifyData({ ...options, now: new Date("2026-08-31T00:00:00.000Z") });
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
    resolutions: Array<Record<string, unknown>>;
  };
  delete ledger.resolutions[0]!.evidence_ref;
  writeFileSync(ledgerPath, JSON.stringify(ledger));

  const second = await reverifyData({ ...options, now: new Date("2026-09-08T00:00:00.000Z") });

  expect(first.ledger.resolutions).toHaveLength(1);
  expect(second.ledger.resolutions).toHaveLength(1);
  expect(second.ledger.resolutions[0]?.evidence_ref).toBe(
    `evidence/blobs/${createHash("sha256").update(body).digest("hex")}.body`,
  );
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

it("automatically rechecks an explicitly classified official homepage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-official-homepage-"));
  const result = await reverifyData({
    dataPath: dataFile(dir, [
      {
        kind: "paper",
        label: "Paper submission deadline",
        round: 1,
        track: "",
        precision: "date-only",
        local_date: "2027-01-02",
        verification: {
          official_url: "https://conference-example.org/cfp",
          source_class: "official-homepage",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027"),
  });
  expect(result.statuses).toEqual({ verified: 1 });
});

it("does not automatically fetch an aggregator-only target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-aggregator-"));
  let fetches = 0;
  const result = await reverifyData({
    dataPath: dataFile(dir, [
      {
        kind: "paper",
        label: "Paper submission deadline",
        round: 1,
        track: "",
        precision: "date-only",
        local_date: "2027-01-02",
        verification: {
          official_url: "https://aggregator.example/cfp",
          source_class: "aggregator",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]),
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("aggregator-only target must not be fetched");
    },
  });
  expect(fetches).toBe(0);
  expect(result).toMatchObject({
    processed: 1,
    pages: 0,
    statuses: { "manual-required": 1 },
  });
});

it("takes an auto-fetch URL and trust class from the same evidence record", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-evidence-source-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      precision: "date-only",
      local_date: "2027-01-02",
      evidence: [
        {
          sourceClass: "aggregator",
          sourceUrl: "https://aggregator.example/cfp",
        },
        {
          sourceClass: "official-cfp",
          sourceUrl: "https://official.example/cfp",
        },
      ],
    },
  ]);
  const targets = collectVerificationTargets(
    JSON.parse(readFileSync(dataPath, "utf8")),
    loadVerificationLedger(join(dir, "missing-ledger.json")),
    new Date("2026-08-31T00:00:00.000Z"),
  );
  expect(targets[0]).toMatchObject({
    sourceClass: "official-cfp",
    url: "https://official.example/cfp",
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

it("records zero bytes for a successful empty response instead of stale length", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-empty-body-"));
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
    fetchImpl: async () => new Response(new Uint8Array()),
  });
  expect(result.statuses).toEqual({ "parser-failed": 1 });
  expect(Object.values(result.ledger.pages)[0]?.content_length).toBe(0);
});

it("reports page-limit targets as deferred instead of processed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-deferred-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 1,
      track: "",
      precision: "date-only",
      local_date: "2027-01-02",
      verification: {
        official_url: "https://example.test/first",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
    {
      kind: "paper",
      label: "Paper submission deadline",
      round: 2,
      track: "",
      precision: "date-only",
      local_date: "2027-01-03",
      verification: {
        official_url: "https://example.test/second",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const result = await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    limits: { maxPages: 1 },
    bodyRoot: join(dir, "evidence", "blobs"),
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027"),
  });
  expect(result).toMatchObject({ processed: 1, deferred: 1, pages: 1 });
  expect(Object.values(result.statuses).reduce((sum, count) => sum + count, 0)).toBe(1);
});

it("spaces concurrent reverification requests to the same host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-host-rate-"));
  const dataPath = dataFile(dir, [
    {
      kind: "paper",
      label: "First deadline",
      round: 1,
      precision: "date-only",
      local_date: "2027-01-02",
      verification: {
        official_url: "https://example.test/first",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
    {
      kind: "paper",
      label: "Second deadline",
      round: 2,
      precision: "date-only",
      local_date: "2027-01-03",
      verification: {
        official_url: "https://example.test/second",
        source_class: "official-cfp",
        next_check_at: "2026-08-30T00:00:00.000Z",
        status: "pending",
      },
    },
  ]);
  const starts: number[] = [];
  await reverifyData({
    dataPath,
    ledgerPath: join(dir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    limits: { concurrency: 2, minHostIntervalMs: 40 },
    fetchImpl: async () => {
      starts.push(Date.now());
      return new Response("no deadline here");
    },
  });
  expect(starts).toHaveLength(2);
  expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(30);
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

it("does not rewrite an existing content-addressed body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-capture-cas-"));
  const bodyRoot = join(dir, "evidence", "blobs");
  const options = {
    bodyRoot,
    dnsLookup: async () => [{ address: "93.184.216.34" }],
    fetchImpl: async () => new Response("same body"),
    now: new Date("2026-08-31T00:00:00.000Z"),
  };
  const first = await capturePage("https://example.test/cfp", options);
  const preserved = new Date("2020-01-02T03:04:05.000Z");
  utimesSync(first.bodyRef, preserved, preserved);

  await capturePage("https://example.test/cfp", options);

  expect(statSync(first.bodyRef).mtimeMs).toBe(preserved.getTime());
  writeFileSync(first.bodyRef, "corrupted body");
  await expect(capturePage("https://example.test/cfp", options)).rejects.toThrow(
    /content-addressed body mismatch/,
  );
  const linkedBody = "linked body";
  const linkedHash = createHash("sha256").update(linkedBody).digest("hex");
  const linkedRoot = join(dir, "linked");
  mkdirSync(linkedRoot);
  writeFileSync(join(dir, "outside.body"), linkedBody);
  symlinkSync(join(dir, "outside.body"), join(linkedRoot, `${linkedHash}.body`));
  expect(() => writeCasBody(linkedRoot, linkedHash, Buffer.from(linkedBody))).toThrow(
    /regular file/,
  );
  expect(() => writeCasBody(dir, "../outside", new Uint8Array())).toThrow(/SHA-256/);
});

it("rejects hexadecimal IPv4-mapped private page addresses", () => {
  expect(() => assertSafePageUrl("https://[::ffff:7f00:1]/")).toThrow(/private page address/);
  expect(() => assertSafePageUrl("https://[::ffff:c0a8:101]/")).toThrow(/private page address/);
});

it("normalizes hosts before checking allowHttpHosts in assertSafePageUrl (#758)", () => {
  const urlWithDot = assertSafePageUrl("http://example.com./cfp", ["example.com"]);
  expect(urlWithDot.hostname).toBe("example.com.");
  const urlUpper = assertSafePageUrl("http://EXAMPLE.COM/cfp", ["example.com."]);
  expect(urlUpper.hostname).toBe("example.com");
  const ipv6 = assertSafePageUrl("http://[2001:db8::1]/cfp", ["[2001:db8::1]"]);
  expect(ipv6.hostname).toBe("[2001:db8::1]");
  expect(() => assertSafePageUrl("http://other.example.com/cfp", ["example.com"])).toThrow(
    /unsafe page URL protocol/,
  );
  expect(() => assertSafePageUrl("http://localhost./cfp", ["localhost"])).toThrow(/private/);
  expect(() => assertSafePageUrl("http://127.0.0.1/cfp", ["127.0.0.1"])).toThrow(/private/);
});

it("answers both lookup callback contracts from the pinned resolver", () => {
  // Node 26 の autoSelectFamily は lookup を { all: true } で呼び配列形式を要求する。
  // 旧式のみだと ERR_INVALID_IP_ADDRESS で capture 全リクエストが失敗する回帰の防止。
  const lookup = pinnedLookup("93.184.216.34");
  const arrayForm: unknown[] = [];
  (lookup as (h: string, o: unknown, cb: (...args: unknown[]) => void) => void)(
    "example.com",
    { all: true },
    (...args) => arrayForm.push(...args),
  );
  expect(arrayForm[0]).toBeNull();
  expect(arrayForm[1]).toEqual([{ address: "93.184.216.34", family: 4 }]);
  const legacyForm: unknown[] = [];
  (lookup as (h: string, o: unknown, cb: (...args: unknown[]) => void) => void)(
    "example.com",
    { family: 4 },
    (...args) => legacyForm.push(...args),
  );
  expect(legacyForm).toEqual([null, "93.184.216.34", 4]);
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
      timeoutMs: 10,
      fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
    }),
  ).rejects.toMatchObject({ code: "timeout" });
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
  await expect(
    capturePage("https://invalid-dns.example/cfp", {
      dnsLookup: async () => [{ address: "not-an-ip" }],
      fetchImpl: async () => new Response("unreachable"),
    }),
  ).rejects.toMatchObject({ code: "unsafe-url" });
  await expect(
    capturePage("https://unresolvable.example/cfp", {
      dnsLookup: async () => {
        throw new Error("ENOTFOUND");
      },
      fetchImpl: async () => new Response("unreachable"),
    }),
  ).rejects.toMatchObject({ code: "unsafe-url" });
  await expect(
    capturePage("https://stalled-dns.example/cfp", {
      timeoutMs: 10,
      dnsLookup: async () => new Promise(() => undefined),
      fetchImpl: async () => new Response("unreachable"),
    }),
  ).rejects.toMatchObject({ code: "timeout" });

  let redirectCancelled = false;
  let fetches = 0;
  await capturePage("https://example.test/first", {
    fetchImpl: async () => {
      fetches += 1;
      return fetches === 1
        ? new Response(
            new ReadableStream({
              cancel() {
                redirectCancelled = true;
              },
            }),
            { status: 302, headers: { location: "https://example.test/second" } },
          )
        : new Response("done");
    },
  });
  expect(redirectCancelled).toBe(true);

  let retryCancelled = false;
  await capturePage("https://example.test/retry", {
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            retryCancelled = true;
          },
        }),
        { status: 429 },
      ),
  });
  expect(retryCancelled).toBe(true);
});

it("classifies an AoE exact value on the same local day as a precision upgrade", () => {
  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-30" },
      {
        kind: "paper",
        round: 1,
        precision: "exact",
        date: "2026-09-30",
        time: "23:59",
        tz: "AoE",
      },
    ),
  ).toBe("precision-upgrade");
});

it("classifies an in-memory ExactDeadline with at_utc and tz_raw as a precision upgrade (#740)", () => {
  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-30" },
      {
        kind: "paper",
        round: 1,
        precision: "exact",
        at_utc: new Date("2026-10-01T11:59:00.000Z"), // 2026-09-30 23:59:00 AoE
        tz_raw: "AoE",
      },
    ),
  ).toBe("precision-upgrade");

  // Positive offset timezone early morning (Asia/Tokyo, UTC+9)
  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-30" },
      {
        kind: "paper",
        round: 1,
        precision: "exact",
        at_utc: new Date("2026-09-29T18:00:00.000Z"), // 2026-09-30 03:00:00 JST
        tz_raw: "Asia/Tokyo",
      },
    ),
  ).toBe("precision-upgrade");

  // Different calendar day is ambiguous
  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-30" },
      {
        kind: "paper",
        round: 1,
        precision: "exact",
        at_utc: new Date("2026-10-02T11:59:00.000Z"), // 2026-10-01 23:59:00 AoE
        tz_raw: "AoE",
      },
    ),
  ).toBe("ambiguous");
});

it("classifies date-only deadline changes within and beyond 30 days (#752)", () => {
  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-01" },
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-15" },
    ),
  ).toBe("extension");

  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-15" },
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-01" },
    ),
  ).toBe("pull-in");

  // Extension > 30 days is ambiguous
  expect(
    classifyDeadlineChange(
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-09-01" },
      { kind: "paper", round: 1, precision: "date-only", local_date: "2026-10-15" }, // 44 days
    ),
  ).toBe("ambiguous");
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
  const legacyLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  legacyLedger.resolutions[0].status = "changed";
  writeFileSync(ledgerPath, JSON.stringify(legacyLedger));
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

  const upgradeDir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-upgrade-"));
  const upgrade = await reverifyData({
    dataPath: dataFile(upgradeDir),
    ledgerPath: join(upgradeDir, "verification-ledger.json"),
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => new Response("Paper submission deadline: January 2, 2027 23:59 UTC"),
  });
  expect(upgrade.statuses).toEqual({ changed: 1 });
  expect(upgrade.ledger.resolutions[0]?.change_kind).toBe("precision-upgrade");
});

it.each([false, true])(
  "applies a promotion resolution and preserves history (exact: %s)",
  (exact) => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-promotion-apply-"));
    const data = join(root, "data");
    const batch = "2026-09-02-demo";
    const batchDir = join(data, "promotions", batch);
    const newValue = exact ? "2026-10-15 23:59 UTC" : "2026-10-15";
    const expectedDate = exact ? "2026-10-15 23:59" : "2026-10-15";
    const body = `Paper deadline extended to October 15, 2026${exact ? " 23:59 UTC" : ""}.`;
    const hash = createHash("sha256").update(body).digest("hex");
    const writeBatch = (
      targetDir: string,
      rows: Array<{ candidate: string; date: string; track?: string }>,
    ) => {
      mkdirSync(targetDir, { recursive: true });
      const observationsPath = join(targetDir, "observations.jsonl");
      const observations = rows.map((row, index) => {
        const captured = `Paper deadline: ${row.date}`;
        const bodyPath = join(targetDir, `capture-${index}.body`);
        const contentHash = createHash("sha256").update(captured).digest("hex");
        writeFileSync(bodyPath, captured);
        return {
          candidate: row.candidate,
          sourceUrl: `https://example.test/${row.candidate}/cfp`,
          sourceClass: "official-cfp",
          officialDomains: ["example.test"],
          title: row.candidate === "demo" ? "Demo" : "Invalid",
          categories: ["systems"],
          reviewState: "reviewed",
          categoryReviewState: "reviewed",
          deadline: { date: row.date, kind: "paper", round: 1, track: row.track ?? "" },
          eventDate: "2026-04-01",
          eventEndDate: "2026-04-01",
          rawExcerpt: captured,
          evidence: {
            sourceUrl: `https://example.test/${row.candidate}/cfp`,
            sourceClass: "official-cfp",
            sourceRevision: `sha256:${contentHash}`,
            retrievedAt: "2026-09-02T00:00:00.000Z",
            verifiedAt: "2026-09-02T00:00:00.000Z",
            contentHash,
            rawExcerpt: captured,
          },
          capture: {
            requestedUrl: `https://example.test/${row.candidate}/cfp`,
            finalUrl: `https://example.test/${row.candidate}/cfp`,
            status: 200,
            headers: {},
            retrievedAt: "2026-09-02T00:00:00.000Z",
            contentHash,
            parserVersion: "test/1",
            bodyPath,
            excerpt: captured,
            candidates: [
              { rawExcerpt: captured, date: row.date, kind: "paper", track: row.track ?? "" },
            ],
            sourceRevision: `sha256:${contentHash}`,
            officialDomains: ["example.test"],
          },
        };
      });
      writeFileSync(
        observationsPath,
        `${observations.map((observation) => JSON.stringify(observation)).join("\n")}\n`,
      );
      return writePromotionBatch(
        observationsPath,
        join(targetDir, "resolutions.json"),
        join(targetDir, "manifest.json"),
        { existingConferences: [] },
      );
    };
    mkdirSync(batchDir, { recursive: true });
    mkdirSync(join(data, "evidence", "blobs"), { recursive: true });
    writeFileSync(join(data, "evidence", "blobs", `${hash}.body`), body);
    writeFileSync(join(data, "extra.yaml"), "conferences: []\n");
    writeFileSync(join(data, "manual.yaml"), "conferences: []\n");
    writeFileSync(join(data, "snapshot.json"), '{"conferences":[]}\n');
    const promotionId = writeBatch(batchDir, [{ candidate: "demo", date: "2026-10-01" }])[0]
      ?.resolution_id;
    expect(promotionId).toBeTypeOf("string");
    generateCurated(root);
    const ledgerPath = join(root, "data", "verification-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        producer_revision: "reverification-v2",
        generated_at: "2026-09-02T00:00:00.000Z",
        pages: {
          "page:test": {
            requested_url: "https://example.test/cfp",
            final_url: "https://example.test/cfp",
            status: 200,
            content_type: "text/plain",
            content_length: body.length,
            content_hash: hash,
            source_revision: `sha256:${hash}`,
            parser_version: "reverification-v2",
            headers: {},
            last_attempt_at: "2026-09-02T00:00:00.000Z",
            last_success_at: "2026-09-02T00:00:00.000Z",
            body_ref: `evidence/blobs/${hash}.body`,
          },
        },
        deadlines: {
          "demo|demo-2026|paper|1|": {
            deadline_id: "demo|demo-2026|paper|1|",
            venue_key: "demo",
            edition_id: "demo-2026",
            kind: "paper",
            round: 1,
            track: "",
            label: "Paper submission",
            page_id: "page:test",
            official_url: "https://example.test/cfp",
            last_attempt_at: "2026-09-02T00:00:00.000Z",
            last_verified_at: null,
            next_check_at: "2026-09-03T00:00:00.000Z",
            content_hash: hash,
            status: "changed",
            source_class: "official-cfp",
            promotion_ref: { batch, resolution: promotionId },
          },
        },
        aliases: {},
        resolutions: [
          {
            resolution_id: "change-demo",
            deadline_id: "demo|demo-2026|paper|1|",
            page_id: "page:test",
            official_url: "https://example.test/cfp",
            observed_at: "2026-09-02T00:00:00.000Z",
            state: "open",
            first_detected_at: "2026-09-02T00:00:00.000Z",
            last_seen_at: "2026-09-02T00:00:00.000Z",
            old_value: "2026-10-01",
            new_value: newValue,
            change_kind: "extension",
            content_hash: hash,
            raw_excerpt: body,
            status: "changed",
            previous_value: "2026-10-01",
            current_value: newValue,
          },
        ],
      }),
    );

    const resolutionPath = join(batchDir, "resolutions.json");
    const originalResolutionText = readFileSync(resolutionPath, "utf8");
    const invalidBatchDir = join(data, "promotions", "2026-09-02-invalid");
    writeBatch(invalidBatchDir, [
      { candidate: "invalid", date: "2026-10-01", track: "Main" },
      { candidate: "invalid", date: "2026-11-01", track: "main" },
    ]);
    expect(() =>
      applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
    ).toThrow(/duplicate promoted deadline slot/);
    expect(readFileSync(resolutionPath, "utf8")).toBe(originalResolutionText);
    writeFileSync(join(invalidBatchDir, "observations.jsonl"), "");
    writePromotionBatch(
      join(invalidBatchDir, "observations.jsonl"),
      join(invalidBatchDir, "resolutions.json"),
      join(invalidBatchDir, "manifest.json"),
      { existingConferences: [] },
    );

    const stalePromotion = JSON.parse(originalResolutionText);
    stalePromotion[0].normalized.deadline.date = "2026-10-02";
    writeFileSync(resolutionPath, `${JSON.stringify(stalePromotion, null, 2)}\n`);
    expect(() =>
      applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
    ).toThrow(/resolution source value changed/);
    writeFileSync(resolutionPath, originalResolutionText);

    applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root);
    const updated = JSON.parse(readFileSync(join(batchDir, "resolutions.json"), "utf8"));
    expect(updated[0].normalized.deadline.date).toBe(expectedDate);
    expect(updated[0].normalized.deadline.evidence[0].verifiedFields).toEqual([
      "date",
      ...(exact ? ["time", "timezone"] : []),
      "kind",
      "round",
    ]);
    const curated = loadYaml(readFileSync(join(data, "curated.generated.yaml"), "utf8")) as {
      conferences: Array<{ editions: Array<{ deadlines: Array<Record<string, unknown>> }> }>;
    };
    const deadline = curated.conferences[0]?.editions[0]?.deadlines[0];
    expect(deadline?.date).toBe(expectedDate);
    expect(deadline?.superseded_deadlines).toMatchObject([
      { value: "2026-10-01", reason: "official-extension" },
    ]);
  },
);

it("applies new verification evidence to non-promotion source data", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-source-evidence-"));
  const data = join(root, "data");
  const body = "Official deadline extension: October 15, 2026 23:59 UTC.";
  const hash = createHash("sha256").update(body).digest("hex");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(data, "evidence", "blobs"), { recursive: true });
  writeFileSync(join(data, "evidence", "blobs", `${hash}.body`), body);
  writeFileSync(
    join(data, "manual.yaml"),
    `${[
      "conferences:",
      "  - key: demo",
      "    title: Demo",
      "    editions:",
      "      - year: 2026",
      "        id: demo-2026",
      "        deadlines:",
      "          - kind: paper",
      "            label: Paper submission",
      "            round: 1",
      "            date: 2026-10-01 23:59:00",
      "            precision: exact",
      "            tz: UTC",
      "            evidence:",
      "              - source_name: local",
      "                source_url: https://example.test/cfp",
      "                sourceClass: official-cfp",
      "                verifiedFields: [date]",
    ].join("\n")}\n`,
  );
  const ledgerPath = join(data, "verification-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 2,
      producer_revision: "reverification-v2",
      generated_at: "2026-09-02T00:00:00.000Z",
      pages: {
        "page:test": {
          requested_url: "https://example.test/cfp",
          final_url: "https://example.test/cfp",
          status: 200,
          content_type: "text/plain",
          content_length: body.length,
          content_hash: hash,
          source_revision: `sha256:${hash}`,
          parser_version: "reverification-v2",
          headers: {},
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_success_at: "2026-09-02T00:00:00.000Z",
          body_ref: `evidence/blobs/${hash}.body`,
        },
      },
      deadlines: {
        "demo|demo-2026|paper|1|": {
          deadline_id: "demo|demo-2026|paper|1|",
          venue_key: "demo",
          edition_id: "demo-2026",
          kind: "paper",
          round: 1,
          track: "",
          label: "Paper submission",
          page_id: "page:test",
          official_url: "https://example.test/cfp",
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-03T00:00:00.000Z",
          content_hash: hash,
          status: "changed",
          source_name: "local",
          source_class: "official-cfp",
        },
      },
      aliases: {},
      resolutions: [
        {
          resolution_id: "change-demo",
          deadline_id: "demo|demo-2026|paper|1|",
          page_id: "page:test",
          official_url: "https://example.test/cfp",
          observed_at: "2026-09-02T00:00:00.000Z",
          state: "accepted",
          first_detected_at: "2026-09-02T00:00:00.000Z",
          last_seen_at: "2026-09-02T00:00:00.000Z",
          old_value: "2026-10-01T23:59:00Z",
          new_value: "2026-10-15T23:59:00Z",
          change_kind: "extension",
          evidence_ref: `evidence/blobs/${hash}.body`,
          content_hash: hash,
          raw_excerpt: body,
          status: "changed",
          previous_value: "2026-10-01T23:59:00Z",
          current_value: "2026-10-15T23:59:00Z",
        },
      ],
    }),
  );

  const originalSource = readFileSync(join(data, "manual.yaml"), "utf8");
  writeFileSync(join(data, "manual.yaml"), originalSource.replace("2026-10-01", "2026-10-02"));
  expect(() =>
    applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
  ).toThrow(/resolution source value changed/);
  writeFileSync(join(data, "manual.yaml"), "conferences: []\n");
  expect(() =>
    applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
  ).toThrow(/resolution source conference is missing/);
  writeFileSync(join(data, "manual.yaml"), "conferences:\n  - key: demo\n    editions: []\n");
  expect(() =>
    applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
  ).toThrow(/resolution source edition is missing/);
  writeFileSync(
    join(data, "manual.yaml"),
    "conferences:\n  - key: demo\n    editions:\n      - year: 2026\n        id: demo-2026\n        deadlines: []\n",
  );
  expect(() =>
    applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
  ).toThrow(/resolution source slot is missing/);
  writeFileSync(join(data, "manual.yaml"), originalSource);

  applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root);
  const updated = loadYaml(readFileSync(join(data, "manual.yaml"), "utf8")) as {
    conferences: Array<{ editions: Array<{ deadlines: Array<Record<string, any>> }> }>;
  };
  expect(updated.conferences[0]?.editions[0]?.deadlines[0]).toMatchObject({
    date: "2026-10-15 23:59:00",
    tz: "Z",
    evidence: [
      {
        sourceClass: "official-cfp",
        contentHash: hash,
        evidenceRef: `evidence/blobs/${hash}.body`,
      },
    ],
  });
  const normalized = deadlinesOf(updated.conferences[0]?.editions[0] as Record<string, unknown>);
  expect(normalized[0]?.evidence?.[0]?.evidenceRef).toBe(`evidence/blobs/${hash}.body`);

  const nonlocalLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  nonlocalLedger.deadlines["demo|demo-2026|paper|1|"].source_name = "ccfddl";
  nonlocalLedger.deadlines["demo|demo-2026|paper|1|"].edition_id = "demo26";
  writeFileSync(ledgerPath, JSON.stringify(nonlocalLedger));
  writeFileSync(join(data, "overrides.yaml"), "{}\n");
  mkdirSync(join(data, "source-snapshots"), { recursive: true });
  const writeSourceSnapshot = (conferences: unknown[]): void => {
    writeFileSync(
      join(data, "source-snapshots", "ccfddl.json"),
      JSON.stringify({
        schemaVersion: 1,
        source: "ccfddl",
        sourceRevision: "test",
        fetchedAt: "2026-09-02T00:00:00.000Z",
        contentHash: createHash("sha256").update(JSON.stringify(conferences)).digest("hex"),
        conferences,
      }),
    );
  };
  writeSourceSnapshot([]);
  expect(() =>
    applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root),
  ).toThrow(/resolution source slot is missing/);
  writeSourceSnapshot([
    {
      key: "demo",
      editions: [
        {
          year: 2026,
          edition_id: "demo26",
          deadlines: [
            {
              kind: "paper",
              label: "Paper submission",
              round: 1,
              precision: "exact",
              date: "2026-10-01 23:59:00",
              tz: "UTC",
            },
          ],
        },
      ],
    },
  ]);
  applyResolutionSource(ledgerPath, "change-demo", "2026-09-02T01:00:00Z", root);
  const overrides = loadYaml(readFileSync(join(data, "overrides.yaml"), "utf8")) as any;
  expect(overrides.conferences.demo.editions["2026"].deadlines[0].date).toBe("2026-10-15 23:59:00");
  expect(overrides.conferences.demo.editions.demo26).toBeUndefined();
});

it.each([
  { editionId: "eaai-2727", accepted: true },
  { editionId: "eaai-2027", accepted: true },
  { editionId: "eaai-2728", accepted: false },
  { editionId: "eaai-123", accepted: false },
])(
  "uses only a supported year format in resolution edition $editionId (#760)",
  ({ editionId, accepted }) => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-dup-year-"));
    const data = join(root, "data");
    const body = "Official deadline extension: October 15, 2026 23:59 UTC.";
    const hash = createHash("sha256").update(body).digest("hex");
    mkdirSync(join(data, "evidence", "blobs"), { recursive: true });
    writeFileSync(join(data, "evidence", "blobs", `${hash}.body`), body);
    writeFileSync(
      join(data, "overrides.yaml"),
      [
        "conferences:",
        "  eaai-27:",
        "    editions:",
        "      '2027':",
        "        deadlines:",
        "          - kind: paper",
        "            label: Submission deadline",
        "            round: 1",
        "            date: 2026-10-01 23:59:00",
        "            tz: UTC",
      ].join("\n"),
    );
    const ledgerPath = join(data, "verification-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        producer_revision: "reverification-v2",
        generated_at: "2026-09-02T00:00:00.000Z",
        pages: {
          "page:test": {
            requested_url: "https://easychair.org/cfp/EAAI-27",
            final_url: "https://easychair.org/cfp/EAAI-27",
            status: 200,
            content_type: "text/plain",
            content_length: body.length,
            content_hash: hash,
            source_revision: `sha256:${hash}`,
            parser_version: "reverification-v2",
            headers: {},
            last_attempt_at: "2026-09-02T00:00:00.000Z",
            last_success_at: "2026-09-02T00:00:00.000Z",
            body_ref: `evidence/blobs/${hash}.body`,
          },
        },
        deadlines: {
          [`eaai-27|${editionId}|paper|1|`]: {
            deadline_id: `eaai-27|${editionId}|paper|1|`,
            venue_key: "eaai-27",
            edition_id: editionId,
            kind: "paper",
            round: 1,
            track: "",
            label: "Submission deadline",
            page_id: "page:test",
            official_url: "https://easychair.org/cfp/EAAI-27",
            last_attempt_at: "2026-09-02T00:00:00.000Z",
            last_verified_at: null,
            next_check_at: "2026-09-03T00:00:00.000Z",
            content_hash: hash,
            status: "changed",
            source_name: "ccfddl",
            source_class: "official-cfp",
          },
        },
        aliases: {},
        resolutions: [
          {
            resolution_id: "change-eaai",
            deadline_id: `eaai-27|${editionId}|paper|1|`,
            page_id: "page:test",
            official_url: "https://easychair.org/cfp/EAAI-27",
            observed_at: "2026-09-02T00:00:00.000Z",
            state: "accepted",
            first_detected_at: "2026-09-02T00:00:00.000Z",
            last_seen_at: "2026-09-02T00:00:00.000Z",
            old_value: "2026-10-01T23:59:00Z",
            new_value: "2026-10-15T23:59:00Z",
            change_kind: "extension",
            evidence_ref: `evidence/blobs/${hash}.body`,
            content_hash: hash,
            raw_excerpt: body,
          },
        ],
      }),
    );

    if (!accepted) {
      const before = readFileSync(join(data, "overrides.yaml"), "utf8");
      expect(() =>
        applyResolutionSource(ledgerPath, "change-eaai", "2026-09-02T01:00:00Z", root),
      ).toThrow(/edition has no usable year/);
      expect(readFileSync(join(data, "overrides.yaml"), "utf8")).toBe(before);
      return;
    }
    applyResolutionSource(ledgerPath, "change-eaai", "2026-09-02T01:00:00Z", root);
    const overrides = loadYaml(readFileSync(join(data, "overrides.yaml"), "utf8")) as {
      conferences: {
        "eaai-27": { editions: { "2027": { deadlines: Array<{ date: string }> } } };
      };
    };
    expect(overrides.conferences["eaai-27"].editions["2027"].deadlines[0]?.date).toBe(
      "2026-10-15 23:59:00",
    );
    rmSync(root, { recursive: true, force: true });
  },
);

it("refuses to apply a resolution without captured body evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-source-no-evidence-"));
  const data = join(root, "data");
  const sourcePath = join(data, "manual.yaml");
  const ledgerPath = join(data, "verification-ledger.json");
  mkdirSync(data, { recursive: true });
  const original = "conferences: []\n";
  writeFileSync(sourcePath, original);
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 2,
      producer_revision: "reverification-v2",
      generated_at: "2026-09-02T00:00:00.000Z",
      pages: {
        "page:test": {
          requested_url: "https://example.test/cfp",
          final_url: "https://example.test/cfp",
          status: 200,
          content_type: "text/plain",
          content_length: 0,
          content_hash: "",
          source_revision: "",
          parser_version: "reverification-v2",
          headers: {},
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_success_at: null,
          body_ref: "",
        },
      },
      deadlines: {
        "demo|demo-2026|paper|1|": {
          deadline_id: "demo|demo-2026|paper|1|",
          venue_key: "demo",
          edition_id: "demo-2026",
          kind: "paper",
          round: 1,
          track: "",
          page_id: "page:test",
          official_url: "https://example.test/cfp",
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-03T00:00:00.000Z",
          content_hash: null,
          status: "changed",
          source_name: "local",
        },
      },
      aliases: {},
      resolutions: [
        {
          resolution_id: "change-demo",
          deadline_id: "demo|demo-2026|paper|1|",
          page_id: "page:test",
          official_url: "https://example.test/cfp",
          observed_at: "2026-09-02T00:00:00.000Z",
          state: "accepted",
          first_detected_at: "2026-09-02T00:00:00.000Z",
          last_seen_at: "2026-09-02T00:00:00.000Z",
          old_value: "2026-10-01",
          new_value: "2026-10-15",
          change_kind: "extension",
          content_hash: "",
          raw_excerpt: "Paper deadline",
          status: "changed",
          previous_value: "2026-10-01",
          current_value: "2026-10-15",
        },
      ],
    }),
  );

  expect(() => applyResolutionSource(ledgerPath, "change-demo", null, root)).toThrow(
    /no captured body hash/,
  );
  expect(() => assertResolutionCanApply(ledgerPath, "change-demo")).toThrow(
    /no captured body hash/,
  );
  expect(readFileSync(sourcePath, "utf8")).toBe(original);
});

it("refuses to apply when the captured body is missing or does not match its hash", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-source-invalid-evidence-"));
  const data = join(root, "data");
  const sourcePath = join(data, "manual.yaml");
  const ledgerPath = join(data, "verification-ledger.json");
  const expectedBody = "Paper deadline: October 14, 2026";
  const hash = createHash("sha256").update(expectedBody).digest("hex");
  const bodyRef = `evidence/blobs/${hash}.body`;
  mkdirSync(data, { recursive: true });
  const original = "conferences: []\n";
  writeFileSync(sourcePath, original);
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 2,
      producer_revision: "reverification-v2",
      generated_at: "2026-09-02T00:00:00.000Z",
      pages: {
        "page:test": {
          requested_url: "https://example.test/cfp",
          final_url: "https://example.test/cfp",
          status: 200,
          content_type: "text/plain",
          content_length: 13,
          content_hash: hash,
          source_revision: `sha256:${hash}`,
          parser_version: "reverification-v2",
          headers: {},
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_success_at: "2026-09-02T00:00:00.000Z",
          body_ref: bodyRef,
        },
      },
      deadlines: {
        "demo|demo-2026|paper|1|": {
          deadline_id: "demo|demo-2026|paper|1|",
          venue_key: "demo",
          edition_id: "demo-2026",
          kind: "paper",
          round: 1,
          track: "",
          page_id: "page:test",
          official_url: "https://example.test/cfp",
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-03T00:00:00.000Z",
          content_hash: hash,
          status: "changed",
          source_name: "local",
        },
      },
      aliases: {},
      resolutions: [
        {
          resolution_id: "change-demo",
          deadline_id: "demo|demo-2026|paper|1|",
          page_id: "page:test",
          official_url: "https://example.test/cfp",
          observed_at: "2026-09-02T00:00:00.000Z",
          state: "accepted",
          first_detected_at: "2026-09-02T00:00:00.000Z",
          last_seen_at: "2026-09-02T00:00:00.000Z",
          old_value: "2026-10-01",
          new_value: "2026-10-15",
          change_kind: "extension",
          evidence_ref: bodyRef,
          content_hash: hash,
          raw_excerpt: "Paper deadline",
          status: "changed",
          previous_value: "2026-10-01",
          current_value: "2026-10-15",
        },
      ],
    }),
  );

  expect(() => applyResolutionSource(ledgerPath, "change-demo", null, root)).toThrow(
    /captured body is missing/,
  );
  mkdirSync(join(data, "evidence", "blobs"), { recursive: true });
  writeFileSync(join(data, bodyRef), "tampered body");
  expect(() => assertResolutionCanApply(ledgerPath, "change-demo")).toThrow(
    /captured body hash mismatch/,
  );
  writeFileSync(join(data, bodyRef), expectedBody);
  expect(() => assertResolutionCanApply(ledgerPath, "change-demo")).toThrow(
    /captured body does not support new value/,
  );
  const otherBody = "Paper deadline: October 15, 2026";
  const otherHash = createHash("sha256").update(otherBody).digest("hex");
  const otherRef = `evidence/blobs/${otherHash}.body`;
  writeFileSync(join(data, otherRef), otherBody);
  const otherLedger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  otherLedger.resolutions[0].content_hash = otherHash;
  otherLedger.resolutions[0].evidence_ref = otherRef;
  otherLedger.resolutions[0].raw_excerpt = otherBody;
  writeFileSync(ledgerPath, JSON.stringify(otherLedger));
  expect(() => assertResolutionCanApply(ledgerPath, "change-demo")).toThrow(
    /captured body does not match target page/,
  );
  expect(readFileSync(sourcePath, "utf8")).toBe(original);
});

it("does not overwrite a malformed source during resolution apply", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-source-shape-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const sourcePath = join(data, "extra.yaml");
  const original = "not-a-mapping\n";
  writeFileSync(sourcePath, original);
  const deadlineId = "demo|demo-2027|paper|1|";
  const ledgerPath = join(data, "verification-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-09-02T00:00:00.000Z",
      entries: {
        [deadlineId]: {
          official_url: "https://example.test/cfp",
          venue_key: "demo",
          edition_id: "demo-2027",
          kind: "paper",
          round: 1,
          track: "",
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-03T00:00:00.000Z",
          content_hash: null,
          source_name: "local",
          status: "changed",
        },
      },
      resolutions: [
        {
          deadline_id: deadlineId,
          official_url: "https://example.test/cfp",
          observed_at: "2026-09-02T00:00:00.000Z",
          previous_value: "2026-10-01",
          current_value: "2026-10-15",
          content_hash: "",
          raw_excerpt: "Paper deadline: October 15, 2026",
          status: "changed",
        },
      ],
    }),
  );
  const resolutionId = loadVerificationLedger(ledgerPath).resolutions[0]?.resolution_id;
  expect(resolutionId).toBeTruthy();
  expect(() => applyResolutionSource(ledgerPath, resolutionId!, null, root)).toThrow(
    /must contain a YAML mapping/,
  );
  expect(readFileSync(sourcePath, "utf8")).toBe(original);
});

it("does not coerce malformed nested source data during resolution apply", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-nested-source-shape-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const sourcePath = join(data, "extra.yaml");
  const original = "conferences:\n  - key: demo\n    editions: broken\n";
  writeFileSync(sourcePath, original);
  const deadlineId = "demo|demo-2027|paper|1|";
  const ledgerPath = join(data, "verification-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-09-02T00:00:00.000Z",
      entries: {
        [deadlineId]: {
          official_url: "https://example.test/cfp",
          venue_key: "demo",
          edition_id: "demo-2027",
          kind: "paper",
          round: 1,
          track: "",
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-03T00:00:00.000Z",
          content_hash: null,
          source_name: "local",
          status: "changed",
        },
      },
      resolutions: [
        {
          deadline_id: deadlineId,
          official_url: "https://example.test/cfp",
          observed_at: "2026-09-02T00:00:00.000Z",
          previous_value: "2026-10-01",
          current_value: "2026-10-15",
          content_hash: "",
          raw_excerpt: "Paper deadline: October 15, 2026",
          status: "changed",
        },
      ],
    }),
  );
  const resolutionId = loadVerificationLedger(ledgerPath).resolutions[0]?.resolution_id;
  expect(resolutionId).toBeTruthy();
  expect(() => applyResolutionSource(ledgerPath, resolutionId!, null, root)).toThrow(
    /editions must be an array/,
  );
  expect(readFileSync(sourcePath, "utf8")).toBe(original);
});

it("rejects invalid resolution dates before writing source data", () => {
  const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-invalid-resolution-"));
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  const sourcePath = join(data, "extra.yaml");
  const original = "conferences: []\n";
  writeFileSync(sourcePath, original);
  const deadlineId = "demo|demo-2027|paper|1|";
  const ledgerPath = join(data, "verification-ledger.json");
  writeFileSync(
    ledgerPath,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-09-02T00:00:00.000Z",
      entries: {
        [deadlineId]: {
          official_url: "https://example.test/cfp",
          venue_key: "demo",
          edition_id: "demo-2027",
          kind: "paper",
          round: 1,
          track: "",
          last_attempt_at: "2026-09-02T00:00:00.000Z",
          last_verified_at: null,
          next_check_at: "2026-09-03T00:00:00.000Z",
          content_hash: null,
          source_name: "local",
          status: "changed",
        },
      },
      resolutions: [
        {
          deadline_id: deadlineId,
          official_url: "https://example.test/cfp",
          observed_at: "2026-09-02T00:00:00.000Z",
          previous_value: "2026-10-01",
          current_value: "2026-02-30",
          content_hash: "",
          raw_excerpt: "Paper deadline: February 30, 2026",
          status: "changed",
        },
      ],
    }),
  );
  const resolutionId = loadVerificationLedger(ledgerPath).resolutions[0]?.resolution_id;
  expect(resolutionId).toBeTruthy();
  expect(() => applyResolutionSource(ledgerPath, resolutionId!, null, root)).toThrow(
    /invalid deadline date/,
  );
  expect(readFileSync(sourcePath, "utf8")).toBe(original);
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
      resolutions: [
        {
          deadline_id: "legacy",
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          previous_value: "2027-01-03",
          current_value: "2027-01-02",
          content_hash: "",
          raw_excerpt: "Paper deadline moved earlier",
          status: "changed",
        },
      ],
    }),
  );
  const migrated = loadVerificationLedger(path);
  expect(migrated.schema_version).toBe(2);
  expect(Object.keys(migrated.pages)).toHaveLength(1);
  expect(migrated.deadlines.legacy?.page_id).toBe(Object.keys(migrated.pages)[0]);
  expect(migrated.resolutions[0]).toMatchObject({
    change_kind: "ambiguous",
    status: "manual-required",
  });

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

  writeFileSync(
    invalid,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: {
        bad: {
          official_url: "https://example.test/cfp",
          venue_key: "demo",
          edition_id: "demo-2027",
          kind: "paper",
          round: 1,
          track: "",
          last_attempt_at: "2026-08-31T00:00:00.000Z",
          last_verified_at: 123,
          next_check_at: "2026-09-01T00:00:00.000Z",
          content_hash: null,
          status: "pending",
        },
      },
      resolutions: [],
    }),
  );
  expect(() => loadVerificationLedger(invalid)).toThrow(
    /invalid verification ledger entry:\nbad: last_verified_at is invalid/,
  );

  writeFileSync(
    invalid,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: {},
      resolutions: [
        {
          deadline_id: {},
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          previous_value: "2027-01-01",
          current_value: "2027-01-02",
          content_hash: "",
          raw_excerpt: "Paper deadline",
          status: "changed",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(invalid)).toThrow(
    /invalid verification ledger entry:\nresolution\[0\]: deadline_id is invalid/,
  );

  writeFileSync(
    invalid,
    JSON.stringify({
      schema_version: 1,
      generated_at: "2026-08-31T00:00:00.000Z",
      entries: {
        legacy: {
          official_url: "https://example.test/cfp",
          next_check_at: "2026-09-01T00:00:00.000Z",
          status: "pending",
        },
      },
      resolutions: [
        {
          deadline_id: "missing",
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          previous_value: "2027-01-01",
          current_value: "2027-01-02",
          status: "changed",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(invalid)).toThrow(/deadline_id does not resolve/);
});

it("rejects malformed V2 alias graphs and preserves retry headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-v2-validation-"));
  const path = join(dir, "ledger.json");
  const base = {
    schema_version: 2,
    producer_revision: "reverification-v2",
    generated_at: "2026-08-31T00:00:00.000Z",
    pages: {
      "page:test": {
        requested_url: "https://example.test/cfp",
        final_url: "https://example.test/cfp",
        status: 200,
        content_type: "text/html",
        content_length: 0,
        content_hash: "",
        source_revision: "",
        parser_version: "reverification-v2",
        headers: { retryAfter: "120" },
        last_attempt_at: "2026-08-31T00:00:00.000Z",
        last_success_at: null,
        body_ref: "",
      },
    },
    deadlines: {
      canonical: {
        deadline_id: "canonical",
        venue_key: "demo",
        edition_id: "demo-2027",
        kind: "paper",
        round: 1,
        track: "",
        page_id: "page:test",
        official_url: "https://example.test/cfp",
        last_attempt_at: "2026-08-31T00:00:00.000Z",
        last_verified_at: null,
        next_check_at: "2026-09-01T00:00:00.000Z",
        content_hash: null,
        status: "pending",
      },
    },
    aliases: {},
    resolutions: [],
  };
  writeFileSync(path, JSON.stringify(base));
  expect(loadVerificationLedger(path).pages["page:test"]?.headers.retryAfter).toBe("120");

  writeFileSync(
    path,
    JSON.stringify({ ...base, aliases: { legacy: "middle", middle: "canonical" } }),
  );
  expect(loadVerificationLedger(path).aliases).toEqual({
    legacy: "canonical",
    middle: "canonical",
  });

  writeFileSync(path, JSON.stringify({ ...base, generated_at: "not-a-date" }));
  expect(() => loadVerificationLedger(path)).toThrow(/generated_at is invalid/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [
        {
          resolution_id: 123,
          deadline_id: "canonical",
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          state: "open",
          first_detected_at: "2026-08-31T00:00:00.000Z",
          last_seen_at: "2026-08-31T00:00:00.000Z",
          old_value: "2026-09-01",
          new_value: "2026-09-02",
          change_kind: "extension",
          content_hash: "",
          raw_excerpt: "Paper deadline",
          status: "changed",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(
    /invalid verification ledger entry:\nresolution\[0\]: resolution_id is invalid/,
  );

  writeFileSync(path, JSON.stringify({ ...base, aliases: { legacy: "missing" } }));
  expect(() => loadVerificationLedger(path)).toThrow(/alias target does not resolve/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [
        {
          resolution_id: "orphan",
          deadline_id: "missing",
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          state: "open",
          first_detected_at: "2026-08-31T00:00:00.000Z",
          last_seen_at: "2026-08-31T00:00:00.000Z",
          old_value: "2026-09-01",
          new_value: "2026-09-02",
          change_kind: "extension",
          content_hash: "",
          raw_excerpt: "Paper deadline",
          status: "changed",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/deadline_id does not resolve/);

  writeFileSync(path, JSON.stringify({ ...base, aliases: { first: "second", second: "first" } }));
  expect(() => loadVerificationLedger(path)).toThrow(/alias graph contains a cycle/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      deadlines: {
        canonical: { ...base.deadlines.canonical, official_url: "file:///tmp/cfp" },
      },
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/official_url is unsafe/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      pages: {
        "page:test": { ...base.pages["page:test"], body_ref: "../outside.body" },
      },
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/body_ref must point inside evidence\/blobs/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [
        {
          resolution_id: "unsafe-evidence",
          deadline_id: "canonical",
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          state: "open",
          first_detected_at: "2026-08-31T00:00:00.000Z",
          last_seen_at: "2026-08-31T00:00:00.000Z",
          old_value: "2026-09-01",
          new_value: "2026-09-02",
          change_kind: "extension",
          evidence_ref: "../outside.body",
          content_hash: "",
          raw_excerpt: "Paper deadline",
          status: "changed",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(
    /evidence_ref must point inside evidence\/blobs/,
  );

  const conflictingResolution = {
    resolution_id: "conflicting-values",
    deadline_id: "canonical",
    official_url: "https://example.test/cfp",
    observed_at: "2026-08-31T00:00:00.000Z",
    state: "open",
    first_detected_at: "2026-08-31T00:00:00.000Z",
    last_seen_at: "2026-08-31T00:00:00.000Z",
    old_value: "2026-09-01",
    new_value: "2026-09-02",
    change_kind: "extension",
    content_hash: "",
    raw_excerpt: "Paper deadline",
    status: "changed",
    previous_value: "2026-08-31",
    current_value: "2026-09-02",
  };
  writeFileSync(path, JSON.stringify({ ...base, resolutions: [conflictingResolution] }));
  expect(() => loadVerificationLedger(path)).toThrow(/previous_value must match old_value/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [
        {
          ...conflictingResolution,
          previous_value: "2026-09-01",
          current_value: "2026-09-03",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/current_value must match new_value/);

  const consistentResolution = {
    ...conflictingResolution,
    previous_value: "2026-09-01",
    current_value: "2026-09-02",
  };
  writeFileSync(
    path,
    JSON.stringify({ ...base, resolutions: [consistentResolution, consistentResolution] }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/duplicate resolution_id/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      pages: {
        ...base.pages,
        "page:other": {
          ...base.pages["page:test"],
          requested_url: "https://other.example.test/cfp",
          final_url: "https://other.example.test/cfp",
        },
      },
      resolutions: [{ ...consistentResolution, page_id: "page:other" }],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/page_id does not match deadline page_id/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [{ ...consistentResolution, official_url: "https://other.example.test/cfp" }],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(
    /official_url does not match deadline official_url/,
  );

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [
        { ...consistentResolution, official_url: "https://example.test/cfp#deadlines" },
      ],
    }),
  );
  expect(loadVerificationLedger(path).resolutions[0]?.resolution_id).toBe("conflicting-values");

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      pages: {
        "page:test": {
          ...base.pages["page:test"],
          last_attempt_at: "2026-02-30T00:00:00.000Z",
        },
      },
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/last_attempt_at is invalid/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      deadlines: {
        canonical: { ...base.deadlines.canonical, round: "not-a-round" },
      },
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/round is invalid/);

  writeFileSync(
    path,
    JSON.stringify({
      ...base,
      resolutions: [
        {
          resolution_id: "applied-without-timestamp",
          deadline_id: "canonical",
          official_url: "https://example.test/cfp",
          observed_at: "2026-08-31T00:00:00.000Z",
          state: "applied",
          first_detected_at: "2026-08-31T00:00:00.000Z",
          last_seen_at: "2026-08-31T00:00:00.000Z",
          old_value: "2026-09-01",
          new_value: "2026-09-02",
          change_kind: "extension",
          content_hash: "",
          raw_excerpt: "",
          status: "changed",
          previous_value: "2026-09-01",
          current_value: "2026-09-02",
        },
      ],
    }),
  );
  expect(() => loadVerificationLedger(path)).toThrow(/applied state requires applied_at/);
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

it("carries an edition CallIdentity into verification targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-call-identity-"));
  const dataPath = dataFile(dir);
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  data.conferences[0].editions[0].call_identity = {
    seriesId: "demo",
    editionId: "demo-2027",
    callId: "demo-call",
    parentEventId: null,
  };
  const targets = collectVerificationTargets(
    data,
    loadVerificationLedger(join(dir, "missing-ledger.json")),
    new Date("2026-08-31T00:00:00.000Z"),
  );
  expect(targets[0]?.callIdentity).toBe("demo-call");
});

describe("fixes for reverify defects (#744)", () => {
  it("validateDeadline accepts last_attempt_at: null without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-null-attempt-"));
    const path = join(dir, "ledger.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 2,
        producer_revision: "reverification-v2",
        generated_at: "2026-09-01T00:00:00.000Z",
        pages: {
          "page:test": {
            page_id: "page:test",
            requested_url: "https://example.test/cfp",
            final_url: "https://example.test/cfp",
            last_attempt_at: "2026-09-01T00:00:00.000Z",
            last_success_at: null,
            body_ref: `evidence/blobs/${"a".repeat(64)}.body`,
            headers: {},
          },
        },
        deadlines: {
          canonical: {
            deadline_id: "canonical",
            venue_key: "demo",
            edition_id: "demo-2026",
            kind: "paper",
            round: 1,
            track: "",
            page_id: "page:test",
            last_attempt_at: null, // #744: nullable
            last_verified_at: null,
            next_check_at: "2026-09-02T00:00:00.000Z",
            status: "pending",
            source_name: "local",
          },
        },
        aliases: {},
        resolutions: [],
      }),
    );
    expect(() => loadVerificationLedger(path)).not.toThrow();
    const ledger = loadVerificationLedger(path);
    expect(ledger.deadlines.canonical.last_attempt_at).toBeNull();
  });

  it("assertCapturedResolutionBody allows round 2 and tracked deadlines with untagged CFP candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-r2-apply-"));
    const data = join(root, "data");
    mkdirSync(join(data, "evidence", "blobs"), { recursive: true });
    const sourcePath = join(data, "manual.yaml");
    writeFileSync(
      sourcePath,
      dumpYaml({
        conferences: [
          {
            key: "demo",
            title: "Demo Conf",
            editions: [
              {
                id: "demo-2026",
                year: 2026,
                deadlines: [
                  {
                    kind: "paper",
                    round: 2,
                    track: "research",
                    label: "Round 2 Paper",
                    date: "2026-10-01",
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const body = "Paper submission deadline: October 15, 2026";
    const hash = createHash("sha256").update(body).digest("hex");
    const bodyRef = `evidence/blobs/${hash}.body`;
    writeFileSync(join(data, bodyRef), body);
    const ledgerPath = join(data, "verification-ledger.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        producer_revision: "reverification-v2",
        generated_at: "2026-09-02T00:00:00.000Z",
        pages: {
          "page:test": {
            page_id: "page:test",
            requested_url: "https://example.test/cfp",
            final_url: "https://example.test/cfp",
            last_attempt_at: "2026-09-02T00:00:00.000Z",
            last_success_at: null,
            body_ref: bodyRef,
            content_hash: hash,
            headers: {},
          },
        },
        deadlines: {
          "demo|demo-2026|paper|2|research": {
            deadline_id: "demo|demo-2026|paper|2|research",
            venue_key: "demo",
            edition_id: "demo-2026",
            kind: "paper",
            round: 2,
            track: "research",
            page_id: "page:test",
            official_url: "https://example.test/cfp",
            last_attempt_at: "2026-09-02T00:00:00.000Z",
            last_verified_at: null,
            next_check_at: "2026-09-03T00:00:00.000Z",
            content_hash: hash,
            status: "changed",
            source_name: "local",
          },
        },
        aliases: {},
        resolutions: [
          {
            resolution_id: "change-r2",
            deadline_id: "demo|demo-2026|paper|2|research",
            page_id: "page:test",
            official_url: "https://example.test/cfp",
            observed_at: "2026-09-02T00:00:00.000Z",
            state: "accepted",
            first_detected_at: "2026-09-02T00:00:00.000Z",
            last_seen_at: "2026-09-02T00:00:00.000Z",
            old_value: "2026-10-01",
            new_value: "2026-10-15",
            change_kind: "extension",
            evidence_ref: bodyRef,
            content_hash: hash,
            raw_excerpt: "Paper submission deadline: October 15, 2026",
            status: "changed",
            previous_value: "2026-10-01",
            current_value: "2026-10-15",
          },
        ],
      }),
    );
    // #744: Should not throw "resolution captured body does not support new value"
    expect(() => assertResolutionCanApply(ledgerPath, "change-r2")).not.toThrow();
  });

  it("migrates resolution official_url and page_id when conference URL changes in data.json (#750)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-url-mig-"));
    const initialUrl = "https://example.test/cfp-v1";
    const updatedUrl = "https://example.test/cfp-v2";
    const initialPageId = pageIdForUrl(initialUrl);
    const updatedPageId = pageIdForUrl(updatedUrl);
    const deadlineId = "demo|demo-2026|paper|1|";
    const ledgerPath = join(dir, "ledger.json");
    const dataPath = join(dir, "data.json");

    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        producer_revision: "reverification-v2",
        generated_at: "2026-08-31T00:00:00.000Z",
        pages: {
          [initialPageId]: {
            requested_url: initialUrl,
            final_url: initialUrl,
            status: 200,
            content_type: "text/html",
            content_length: 100,
            content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            source_revision: "",
            parser_version: "reverification-v2",
            headers: {},
            provider: "unknown",
            last_attempt_at: "2026-08-31T00:00:00.000Z",
            last_success_at: "2026-08-31T00:00:00.000Z",
            body_ref:
              "evidence/blobs/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.body",
          },
        },
        deadlines: {
          [deadlineId]: {
            deadline_id: deadlineId,
            page_id: initialPageId,
            official_url: initialUrl,
            last_attempt_at: "2026-08-31T00:00:00.000Z",
            last_verified_at: null,
            next_check_at: "2026-09-01T00:00:00.000Z",
            content_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            status: "manual-required",
          },
        },
        aliases: {},
        resolutions: [
          {
            resolution_id: "res-demo",
            deadline_id: deadlineId,
            page_id: initialPageId,
            official_url: initialUrl,
            observed_at: "2026-08-31T00:00:00.000Z",
            state: "open",
            first_detected_at: "2026-08-31T00:00:00.000Z",
            last_seen_at: "2026-08-31T00:00:00.000Z",
            old_value: "2026-10-01",
            new_value: "2026-10-15",
            change_kind: "extension",
          },
        ],
      }),
    );

    // data.json now has updatedUrl
    writeFileSync(
      dataPath,
      JSON.stringify({
        conferences: [
          {
            key: "demo",
            title: "Demo",
            link: updatedUrl,
            editions: [
              {
                year: 2026,
                id: "demo-2026",
                link: updatedUrl,
                deadlines: [
                  {
                    kind: "paper",
                    round: 1,
                    date: "2026-10-01",
                    precision: "date-only",
                    source: "manual",
                    evidence: [
                      {
                        sourceUrl: updatedUrl,
                        sourceClass: "official-cfp",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    await reverifyData({
      dataPath,
      ledgerPath,
      now: new Date("2026-09-01T00:00:00.000Z"),
      fetchImpl: async () => new Response("Paper deadline: October 15, 2026"),
    });

    const loaded = loadVerificationLedger(ledgerPath);
    expect(loaded.resolutions[0]?.official_url).toBe(updatedUrl);
    expect(loaded.resolutions[0]?.page_id).toBe(updatedPageId);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not block verification when sibling rounds belong to different tracks (#756)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-track-round-"));
    const ledgerPath = join(dir, "verification-ledger.json");
    const dataPath = dataFile(dir, [
      {
        kind: "paper",
        label: "Research Track Round 2",
        round: 2,
        track: "research",
        precision: "date-only",
        local_date: "2027-02-01",
        evidence: [{ sourceClass: "official-cfp", sourceUrl: "https://example.test/cfp" }],
        verification: {
          official_url: "https://example.test/cfp",
          source_class: "official-cfp",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
      {
        kind: "paper",
        label: "Industry Track Round 1",
        round: 1,
        track: "industry",
        precision: "date-only",
        local_date: "2027-03-01",
        evidence: [{ sourceClass: "official-cfp", sourceUrl: "https://example.test/cfp" }],
        verification: {
          official_url: "https://example.test/cfp",
          source_class: "official-cfp",
          next_check_at: "2026-08-30T00:00:00.000Z",
          status: "pending",
        },
      },
    ]);

    await reverifyData({
      dataPath,
      ledgerPath,
      now: new Date("2026-08-31T00:00:00.000Z"),
      due: true,
      bodyRoot: join(dir, "evidence", "blobs"),
      fetchImpl: async () =>
        new Response(
          "Research Track Round 2 Deadline: February 1, 2027\nIndustry Track Round 1 Deadline: March 1, 2027",
        ),
    });

    const reloaded = loadVerificationLedger(ledgerPath);
    const researchEntry = reloaded.deadlines["demo|demo-2027|paper|2|research"];
    expect(researchEntry?.status).toBe("verified");
    rmSync(dir, { recursive: true, force: true });
  });
});

it("migrates a unique legacy ledger id and skips ambiguous legacy keys (#768)", async () => {
  const pageId = pageIdForUrl("https://example.test/cfp");
  const hash = "b".repeat(64);
  const conference = (key: string) => ({
    key,
    title: key,
    legacy_keys: ["fse"],
    editions: [
      {
        year: 2026,
        id: "2026",
        deadlines: [
          {
            kind: "paper",
            label: "Paper",
            round: 1,
            track: "",
            precision: "date-only",
            local_date: "2027-01-02",
            verification: {
              official_url: "https://example.test/cfp",
              source_class: "official-cfp" as const,
              next_check_at: "2099-01-01T00:00:00.000Z",
              status: "pending" as const,
            },
          },
        ],
      },
    ],
  });
  const writeCase = (keys: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "kamiyobi-reverify-migrate-"));
    const dataPath = join(dir, "data.json");
    const ledgerPath = join(dir, "verification-ledger.json");
    const conferences = keys.map(conference);
    writeFileSync(dataPath, JSON.stringify({ conferences }));
    const oldId = "fse|2026|paper|1|";
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 2,
        producer_revision: "reverification-v2",
        generated_at: "2026-08-31T00:00:00.000Z",
        pages: {
          [pageId]: {
            requested_url: "https://example.test/cfp",
            final_url: "https://example.test/cfp",
            status: 200,
            last_attempt_at: "2026-08-31T00:00:00.000Z",
            last_success_at: "2026-08-31T00:00:00.000Z",
          },
        },
        deadlines: {
          [oldId]: {
            page_id: pageId,
            deadline_id: oldId,
            venue_key: "fse",
            edition_id: "2026",
            kind: "paper",
            round: 1,
            track: "",
            next_check_at: "2099-01-01T00:00:00.000Z",
            status: "pending",
            content_hash: hash,
            official_url: "https://example.test/cfp",
          },
        },
        aliases: {},
        resolutions: [],
      }),
    );
    return { dir, dataPath, ledgerPath, oldId, conferences };
  };

  const unique = writeCase(["fse-sc"]);
  const uniqueId = deadlineId(
    unique.conferences[0]!,
    unique.conferences[0]!.editions[0]!,
    unique.conferences[0]!.editions[0]!.deadlines[0]!,
  );
  const uniqueResult = await reverifyData({
    dataPath: unique.dataPath,
    ledgerPath: unique.ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => {
      throw new Error("unique migration should not fetch");
    },
  });
  expect(uniqueId).toBe("fse-sc|2026|paper|1|");
  expect(uniqueResult.ledger.deadlines[unique.oldId]).toBeUndefined();
  expect(uniqueResult.ledger.deadlines[uniqueId]?.content_hash).toBe(hash);
  expect(uniqueResult.ledger.aliases[unique.oldId]).toBe(uniqueId);

  const ambiguous = writeCase(["fse-sc", "fse-se"]);
  const ambiguousResult = await reverifyData({
    dataPath: ambiguous.dataPath,
    ledgerPath: ambiguous.ledgerPath,
    now: new Date("2026-08-31T00:00:00.000Z"),
    due: true,
    fetchImpl: async () => {
      throw new Error("ambiguous migration should not fetch");
    },
  });
  expect(ambiguousResult.ledger.deadlines[ambiguous.oldId]?.content_hash).toBe(hash);
  expect(ambiguousResult.ledger.deadlines["fse-sc|2026|paper|1|"]?.content_hash).not.toBe(hash);
  expect(ambiguousResult.ledger.deadlines["fse-se|2026|paper|1|"]?.content_hash).not.toBe(hash);
  expect(ambiguousResult.ledger.aliases[ambiguous.oldId]).toBeUndefined();
});
