/**
 * 表その物を指す語・全部見たいの頼み方（第 379 回）。
 * 実測（2026-09-25 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `一覧` `一覧表` `締切一覧` `締切日` `〆切日` `しめきり` には「この表の全行にあてはまる語」の
 * 案内が出るのに、`すべて` `全て` `全件` `全部` `全締切` と `〆切り` `〆め切り` `しめきり日`
 * `〆切日付` `〆切一覧` `デッドライン` `でっどらいん` は **0 行で案内も無し**だった（画面は
 * 「0 件」だけで、此の表に締切が在るのかと利用者に分からせた – 第 239 回・第 331 回と同じ形）。
 * 空の検索語は実測 872 行（全行）を通すので、「全部見たい」には其の場打ち直しを書ける。
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

function 全表案内(語: string): string {
  return String(Recommender.wholeTableQueryNoteJa(語) || "");
}

describe("表その物を指す語の案内", () => {
  it("全部見たいの頼み方に、絞り込めない事と打ち直し方を其の場で書く（第 379 回）", () => {
    for (const 語 of ["すべて", "全て", "全件", "全部", "全締切"]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      const 文 = 全表案内(語);
      expect(文, `案内が出る: ${語}`).toContain("この表の全行にあてはまる語");
      expect(文, `其の方の語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `打ち直し方を書く: ${語}`).toContain("検索語を消してください");
      expect(文, `過ぎた締切の切替を書く: ${語}`).toContain("過去の締切も表示");
    }
  });

  it("締切の言い方の写法の違いに、同じ案内を出す（第 379 回）", () => {
    for (const 語 of ["〆切り", "〆め切り", "しめきり日", "〆切日付", "〆切一覧"]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      const 文 = 全表案内(語);
      expect(文, `案内が出る: ${語}`).toContain("この表の全行にあてはまる語");
      expect(文, `其の方の語を書き返す: ${語}`).toContain(`「${語}」`);
    }
    /* 画面の説明文に書けない言い方（其の方の語を打つ人は受けるが、案内は其の方を名指さない –
     * `カテゴリ` の案内と同じ流儀 – 第 248 回・第 379 回）。 */
    for (const 語 of ["デッドライン", "でっどらいん"]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      const 文 = 全表案内(語);
      expect(文, `案内が出る: ${語}`).toContain("この表の全行にあてはまる語");
      expect(文, `説明文に其の方を書かない: ${語}`).not.toContain(語);
      expect(文, `其の場で受け方を示す: ${語}`).toContain("その語はこの表の全行にあてはまる語");
    }
  });

  it("其れ以前の語（第 239 回・第 245 回・第 248 回・第 331 回）は其侭案内が出る", () => {
    for (const 語 of [
      "一覧",
      "一覧表",
      "締切一覧",
      "締切日",
      "〆切日",
      "しめきり",
      "会議",
      "大会",
    ]) {
      expect(行列表(語).length, `絞り込まない: ${語}`).toBe(0);
      expect(全表案内(語), `案内が出る: ${語}`).toContain("表の欄に出る語で打ってください");
    }
  });

  it("其の方で通る語に全行の案内を付けない（噓になる – 第 337 回）", () => {
    /* 品書に現れる語は当たりなので、全行にあてはまる語の案内を付けない。 */
    expect(行列表("締切").length, "`締切` は通る").toBeGreaterThan(0);
    expect(全表案内("締切"), "`締切` に全行の案内を付けない").toBe("");
    expect(全表案内("〆切"), "`〆切` に全行の案内を付けない").toBe("");
    expect(全表案内("査読"), "`査読` に全行の案内を付けない").toBe("");
  });

  it("其の方の語の列挙に当たり語を足していない（実測で 0 行の語だけ – 第 337 回）", () => {
    /* 案内が名指す代替の語は其の方で通る（其の方を通らない語に案内が化けていない）。 */
    const 文 = 全表案内("すべて");
    for (const 例 of ["SC", "セキュリティ", "パリ"]) {
      expect(文, `案内が名指す例: ${例}`).toContain(例);
      expect(行列表(例).length, `例は其の方で通る: ${例}`).toBeGreaterThan(0);
    }
  });

  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 条目列表: Array<[string, number]> = [
      /* 全行を頼む語と、締切の言い方の写法の違い。 */
      ['"すべて",', 1],
      ['"全て",', 1],
      ['"全件",', 1],
      ['"全部",', 1],
      ['"全締切",', 1],
      ['"〆切り",', 1],
      ['"〆め切り",', 1],
      ['"しめきり日",', 1],
      ['"〆切日付",', 1],
      ['"〆切一覧",', 1],
      /* 片仮名の其の方の語は検索語の列と、案内に書かない語の列の両方に出る（其の方の語を
       * 打つ人は受け、案内は其の方を名指さない – 第 248 回・第 379 回）。 */
      ['"デッドライン",', 2],
      /* 平仮名の形は語の列に 1 処だけ（其の方の語の列の最後は読点で終わらない）。 */
      ['"でっどらいん",', 1],
      [
        'new Set(["\u30c7\u30c3\u30c9\u30e9\u30a4\u30f3", "\u3067\u3063\u3069\u3089\u3044\u3093"])',
        1,
      ],
      ['const 名指し = WHOLE_TABLE_COPY_OMITTED_JA.has(word) ? "\u305d\u306e\u8a9e"', 1],
      /* 打ち直し方の文（其の方の語の案内と読み上げが同じ文列を使う）。 */
      [
        "表の全行を見たい時は検索語を消してください（過ぎた締切は『過去の締切も表示』で出ます）。",
        1,
      ],
    ];
    for (const [条目, 数] of 条目列表) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 16)}`).toBe(数);
    }
  });
});
