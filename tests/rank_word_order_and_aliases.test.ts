/* 第 509 回 – 行の『ランク』を**逆の語順**で繋いだ形（`ランクA` `ランクB` `ランクA*`）と、格・參加形式の別名
 *
 * 実測（2026-11-10 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）。正準の語順は欄のランクで
 * 絞れる（`Aランク` 275 件・`Bランク` 254 件・`Cランク` 155 件・`A*ランク` 150 件）のに、
 * **語順を逆にした打ち手は 0 件で案内も無かつた** – `ランクA` 0・`ランクB` 0・`ランクC` 0・
 * `ランクA*` 0・`ランクa` 0・`ランクＢ`（全角）0。空格で離した形（`ランク A` 303 件）は通るが、
 * それは字面の重なりで他のの語中の “A” も拾つた數で、欄の值で絞つた形とは 28 件違う（実測で対称差）。
 *
 * 直しは語順を正準へ直す – `ランクA` → `Aランク`。其れで行集合は**正準の語順と完全に同じ**になる
 *（実測で対称差 0 – 六対）。既に解けて居る打ち方には触れない（逆語順は舊 0 件だつた為、増える一側のみ）。
 * 「格の語を欄の値に寄せない」といふ収録の契約（`collapseRelativeDayPhrase` に格の語が現れない事を
 * 張る検査が在る – 第 509 回でその文面にも触れた）とは別物で、此處は**同じ表現の語順だけ**を直す。
 *
 * 同じ回に、二つの群に別名を足した（其れ等で行が 0 件で、案内の本文が其の打ち方でも真な物だけ）:
 * - 格の群: `上位` `上位の会議` `上位会議` `格付け` `レベル` `グレード` `ランク付け`
 *   （実測で 0 件かつ完全に無言。案内は「 evaluation は行の『ランク』に在て、其の語では絞れません。
 *   欄で選んでください」で、別名でも同じ話が通る）
 * - 參加形式の群: `ブレンデッド` `ブレンド` `混合` `混在` `併用` `オンライン併用` `対面とオンライン`
 *   （其れ等の語は行の文本に一度も現れない – 実測 0 行 – ので「この表は參加形式の印として
 *   『オンライン参加可』だけを出す」といふ斷りは同樣に真）*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 集(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 対称差(左: string, 右: string): number {
  const A = 集(左),
    B = 集(右);
  return [...A].filter((行) => !B.has(行)).length + [...B].filter((行) => !A.has(行)).length;
}
function 案内(文: string) {
  return (Recommender.uiWordNoteJa(文) || "").trim();
}

describe("行の『ランク』を逆の語順で繋いだ形が正準と同じ行に出る（第 509 回）", () => {
  it("六対 – 語順を直すだけなので行集合は完全に同じ", () => {
    for (const [逆, 正] of [
      ["ランクA", "Aランク"],
      ["ランクB", "Bランク"],
      ["ランクC", "Cランク"],
      ["ランクA*", "A*ランク"],
      ["ランクa", "aランク"],
      ["ランクＢ", "Bランク"],
    ] as Array<[string, string]>) {
      expect([逆, 対称差(逆, 正)], `「${逆}」が「${正}」と違ふ`).toEqual([逆, 0]);
    }
    /* 検査用ビルドで 0 件にならぬ例も張る（実ビルドでは 275 件 – `Aランク` と同じ）。*/
    expect(集("ランクA").size).toBe(3);
    /* 語が后续く形も同じ（実ビルド `ランクAの締切` 193 件 = `Aランクの締切`）。*/
    expect(対称差("ランクAの締切", "Aランクの締切")).toBe(0);
    expect(対称差("HPC ランクA", "HPC Aランク")).toBe(0);
  });
  it("既に解けて居る形と、かなが続く形は触らない", () => {
    /* `ランク A`（離し形）は字面の重なりで 28 件多い（実測 – 寄せない決まりを張る）。*/
    expect(対称差("ランク A", "Aランク")).toBeGreaterThan(0);
    /* `ランキング` `ランク付け` `ランクで絞る` はかななので目に触れず、案内の側が應える。*/
    for (const 文 of ["ランキング", "ランク付け", "上位の会議"]) {
      expect(案内(文), `「${文}」の案内が消えた`).toContain("この表は催し物の評価を行の『ランク』");
      expect(集(文).size).toBe(0);
    }
    expect(案内("ランクで絞る")).toBe("");
    /* 行が出る語を格の別名に混ぜてはならぬ – 「其の語では絞れません」が噓になる爲（第 337 回）。
       實測 `評価` 476 件・`格` で絞る道は『ランク』欄。*/
    expect(集("評価").size).toBeGreaterThan(0);
    expect(案内("評価"), "行が出る語に格の案内を當てた").toBe("");
    expect(集("ランク").size).toBe(435);
  });
  it("格の別名 – 無言の 0 件が打ち直しを言う", () => {
    for (const 文 of ["上位", "上位の会議", "上位会議", "格付け", "レベル", "グレード"]) {
      const 説 = 案内(文);
      expect(説 !== "", `「${文}」は無言だつた（黙つて 0 件）`).toBe(true);
      expect(説).toContain("この表は催し物の評価を行の『ランク』");
      expect(説, `「${文}」の案内が打たれた語を名乗つて居ない`).toContain(`「${文}」`);
      expect(集(文).size, `「${文}」で行が出た`).toBe(0);
    }
  });
  it("參加形式の別名 – 同じ斷りが通る", () => {
    for (const 文 of [
      "ブレンデッド",
      "ブレンド",
      "混合",
      "混在",
      "併用",
      "オンライン併用",
      "対面とオンライン",
    ]) {
      const 説 = 案内(文);
      expect(説 !== "", `「${文}」は無言だつた`).toBe(true);
      expect(説, `「${文}」の案内が參加形式の話をしない`).toContain("参加形式");
      expect(説, `「${文}」の案内が打たれた語を名乗つて居ない`).toContain(`「${文}」`);
      expect(集(文).size, `「${文}」で行が出た`).toBe(0);
    }
    /* 其れ等の語は行の文本に一度も現れない（噓にならない為の確認 – 第 337 回）。*/
    expect(全.filter((行) => /混合|併用|混在|ブレンド|ブレンデッド/.test(行)).length).toBe(0);
    /* 其の方で解ける語は触つて居ない（`ハイブリッド` は行が出る）。*/
    expect(集("オンライン参加可").size).toBe(20);
  });
  it("第 470 回〜第 508 回の実測は此の回で変へて居ない", () => {
    expect(集("年内").size).toBe(424);
    expect(集("今年内").size).toBe(426);
    expect(集("再来週内").size).toBe(18);
    expect(集("年末中").size).toBe(84);
    expect(集("年初1月").size).toBe(23);
    expect(集("来月 末日").size).toBe(178);
    expect(集("週 末").size).toBe(145);
    expect(集("締切時刻").size).toBe(180);
    expect(集("ml から").size).toBe(0);
    expect(集("オンラインの締切").size).toBe(20);
    expect(集("ISC-A").size).toBe(0);
    expect(集("SC27").size).toBeGreaterThan(0);
    expect(案内("当面の締切")).toContain("曖昧な幅では絞り込めません");
    expect(案内("費用対効果分析")).toBe("");
    expect(案内("印刷 関西")).toBe("");
    expect((Recommender.columnQueryNoteJa("分野 セキュリティ") || "").trim()).toContain(
      "「分野」は",
    );
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("語順を直す目と別名が現れ、格の語の寄せ（契約で禁じられた方）は増えて居ない", () => {
    expect(物).toContain("ランク([A-Za-zＡ-Ｚａ-ｚ][A-Za-zＡ-ｚ]*[*＊]?)");
    expect(物).toContain('"$1$2ランク"');
    expect(物).toContain('"ランク付け"');
    expect(物).toContain('"ブレンデッド"');
    const 関数 = 物.slice(物.indexOf("function collapseRelativeDayPhrase"));
    const 本体 = 関数.slice(0, 関数.indexOf("\n  }"));
    for (const 語 of ["主要", "メジャー", "ハイクラス", "一流", "ランキング"]) {
      expect(本体, `寄せの目に格の語 \`${語}\` が入つた（収録の契約）`).not.toContain(語);
    }
  });
});
