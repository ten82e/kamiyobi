/**
 * 敬語で閉じた打ち方（『来週木曜です』『ai でした』）– 第 417 回。
 *
 * 実測（2026-10-08 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 語を「です」で閉じると**必ず 0 行**だった – `来週` 53 行 / `来週です` **0 行**・
 * `来週木曜` 6 行 / **0 行**・`8月22日` 12 行 / **0 行**・`来月` 240 行 / **0 行**・
 * `中旬` 74 行 / **0 行**・`3日後` 3 行 / **0 行**・`未定` 6 行 / **0 行**、分野語も同じで
 * `ai` 331 行 / `aiです` **0 行**・`セキュリティ` 152 行 / **0 行**（`でした` `ですか` `でしょう`
 * `ですね` `だよ` `になります` `だと思います` `でしょうか` も全部 0 行・案内も無し）。
 * 助詞（は・が・も・で・か）は付いた侭通るので、敬語だけが壁だった – 「いつまで？」の返事を
 * そのまま貼る打ち方（『来週木曜です』）が黙って空になつて居た。
 *
 * 直し – 検索語の折りで、語尾の敬語・助動詞・終助詞を剥がす（最大三度 – 『来週にしたいです』）。
 * 語その物が敬語で了う形（`です` だけの検索語）は空にしない・残りが一字になる剥ぎ方はしない
 * （『すね』が『す』 – 389 行 – に化けた – 打ち直しで止めた）。
 *
 * 下の検査は検査用ビルドの品書（435 行）で見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 列表入口() {
  const 品 = (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
  const 済 = new Map<string, Set<string>>();
  return (語: string): Set<string> => {
    if (!済.has(語)) {
      const 当 = Recommender.searchMatcher(語, 基準);
      済.set(語, new Set(品.filter((行) => 当(行) === true)));
    }
    return 済.get(語) as Set<string>;
  };
}

const 列 = 列表入口();

function 対称差(甲: string, 乙: string): number {
  const A = 列(甲);
  const B = 列(乙);
  return [...A].filter((行) => !B.has(行)).length + [...B].filter((行) => !A.has(行)).length;
}

const 敬語々 = [
  "です",
  "でした",
  "ですか",
  "でしょうか",
  "でしょう",
  "ですね",
  "だよ",
  "かな",
  "じゃない",
  "ではない",
  "になります",
  "だと思います",
];

describe("敬語で閉じた打ち方", () => {
  it("日付の語を敬語で閉じても、付けない形と同じ行が出る", () => {
    for (const 語 of ["来週", "来週木曜", "8月22日", "来月", "中旬", "3日後", "未定", "明日まで"]) {
      expect(列(語).size, `「${語}」の行が在らない（検査が空振り）`).toBeGreaterThan(0);
      for (const 敬 of 敬語々) {
        expect(対称差(`${語}${敬}`, 語), `「${語}${敬}」の当たり方が「${語}」と違う`).toBe(0);
      }
    }
  });

  it("分野の語を敬語で閉じても同じ行が出る", () => {
    for (const 語 of ["ai", "ml", "セキュリティ"]) {
      expect(列(語).size, `「${語}」の行が在らない`).toBeGreaterThan(0);
      for (const 敬 of ["です", "でした", "ですね", "でしょうか"]) {
        expect(対称差(`${語}${敬}`, 語), `「${語}${敬}」が「${語}」と違う行を出した`).toBe(0);
      }
    }
  });

  it("空格で離して打たれた敬語の語もかけ算に加えない", () => {
    for (const [打ち方, 正本] of [
      ["来週 でした", "来週"],
      ["ai です", "ai"],
      ["ml かな", "ml"],
    ] as Array<[string, string]>) {
      expect(対称差(打ち方, 正本), `「${打ち方}」が「${正本}」と違う`).toBe(0);
    }
  });

  it("敬語が二つ重なっても打ち直せる（『来週にしたいです』）", () => {
    for (const [打ち方, 正本] of [
      ["来週にしたいです", "来週"],
      ["明日までにします", "明日まで"],
      ["来週でしたね", "来週"],
      ["8月22日ですね。", "8月22日"],
      ["mlですよ", "ml"],
      ["来週でしたね", "来週"],
      ["明日までにしましたね", "明日まで"],
    ] as Array<[string, string]>) {
      expect(列(正本).size, `正本「${正本}」の行が在らない`).toBeGreaterThan(0);
      expect(対称差(打ち方, 正本), `「${打ち方}」が「${正本}」と違う`).toBe(0);
    }
  });
});

describe("剥ぎ過ぎない", () => {
  it("敬語その物の検索語を空にしない（全行に化けない）", () => {
    expect(列("です").size, "『です』だけ全行に出てしまった").toBe(0);
    expect(列("でした").size).toBe(0);
  });

  it("語その物が敬語の語尾で了う形を壊さない（『しまね』『明日な』）", () => {
    /* 一文字の `ね` `な` を表に入れると此れ等が壊れる – 実測で割った（第 417 回）。
     * 『しまね』は島根の開かれた会を引く語で、『明日な』は幅を決めない形として受けない決まり
     * （第 344 回）で 0 行の侭にする必要がある。 */
    expect(列("しまね").size, "『しまね』の行が在らない（検査が空振り）").toBeGreaterThan(0);
    expect(対称差("しまね", "島根"), "『しまね』が『島根』と違う行を出した").toBe(0);
    expect(列("明日").size, "『明日』の行が在らない").toBeGreaterThan(0);
    expect(列("明日な").size, "『明日な』まで受けてしまった").toBe(0);
  });

  it("残りが一字になる剥ぎ方はしない（『すね』を『す』に化かさない）", () => {
    expect(列("す").size, "『す』の行数が取れない（検査が空振り）").toBeGreaterThan(0);
    expect(列("すね").size, "『すね』が『す』に化けている").toBe(0);
    expect(列("すね").size).toBeLessThan(列("す").size);
  });

  it("一字の助詞その物の当たり方は変えて居ない", () => {
    /* 「かな」は検査用ビルドの品書で 0 行なので、其処では調べない – 実ビルド（872 行）では 16 行。*/
    for (const 語 of ["だ", "な", "よ", "ね", "で"]) {
      expect(列(語).size, `「${語}」だけの当たり方が変わった`).toBeGreaterThan(0);
    }
  });
});

describe("守り", () => {
  it("前の回の直しを変えて居ない", () => {
    /* 位を足した週の形（第 416 回）。 */
    expect(対称差("来週内", "来週中")).toBe(0);
    /* 週の語に旬を繋げた形は第 490 回で二語に割れるやうになつた（第 416 回は案内を出して居た –
     * 實測で離した形が先に行を出した爲）。 */
    expect(列("来週中旬").size).toBe(43);
    expect(String(Recommender.uiWordNoteJa("来週中旬") ?? "").trim()).toBe("");
    /* 漢数字のか月（第 415 回）。 */
    expect(対称差("一か月後", "1か月後")).toBe(0);
    /* 分野の略語（第 414 回）。 */
    expect(Recommender.querySynonymNotes("ml").join(" ")).toContain("machine learning");
    /* 時刻にゾーンを繋げて打つ形（第 412 回）。 */
    expect(対称差("23:59JST", "23:59 JST")).toBe(0);
  });

  it("敬語を足しても案内は其の方の語を書く", () => {
    const 文 = Recommender.relativeDayNotes("来週ですね", 基準).join(" ");
    expect(文, "広げた週を書いていない").toContain("2026年8月10日");
  });
});

describe("成果物", () => {
  it("敬語の語尾の表は一個所に決まる", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    expect(物.match(/const 敬語の語尾Ja =/g) ?? []).toHaveLength(1);
    expect(物.match(/文\.replace\(敬語の語尾Ja, ""\)/g) ?? []).toHaveLength(1);
    /* 敬語だけの検索語を空にしない決まりが成果物に残つて居る。 */
    expect(物.match(/残った語々\.length > 0 \? 残った語々 : 打たれた語々/g) ?? []).toHaveLength(1);
  });
});
