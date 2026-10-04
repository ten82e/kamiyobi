/**
 * 収録していない情報を訪ねる語の案内の検査。SPEC §4・§7・第 358 回。
 * 実測（2026-10-16 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `旅費` `参加費` `対面のみ` `人気順` `古い遠い順` は案内が出るのに、其れと同じ家系の
 * `渡航費` `補助金` `学生支援` `travel grant` `招待状` `招聘状` `ビザ` `若手` `ベストペーパー`
 * `評価順` `締切順` `ハイブリッドのみ` `延長した締切` `未確定の締切` はいずれも **0 行で案内も無し**
 * だった（其の方の群に語が抜けただけ – 第 348 回）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

function 行列表(語: string): Array<{ hay: string }> {
  const matches = Recommender.searchMatcher(語, 基準);
  return 品書().filter((row) => matches(String(row.hay)) === true);
}

/** 案内が名指す語の候補（群の語その物が画面に.echo される – 第 355 回）。 */
function 名指しの候補(語: string): string[] {
  const 部品 = 語.split(/[\s、]+/);
  return [部品.join(" "), 部品.slice(0, 2).join(" "), 部品[0], 部品[1] ?? ""].filter((文) => 文);
}

const 収録に無い情報の打ち方 = [
  "渡航費",
  "旅費支援",
  "旅費補助",
  "補助",
  "補助金",
  "学生支援",
  "travel grant",
  "travel grant 関西",
  "travel 関西",
  "招待状",
  "招聘状",
  "ビザ",
  "若手",
  "若手研究者",
  "若手セッション",
  "若手ワークショップ",
  "ベストペーパー",
  "優秀論文",
  "賞",
  "若手 セキュリティ",
  "評価順",
  "締切順",
  "ハイブリッドのみ",
  "ハイブリッドだけ",
  "オンラインだけ",
  "対面だけ",
  "延長した締切",
  "未確定の締切",
  "確定していない締切",
];

describe("収録に無い情報を訪ねる語", () => {
  it("二十九の打ち方すべてに、0 行の侭、案内と読み上げが出る", () => {
    for (const 語 of 収録に無い情報の打ち方) {
      expect(行列表(語).length, `\`${語}\` に行が出てしまった（案内ではなく寄せた）`).toBe(0);
      const 案内 = Recommender.uiWordNoteJa(語);
      expect(
        名指しの候補(語).some((語名) => 案内.includes(`「${語名}」`)),
        `「${語}」の案内が出ていない`,
      ).toBe(true);
      expect(
        案内,
        `「${語}」の案内が収録している物を言っていない（無い物だけ言って終わっている）`,
      ).toMatch(/持っていません|ありません|収録していません|絞りません|絞れません/);
      expect(Recommender.uiWordLiveNoteJa(語).length, `「${語}」の読み上げが短い`).toBeGreaterThan(
        10,
      );
    }
  });

  it("案内の文は打ち方に依らない（打っていない語を名指さない）", () => {
    const 本体 = (語: string) => Recommender.uiWordNoteJa(語).replace(`「${語}」`, "");
    expect(本体("渡航費")).toBe(本体("補助金"));
    expect(本体("若手")).toBe(本体("ベストペーパー"));
    expect(本体("未確定の締切")).toBe(本体("延長した締切"));
    for (const 語 of [
      "渡航費",
      "補助金",
      "若手",
      "招待状",
      "ビザ",
      "延長した締切",
      "ハイブリッドのみ",
    ]) {
      expect(Recommender.uiWordNoteJa("若手"), `文が \`${語}\` を名指している`).not.toContain(
        `『${語}』`,
      );
    }
  });

  it("案内が導す語は実際に行を出す（空振りする打ち方を教えない – 第 353 回）", () => {
    /* 締切の状態の案内が名指す語（実品書では `未定` 6 行・`締切延長` 21 行）。品書の載り方に
     * 依るので絶対値を張らず、其の方で 0 行でない物が見付かる事を張る（第 344・355・357 回）。 */
    const 導し = ["未定", "締切延長", "オンライン参加可", "公式"];
    const 効く = 導し.filter((語) => 行列表(語).length > 0);
    expect(
      効く.length,
      `案内が名指す語（${導し.join("・")}）が検査の品書で全部 0 行`,
    ).toBeGreaterThan(0);
    /* 参加形式の案内が名指す欄は画面に在る（第 319 回 – 画面の語は画面の正本から読む）。 */
    const 画面 = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(画面, "案内が名指す参加形式の印が画面に無い").toContain("オンライン参加可");
  });

  it("当たりに案内を出さない（其の語は実際に行が出る – 「収録に無い」を噓にしない）", () => {
    for (const 語 of ["支援", "学生セッション", "未定", "締切延長", "日付未定", "ハイブリッド"]) {
      expect(
        行列表(語).length,
        `対照の \`${語}\` が 0 行（品書の載り方が変わった）`,
      ).toBeGreaterThan(0);
    }
    expect(Recommender.uiWordNoteJa("支援"), "`支援` を収録に無い語にしてしまった").toBe("");
    expect(Recommender.uiWordNoteJa("学生セッション"), "当たりを案内に変えた").toBe("");
    expect(Recommender.uiWordNoteJa("未定"), "`未定` を収録に無い語にしてしまった").toBe("");
  });
});

describe("其の侭の案内", () => {
  it("費用・対面・並び順・格・柔らかい範囲・休日の案内は其侭", () => {
    expect(Recommender.uiWordNoteJa("参加費")).toContain("この表が持っていません");
    expect(Recommender.uiWordNoteJa("旅費")).toContain("この表が持っていません");
    expect(Recommender.uiWordNoteJa("対面のみ")).toContain("オンライン参加可");
    expect(Recommender.uiWordNoteJa("人気順")).toContain("列の見出し");
    expect(Recommender.uiWordNoteJa("主要会議")).toContain("『ランク』");
    expect(Recommender.uiWordNoteJa("月初")).toContain("公用の決まりが無い");
    expect(Recommender.uiWordNoteJa("月前半")).toContain("『上旬』");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
    for (const 語 of ["穴場", "土日", "上旬", "週末", "今週末", "オンライン参加可"]) {
      expect(行列表(語).length, `\`${語}\` が落ちた`).toBeGreaterThan(0);
    }
  });
});

describe("成果物", () => {
  it("新しい二つの案内の文が成果物に一度ずつ入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    /* 数は実測で張る（第 354 回）– 「其れらを書く欄はありません」は画面の文と読み上げの文の
     * 両方に出るので二つ、他は一度ずつ。 */
    for (const [断片, 期待] of [
      ["延伸や確定の印を持っていません", 1],
      ["其れらを書く欄はありません", 2],
      ["延伸について書いた行は『締切延長』で", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(断片).length - 1, `成果物の中の断片 \`${断片.slice(0, 10)}…\` の数`).toBe(
        期待,
      );
    }
  });
});
