/**
 * 電子情報通信学会 研究会スケジュール表の解釈と data/manual.yaml への反映
 * （scripts/refresh-ieice.ts）。実ページのスケジュール表を fixture にして検査する
 * （tests/fixtures/ieice/*.schedule.html は ken.ieice.org の実 HTML から表だけを切り出したもの）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  keyToTgid,
  parseSchedule,
  placeFromCell,
  planIeiceUpdate,
} from "../scripts/refresh-ieice.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "ieice");
const fixture = (name: string) => readFileSync(join(FIXTURES, `${name}.schedule.html`), "utf8");

describe("IEICE 研究会スケジュール表の解釈", () => {
  const rows = parseSchedule(fixture("NS"));

  it("実ページから会期・開催地・発表申込締切を読む", () => {
    expect(rows.length).toBeGreaterThanOrEqual(8);
    const december = rows.find((r) => r.event_start === "2026-12-17");
    expect(december?.event_end).toBe("2026-12-18");
    expect(december?.date_text).toBe("2026年12月17日-18日");
    expect(december?.deadline).toBe("2026-10-13");
    // 公式の項目名は「発表申込締切日」で、値は `[10月13日(火)]` のように日付だけ。
    expect(december?.deadline_text).toContain("10月13日");
  });

  it("締切未公開の回は null（日付を補わない）", () => {
    const undetermined = rows.filter((r) => r.deadline_text.includes("未定"));
    expect(undetermined.length).toBeGreaterThan(0);
    for (const row of undetermined) expect(row.deadline).toBeNull();
  });

  it("年をまたぐ会期を正しい年として読む", () => {
    const january = rows.find((r) => r.event_start.startsWith("2027-01"));
    expect(january?.event_end).toBe("2027-01-22");
    expect(january?.date_text).toBe("2027年1月21日-22日");
  });

  it("締切月が会期月より後ろなら前年として読む", () => {
    // 1月開催の回に対する「12月○日」締切を翌年にしてしまわないための検査。
    const synthetic = [
      `<table><tr><td>2027年1月20日(水)</td><td>会場（東京都）</td><td>テーマ</td><td>-</td><td>[ 12月15日(火) ]</td><td>発表申込受付中</td></tr></table>`,
    ].join("");
    expect(parseSchedule(synthetic)[0]?.deadline).toBe("2026-12-15");
  });

  it("複数会期・ハイブリッド開催の表記を開張計画に使える形に寄せる", () => {
    const cpsy = parseSchedule(fixture("CPSY"));
    expect(cpsy.find((r) => r.event_start === "2026-12-01")?.place).toBe(
      "沖縄産業支援センター（沖縄県）／オンライン",
    );
    // 全角の「＋」が混ざっても開場／オンラインの組み立てを壊さない。
    expect(placeFromCell("某会場 ＋ オンライン開催 (大阪府, オンライン)")).toBe(
      "某会場（大阪府）／オンライン",
    );
    expect(placeFromCell("某会場 (オンライン開催)")).toBe("某会場／オンライン");
    expect(placeFromCell("")).toBe("未定");
    // 会場名そのものは壊さない。
    expect(placeFromCell("飛騨・世界生活文化センター(通称:飛騨センター) （岐阜県）")).toBe(
      "飛騨・世界生活文化センター(通称:飛騨センター)（岐阜県）",
    );
  });

  it("表でないと読める行がなければ空配列", () => {
    expect(parseSchedule("<html><body>スケジュールは未掲載です</body></html>")).toEqual([]);
    expect(parseSchedule("")).toEqual([]);
  });
});

describe("IEICE 研究会の更新を data/manual.yaml に反映する", () => {
  const manualConference = (id: string, eventStart: string, deadlinesYaml: string) =>
    [
      `conferences:`,
      `  # 根拠: https://ken.ieice.org/ken/program/?tgid=IEICE-NS (2026-09-22 取得)`,
      `  - categories:`,
      `      - networking`,
      `    editions:`,
      `      - date_text: 2026年12月17日-18日`,
      deadlinesYaml,
      `        event_end: '2026-12-18'`,
      `        event_start: '${eventStart}'`,
      `        id: ${id}`,
      `        link: https://ken.ieice.org/ken/program/?tgid=IEICE-NS`,
      `        place: 北海道大学／オンライン`,
      `        year: 2026`,
      `    full_name: 電子情報通信学会 ネットワークシステム研究会 (NS)`,
      `    key: ieice-ns`,
      `    link: https://ken.ieice.org/ken/program/?tgid=IEICE-NS`,
      `    tags:`,
      `      - domestic-jp`,
      `    title: 電子情報通信学会 NS 研究会`,
      `schema_version: 1`,
      "",
    ].join("\n");

  const rows = parseSchedule(fixture("NS"));

  it("空の deadlines: [] だけを発表申込締切で埋める", () => {
    const manual = manualConference("ieice-ns-2026-12", "2026-12-17", `        deadlines: []`);
    const plan = planIeiceUpdate(manual, { "ieice-ns": rows }, "2026-09-22");
    const entry = plan.entries.find((e) => e.key === "ieice-ns");
    expect(entry?.deadlinesFilled).toEqual(["ieice-ns-2026-12 2026-10-13"]);
    expect(plan.text).toContain(`          - date: '2026-10-13'`);
    // 公式が日付しか出していないので、時刻は補わない。
    expect(plan.text).toContain(`            precision: date-only`);
    expect(plan.text).not.toContain("23:59");
    expect(loadYaml(plan.text)).toBeTruthy();
  });

  it("すでに締切を持つ版は書き換えない", () => {
    const manual = manualConference(
      "ieice-ns-2026-12",
      "2026-12-17",
      [
        `        deadlines:`,
        `          - date: '2026-10-01 23:59:00'`,
        `            kind: abstract`,
        `            label: 発表申込締切`,
        `            tz: UTC+9`,
      ].join("\n"),
    );
    const plan = planIeiceUpdate(manual, { "ieice-ns": rows }, "2026-09-22");
    const entry = plan.entries.find((e) => e.key === "ieice-ns");
    expect(entry?.deadlinesFilled).toEqual([]);
    // 人手で確定済みの値（23:59 JST）はそのまま、date-only の追記もされない。
    expect(plan.text).toContain("          - date: '2026-10-01 23:59:00'");
    expect(plan.text).not.toContain("2026-10-13");
  });

  it("前の版へ次の回の締切をくっつけない", () => {
    // 2026-09-22 の dry-run で実際に起きた事故型。空の deadlines: [] を前方検索すると
    // 過ぎた回（ieice-cpsy-2026）に 12 月の締切を登録してしまう。
    const manual = [
      `conferences:`,
      `  - categories:`,
      `      - security`,
      `    editions:`,
      `      - date_text: 2026年9月29日`,
      `        deadlines: []`,
      `        event_end: '2026-09-29'`,
      `        event_start: '2026-09-29'`,
      `        id: ieice-cpsy-2026`,
      `        link: https://ken.ieice.org/ken/program/?tgid=IEICE-CPSY`,
      `        place: 某会場`,
      `        year: 2026`,
      `      - date_text: 2026年12月1日-2日`,
      `        deadlines:`,
      `          - date: '2026-09-30'`,
      `            kind: abstract`,
      `            label: 発表申込締切`,
      `            precision: date-only`,
      `        event_end: '2026-12-02'`,
      `        event_start: '2026-12-01'`,
      `        id: ieice-cpsy-2026-12`,
      `        link: https://ken.ieice.org/ken/program/?tgid=IEICE-CPSY`,
      `        place: 沖縄産業支援センター（沖縄県）／オンライン`,
      `        year: 2026`,
      `    full_name: 電子情報通信学会 サイバーセキュリティ研究会 (CPSY)`,
      `    key: ieice-cpsy`,
      `    link: https://ken.ieice.org/ken/program/?tgid=IEICE-CPSY`,
      `    title: 電子情報通信学会 CPSY 研究会`,
      `schema_version: 1`,
      "",
    ].join("\n");
    const plan = planIeiceUpdate(
      manual,
      { "ieice-cpsy": parseSchedule(fixture("CPSY")) },
      "2026-09-22",
    );
    const entry = plan.entries.find((e) => e.key === "ieice-cpsy");
    expect(entry?.deadlinesFilled).toEqual([]);
    expect(plan.text).toBe(manual);
  });

  it("manual.yaml に無い研究会は勝手に追加しない", () => {
    const manual = manualConference("ieice-ns-2026-12", "2026-12-17", `        deadlines: []`);
    const plan = planIeiceUpdate(manual, { "ieice-nws": rows }, "2026-09-22");
    expect(plan.unregistered).toEqual(["ieice-nws"]);
    expect(plan.text).toBe(manual);
  });

  it("既存版に無い今後の会期を追記し、終わった会期は足さない", () => {
    const manual = manualConference("ieice-ns-2026-12", "2026-12-17", `        deadlines: []`);
    const first = planIeiceUpdate(manual, { "ieice-ns": rows }, "2026-09-22");
    const added = first.entries.find((e) => e.key === "ieice-ns")?.editionsAdded ?? [];
    expect(added).toContain("2027-01-21");
    expect(added).not.toContain("2026-04-09");
    const doc = loadYaml(first.text) as { conferences: { editions: unknown[]; key: string }[] };
    const editions = doc.conferences[0].editions as { id: string }[];
    expect(editions.map((e) => e.id)).toContain("ieice-ns-2027-01");
    // 2 回目を適用しても変化しない（実行のたびに版が積み上がらない）。
    const second = planIeiceUpdate(first.text, { "ieice-ns": rows }, "2026-09-22");
    expect(second.text).toBe(first.text);
  });

  it("研究会 key と tgid の対応を手入力の key 名から決める", () => {
    expect(keyToTgid("ieice-ns")).toBe("NS");
    expect(keyToTgid("ieice-isec")).toBe("ISEC");
    // 対応表に無い key も命名規則で組み立てる（推測で新しい会議を作らないための確認）。
    expect(keyToTgid("ieice-cpsy")).toBe("CPSY");
  });
});
