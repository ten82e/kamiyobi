/* 第 515 回 – 催しの**性質**を日本語で打たれた形（`国際` `国際会議` `国際学会`
 * `国際的な会議` `国際シンポジウム` `年次大会` `シンポジウム`）
 *
 * 実測（2026-11-12 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）。収録は催しの
 * 性質を**原文の英文字で**書くので、品書に「国際」の字面は一箇所も無い。其の為、日本で
 * 一番自然な頼み方が壁になつて居た:
 * `国際` **0 行** ⇔ "international" **452 行**・`国際会議` **0 行**・`国際学会` **0 行**
 * （案内も無し – 無言）・`国際的な会議` **0 行**・`国際シンポジウム` **0 行** ⇔
 * `international symposium` 25 行・`国際ワークショップ` **0 行** ⇔ 58 行・
 * `こくさい`（和仮名の侭）**0 行**・`國際`（旧字体）**0 行**・`年次` **0 行** ⇔ "annual"
 * 24 行・`シンポジウム` **3 行** ⇔ "symposium" 106 行（3 行は和名の行だけ – 第 232 回の
 * `ワークショップ` 74 行 → 126 行と同じ形）。`国際会議の締切` は助詞で一度割れるのに
 * 其の部の `国際会議` が 0 行で、**0 行で案内も無し**だつた。
 * 検証 – 実ビルドの worktree を 2 つ立てて 3 964 文（此の家族の繋げ方 70 文・寄せ表の語 ×
 * 全行の語 2 800 文・自然文 155 文・種別語など）で照合すると**行の減つた物 0 文・
 * 行の増えた物 370 文・不變 3 594 文**。家族 70 文は舊「行 3 / 案内 19 / 無言 48」→
 * 新「行 34 / 案内 0 / 無言 36」。
 *
 * 檢査は `builtSite()` の品書（435 行 – fixtures から立てる）で動くので、**絶対の行数は張らず**
 * 「寄せた語は其の方の英文字語を書く行と**一字も違わない**」「繋げた形は空格で並べた時（又は
 * 頭の語單體）と同じ行集合を返す」事を張る。
 *
 * 直しは上流の原文にしか出ない語を寄せる表（`querySynonymMap` の
 * `UPSTREAM_TEXT_QUERY_SYNONYMS_JA`）に並べただけで、**之以上の割りは作らない**（第 363 回・
 * 第 381 回と同じ決まり – 繋げたら何でも剥がす仕組みにして居ない）。寄せ先を括った語に
 * するのは其の方の決まりの侭（`international symposium` のやうに二語で繋がって書かれた物へ
 * 寄せる – 種別を名指す繋げ方を `国際` だけの 452 行に出会わせるのは頼み過ぎ）。
 *
 * 四つの門（寄せない物 – 檢査が其れを張る）:
 * - **`研究会` は "SIG" に寄せない** – 収録の `研究会` 23 行は和名の行（国内研究会）で、
 *   寄せると国内研究会とは別の行が黙つて増える（第 358 回）。
 * - **`国際研究会` は寄せない** – "international" を書く行に研究会の字面は 0 行（実測）で、
 *   寄せると無い行を作る。
 * - **`春季` `秋季` `夏季` `冬季` `グローバル` は寄せない** – "spring" 2 行・"global" 2 行と
 *   薄く、和名の行に掛ける語にならない（第 232 回の `panel` と同じ判断）。
 * - **全行の語の案内は其の侭通す** – `大会` は第 358 回の断りの案内が受ける（0 行の侭）。
 *
 * 残した差（実測して載せない – 次の回の種）:
 * - `国際研究会` `国際セッション` `国際的な学会` `AI国際会議` のやうに、寄せ語の頭にまだ
 *   別の語が繋がつた形は 0 行の侭（頭の語を剥ぐ仕組みは以て居ない – 上決まり）。
 * - `世界` `グローバル` は 0 行の侭（上の門）。*/
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

function 行列表(文: string): string[] {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return 全.filter((行) => 照合(行) === true);
}
function 件数(文: string): number {
  return 行列表(文).length;
}
/** 品書の字面で行を探す（寄せ先と**一字も違わない**事を張る為の基準）。 */
function 字面列(語: string): string[] {
  return 全.filter((行) => 行.indexOf(語) >= 0);
}
function 畫面の案内(文: string): string {
  return [
    Recommender.columnQueryNoteJa(文),
    Recommender.uiWordNoteJa(文),
    Recommender.dayRangeNoteJa(文),
    Recommender.wholeTableQueryNoteJa(文),
    ...(Recommender.relativeDayNotes(文, 基準) || []),
    ...Recommender.querySynonymNotes(文),
  ]
    .filter(Boolean)
    .map((案内) => String(案内).trim())
    .join(" ∥ ");
}

describe("『国際』を日本語で打つ人が原文の行に出会える", () => {
  it("寄せた語は原文の英文字語を書く行と一字も違わない", () => {
    for (const [打ち方, 原文] of [
      ["国際", "international"],
      ["年次", "annual"],
    ] as const) {
      expect(件数(打ち方), `\`${打ち方}\` が 0 行`).toBeGreaterThan(0);
      expect(行列表(打ち方).sort(), `\`${打ち方}\` の行集合が "${原文}" の行と違う`).toEqual(
        字面列(原文).sort(),
      );
    }
  });

  it("書き方を変へても同じ行に出会う（和仮名・旧字体・種別語を繋げた形）", () => {
    const 基 = 件数("国際");
    expect(基).toBeGreaterThan(0);
    for (const 打ち方 of [
      "こくさい",
      "國際",
      "国際的",
      "国際的な",
      "国際会議",
      "国際大会",
      "国際学会",
      "国際カンファレンス",
      "国際コンファレンス",
      "国際 会議",
      "国際 大会",
      "国際的な会議",
      "国際会議一覧",
      "国際会議一覧表",
      "こくさい会議",
      "国際会議の締め切り",
    ]) {
      expect(件数(打ち方), `\`${打ち方}\` が \`国際\` と同じ行を出さない`).toBe(基);
    }
  });

  it("助詞で一度割れた打ち方の部も、其侭の見出しで受ける（`国際会議の締切`）", () => {
    /* 第 514 回の語尾の割りは助詞で既に割れた部では走らない（第 513 回の案内が壊れる為）。
     * 其の為 `国際会議` は其侭の見出しを持つ – 持たせ無いと 0 行で無言に戻った（實測）。 */
    expect(件数("国際会議の締切"), "`国際会議の締切` が 0 行").toBeGreaterThan(0);
    expect(件数("国際会議の締切"), "空格で並べた時と行が違う").toBe(件数("国際会議 締切"));
    expect(件数("国際会議の締切"), "絞る前の語より広くなつた").toBeLessThanOrEqual(
      件数("国際会議"),
    );
    expect(件数("国際会議への参加"), "`国際会議への参加` が 0 行").toBeGreaterThan(0);
    expect(件数("国際学会の締切"), "`国際学会の締切` が 0 行").toBeGreaterThan(0);
  });

  it("種別を名指す繋げ方は、繋がって書かれた語に寄せる（452 行に広げない）", () => {
    for (const [打ち方, 原文] of [
      ["国際シンポジウム", "international symposium"],
      ["国際ワークショップ", "international workshop"],
    ] as const) {
      const 行 = 字面列(原文);
      expect(行.length, `品書に "${原文}" が無い（検査が空振り）`).toBeGreaterThan(0);
      const 打 = 行列表(打ち方);
      /* 第 675 回 – 搜しが並べ語を語ごとに數えるやうになつたので、其の方の語を離して書く行
       * （`international` と `workshop` を別々に書く行）も受ける – 連なりの集合は subset ✓。*/
      expect(
        行.filter((x) => !打.includes(x)),
        `\`${打ち方}\` が "${原文}" を連なりで書く行を落とした`,
      ).toEqual([]);
      const 語 = 原文.split(/\s+/);
      expect(
        打.filter((x) => !語.every((w) => x.includes(w))),
        `\`${打ち方}\` が語を揃へん行を拾つた`,
      ).toEqual([]);
      /* 其の方の語を名指さない行まで出さない（`国際` だけの寄せは頼み過ぎ）。 */
      expect(件数(打ち方), `\`${打ち方}\` が \`国際\` より広くなつた`).toBeLessThan(件数("国際"));
    }
    // 空格で並べる人は二語のかけ算（括った語より広い） – 其の方は其の方で通る。
    expect(件数("国際 シンポジウム"), "空格の打ち方が繋がれた形より狭い").toBeGreaterThanOrEqual(
      件数("国際シンポジウム"),
    );
  });

  it("『シンポジウム』は和名の行だけでなく英文字の会議名を持つ行にも届く", () => {
    expect(件数("シンポジウム"), "`シンポジウム` が 0 行").toBeGreaterThan(0);
    // 寄せは和集合なので、以前当たつて居た行は残る（第 232 回の `ワークショップ` と同じ）。
    expect(件数("シンポジウム")).toBeGreaterThanOrEqual(件数("symposium"));
    expect(字面列("symposium").length).toBeGreaterThan(0);
    expect(行列表("symposium").every((行) => 行列表("シンポジウム").indexOf(行) >= 0)).toBe(true);
  });
});

describe("案内（黙つた 0 件を直した事が畫面に出る）", () => {
  it("寄せた語は打ち込んだ語と原文の語を名指す", () => {
    for (const [打ち方, 原文] of [
      ["国際", "international"],
      ["こくさい", "international"],
      ["國際", "international"],
      ["国際学会", "international"],
      ["国際カンファレンス", "international"],
      ["国際シンポジウム", "international symposium"],
      ["国際ワークショップ", "international workshop"],
      ["年次", "annual"],
      ["シンポジウム", "symposium"],
    ] as const) {
      const 案内 = 畫面の案内(打ち方);
      expect(案内, `\`${打ち方}\` は無言`).toContain(打ち方);
      expect(案内, `\`${打ち方}\` の案内が原文の語を言っていない`).toContain(原文);
      expect(案内, `\`${打ち方}\` の案内が原文の語だと言っていない`).toContain("原文");
    }
  });

  it("全行の語を繋げた形は二つの案内が並ぶ（第 245 回・第 514 回との対）", () => {
    const 案内 = 畫面の案内("国際 会議");
    expect(案内).toContain("この表の全行にあてはまる語");
    expect(案内).toContain("international");
    expect(件数("国際 会議")).toBe(件数("国際"));
  });
});

describe("寄せない物（黙つて意味を広げない – 四つの門）", () => {
  it("`研究会` を『SIG』に寄せない（第 358 回）", () => {
    const 行 = 行列表("研究会");
    expect(行.length, "`研究会` が 0 行になつた").toBeGreaterThan(0);
    expect(
      行.every((hay) => hay.indexOf("研究会") >= 0),
      "`研究会` が『SIG』の行へ広がつた",
    ).toBe(true);
    expect(件数("研究会")).toBe(字面列("研究会").length);
  });

  it("`国際研究会` は寄せない（品書に無い行を作らない）", () => {
    expect(件数("国際研究会")).toBe(0);
    // 其の方の語單體は動く（寄せは `国際` の侭 – 頭の語を剥ぐ仕組みは以て居ない）。
    expect(件数("国際")).toBe(字面列("international").length);
  });

  it("`春季` `秋季` `夏季` `冬季` `グローバル` は薄い語へ寄せない（第 232 回の `panel`）", () => {
    for (const 打ち方 of ["春季", "秋季", "夏季", "冬季", "グローバル"]) {
      expect(件数(打ち方), `\`${打ち方}\` に行を作つた`).toBe(0);
    }
  });

  it("`大会` の断りの案内は其の侭（第 358 回 – 其の呼び方の催し物は収録に無い）", () => {
    expect(件数("大会")).toBe(0);
    expect(畫面の案内("大会")).toContain("では絞りません");
  });
});

describe("第 514 回以前の決まりを壊して居ない", () => {
  it("全行の語尾の割りは其の侭効く", () => {
    expect(件数("AI会議"), "`AI会議` が語尾の割りで落ちた").toBe(件数("AI"));
    expect(件数("セキュリティ会議")).toBe(件数("セキュリティ"));
    // `査読締切日` は fixtures に査読の行が無いので繋げた形と並べた形が同じ事を張る
    // （実ビルドでは 13 行 – 第 514 回の檢査が其の方を張る）。
    expect(件数("査読締切日"), "`査読締切日` が『査読 締切日』と違う").toBe(件数("査読 締切日"));
    expect(件数("AI締切日"), "`AI締切日` が『AI』と違う").toBe(件数("AI"));
    // 語その物が全行の語は割らない（第 239 回の打ち直しの案内が其の形で受ける）。
    expect(件数("締切一覧")).toBe(0);
    expect(畫面の案内("締切一覧")).toContain("では絞り込めません");
  });

  it("`国内会議` の『国内』への寄せは其の侭", () => {
    expect(件数("国内会議"), "`国内会議` が『国内』の行を出さない").toBeGreaterThan(0);
    expect(件数("国内会議")).toBe(件数("国内"));
    expect(畫面の案内("国内会議")).toContain("国内");
    // 国内と国際は別の頼み方 – 一方が他方に化けない。
    expect(行列表("国内会議").some((行) => 行列表("国際").indexOf(行) >= 0)).toBe(false);
  });

  it("磁石の決まりは其の侭默つている（第 505 回）", () => {
    for (const 打ち方 of ["費用対効果分析", "リアルタイム処理", "メジャーな学会", "対面について"]) {
      expect(件数(打ち方), `\`${打ち方}\` に行を作つた`).toBe(0);
      expect(畫面の案内(打ち方), `\`${打ち方}\` に案内を出した`).toBe("");
    }
  });

  it("寄せ表の語を繋いだ形（第 381 回）は其の侭", () => {
    expect(件数("ショートペーパー"), "`ショートペーパー` が 0 行に戻つた").toBeGreaterThan(0);
    expect(件数("ショートペーパー")).toBeLessThanOrEqual(件数("short"));
  });
});

describe("ビルドの組み込み", () => {
  it("寄せ語の条目は二重に置いて居ない（正本は一つ）", () => {
    const 品 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [見出し, 回] of [
      ['["国際", "原文の international という語", ["international"]]', 1],
      ['["国際会議", "原文の international という語", ["international"]]', 1],
      ['["年次", "原文の annual という語", ["annual"]]', 1],
      ['["シンポジウム", "原文の symposium という語", ["symposium"]]', 1],
      [
        '["国際シンポジウム", "原文の international symposium という語", ["international symposium"]]',
        1,
      ],
    ] as const) {
      let 数 = 0;
      let 所 = 品.indexOf(見出し);
      while (所 >= 0) {
        数 += 1;
        所 = 品.indexOf(見出し, 所 + 1);
      }
      expect(数, `組み込みに \`${見出し}\` が ${数} 本並んだ`).toBe(回);
    }
  });

  it("打ち方の語を品書の字面に足して居ない（行を作って居ない）", () => {
    expect(字面列("国際").length, "品書に『国際』の字面を足した").toBe(0);
    expect(字面列("年次").length, "品書に『年次』の字面を足した").toBe(0);
  });
});
