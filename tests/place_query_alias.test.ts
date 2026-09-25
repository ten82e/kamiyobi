/**
 * 開催地の日本語の別の言い方（都市・国・州）の検査。SPEC §4・§7・第 360 回。
 * 実測（2026-10-18 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * 直し前は `リバースサイド` `ソルトレイク` `ギリシア` `大韓民国` `エジプト` `ノースカロライナ`
 * `ニューヨーク州` `イングランド` を打つと **0 行で案内も無し**、其の方の英語の表記は通った
 * （riverside 19 行・salt lake city 9 行・greece 25 行・korea 14 行・egypt 1 行・
 * north carolina 1 行・new york 1 行・england 35 行）。
 * 表（`PLACE_QUERY_ALIASES_JA`）の条目は二百三十一あり、其の内の八十は収録に其の催し物が無い為
 * 0 行の侭置いてある（将来の収録に備えた条目 – 実測）なので、此処の検査は**此の回に足した条目**に
 * 対してだけ対称差ゼロを見る（広く張ると其の八十が落ちて、大事な事が読めなくなる – 第 344 回）。
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

function 対称差(a: string, b: string): number {
  const x = new Set(行列表(a).map((r) => r.hay));
  const y = new Set(行列表(b).map((r) => r.hay));
  return [...x].filter((k) => !y.has(k)).length + [...y].filter((k) => !x.has(k)).length;
}

/** 第 360 回に足した条目（日本語の打ち方 → 収録の原文の表記）。 */
const 開催地の寄せ: Array<[string, string]> = [
  ["リバースサイド", "riverside"],
  ["ソルトレイク", "salt lake city"],
  ["ギリシア", "greece"],
  ["大韓民国", "korea"],
  ["エジプト", "egypt"],
  ["ノースカロライナ", "north carolina"],
  ["ニューヨーク州", "new york"],
  ["イングランド", "england"],
];

describe("開催地の日本語の別の言い方", () => {
  it("其の方の原文の表記と一字も違わない行集合になり、一行以上出る", () => {
    for (const [日本語, 原文] of 開催地の寄せ) {
      /* 対称差ゼロを張る – 0 行同士の組でも成り立つので、其の方で 0 でない組が在る事を
       * 別に張る（実品書では リバースサイド 19 行・イングランド 35 行 – 検査の品書には
       * 載らない都市がある – 第 344・355・357・359 回）。 */
      expect(対称差(日本語, 原文), `\`${日本語}\` が \`${原文}\` と違う行を出した`).toBe(0);
    }
    const 原文々 = [...new Set(開催地の寄せ.map(([, 原文]) => 原文))];
    const 出る = 原文々.filter((原文) => 行列表(原文).length > 0);
    expect(
      出る.length,
      `寄せ先の表記（${原文々.join("・")}）が検査の品書で全部 0 行`,
    ).toBeGreaterThan(0);
  });

  it("行が出る語に案内を出さない（「収録に無い」を噓にしない – 第 358 回）", () => {
    for (const [日本語] of 開催地の寄せ) {
      expect(Recommender.uiWordNoteJa(日本語), `\`${日本語}\` に案内が乗った`).toBe("");
      const 寄せの案内 = Recommender.querySynonymNotes(日本語).join(" ");
      expect(寄せの案内, `\`${日本語}\` を収録に無い語と言った`).not.toMatch(
        /収録にありません|収録データにありません/,
      );
    }
  });

  it("其の方の別の言い方も其侭通る（寄せを増やした為に取り壊さない）", () => {
    /* 其の方の別の言い方（同じ収録の行へ寄る語）は、其の方の表記と一字も違わない侭である事。
     * 絶対値を張らない – 検査の品書に載らない都市がある（第 359 回）。 */
    for (const [日本語, 原文] of [
      ["ギリシャ", "greece"],
      ["韓国", "korea"],
      ["ニューヨーク", "new york"],
      ["ソルトレイクシティ", "salt lake city"],
      ["イギリス", "england"],
    ]) {
      expect(対称差(日本語, 原文), `\`${日本語}\` が \`${原文}\` と違う行を出した`).toBe(0);
    }
    const 其の方 = ["ギリシャ", "韓国", "ニューヨーク", "米国", "イギリス", "パリ", "東京"].filter(
      (語) => 行列表(語).length > 0,
    );
    expect(
      其の方.length,
      "其の方の別の言い方が検査の品書で全部 0 行（此処では何も見ていない）",
    ).toBeGreaterThan(0);
    /* `米国` は其の方の表記より広く当たる（原文に 米国 と書かれた行も含む – 実測 208/203）。
     * 寄せ先より狭くなっていたら取り壊しなので、其れを張る。 */
    expect(行列表("米国").length, "`米国` が usa より狭くなった").toBeGreaterThanOrEqual(
      行列表("usa").length,
    );
  });

  it("都市・国・州の語を語として立てても他の家系は其侭（分野・収録に無い物・柔らかな範囲）", () => {
    expect(Recommender.uiWordNoteJa("半導体")).toContain("収録していません");
    expect(Recommender.uiWordNoteJa("主要会議")).toContain("『ランク』");
    expect(Recommender.uiWordNoteJa("月前半")).toContain("『上旬』");
    expect(Recommender.uiWordNoteJa("祝日 締切")).toContain("「祝日」");
    expect(対称差("生成AI", "generative"), "分野の寄せが壊れた").toBe(0);
    const 当たり = ["穴場", "土日", "上旬", "パリ", "東京"].filter((語) => 行列表(語).length > 0);
    expect(
      当たり.length,
      "当たりが検査の品書で全部 0 行（此処では何も見ていない）",
    ).toBeGreaterThan(0);
    expect(対称差("パリ", "paris"), "其の方の都市の寄せが壊れた").toBe(0);
  });
});

describe("成果物", () => {
  it("足した八つの条目が成果物の表に一度ずつ入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [日本語, 原文] of 開催地の寄せ) {
      const 断片 = `["${日本語}", "${原文}"]`;
      expect(rec.split(断片).length - 1, `成果物の中の条目 \`${断片}\` の数`).toBe(1);
    }
  });

  it("表の条目は、其の方の収録の催し物を行を増やさずに出す（寄せた語が別の行を作らない）", () => {
    /* 表その物を読む（第 297 回の手順 – 画面の語は画面の正本から読む）。此の回に足した条目が
     * 其の方の条目と並んでも壊れない事を見る – 語の順が違うだけの条目が在ると、後の物が影に
     * 隠れて検査から抜ける（第 353 回の実発生）。 */
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 頭 = "const PLACE_QUERY_ALIASES_JA = [";
    const i = rec.indexOf(頭);
    expect(i, "成果物に表が見つからない").toBeGreaterThan(0);
    const 本文 = rec.slice(i, rec.indexOf("];", i));
    for (const [日本語, 原文] of 開催地の寄せ) {
      const 出現 = 本文.split(`"${日本語}"`).length - 1;
      expect(出現, `表の中の \`${日本語}\` の語の出現数`).toBe(1);
      expect(本文, `表の条目が寄せ先の表記を忘れている: ${原文}`).toContain(`"${原文}"`);
    }
  });
});
