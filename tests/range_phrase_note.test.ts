/**
 * 期間の言い方の検査（SPEC §4・§7・第 339 回）。
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `当面` `しばらく` `近いうち` `直近` `間もなく` `早め` `締切の近い` `いつまで` と
 * `1か月以内` `2か月以内` `3か月以内` `3ヶ月以内` `1年以内` `2年以内` は **すべて 0 行で、
 * 件数欄の案内も読み上げも無かった**（`uiWordNoteJa`・`relativeDayNotes`・`querySynonymNotes`
 * の三つの出入口で共に空 – 第 337 回の教訓どおり全部で測った）。週（`3週間以内` 154 行）と
 * 日数（`90日以内` 593 行）は効くので、**か月・年と曖昧な言い方だけが画面の日数の絞り込みへ
 * 届いていなかった**。
 * か月・年を日数の語へ寄せない判断（第 318 回 – 暦の 1 か月は 28〜31 日で変わる）は保ち、
 * 寄せない理由と代わりの形を書く。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 画面(): string {
  return readFileSync(join(builtSite(), "index.html"), "utf8");
}

function 行数(語: string, 基準日: number = 基準): number {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
  const matches = Recommender.searchMatcher(語, 基準日);
  return rows.filter((row) => matches(String(row.hay)) === true).length;
}

function 件数欄の案内(語: string, 基準日: number = 基準): string {
  return `${Recommender.uiWordNoteJa(語)} ${Recommender.relativeDayNotes(語, 基準日).join(" ")}`;
}

/** 画面の日数の絞り込みの実在する選択肢（`<select id="win">`）。案内が名指して良い物の正本。 */
function 締切までの選択肢(): string[] {
  const html = 画面();
  const select = /<select[^>]*id="win"[^>]*>[\s\S]{0,600}?<\/select>/.exec(html);
  if (!select) return [];
  return [...String(select[0]).matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) =>
    String(m[1]).trim(),
  );
}

describe("曖昧な期間の言い方", () => {
  it("`当面` `しばらく` `直近` は画面の日数の欄へ導く", () => {
    const 語列表 = [
      "当面",
      "しばらく",
      "近いうち",
      "近い内",
      "直近",
      "間もなく",
      "早め",
      "締切の近い",
      "いつまで",
    ];
    const 選択肢 = 締切までの選択肢();
    /* 検査自身の前提: 画面に日数の絞り込みが実在する（第 338 回と同じ形 – 在らない欄へ送らない）。 */
    expect(選択肢.length, "『締切まで』の選択肢が読めない").toBeGreaterThanOrEqual(4);
    語列表.forEach((語) => {
      expect(行数(語), `"${語}" を受けてしまった（案内の前提が崩れた）`).toBe(0);
      const 文 = 件数欄の案内(語);
      expect(文.trim(), `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 打たれた語を書いていない`).toContain(語);
      expect(文, `"${語}": 『締切まで』の欄を名指さない`).toContain("締切まで");
      /* 案内が書く選択肢は、画面に実在する物だけ。 */
      ["7 日以内", "30 日以内", "90 日以内", "180 日以内"].forEach((見出し) => {
        expect(選択肢, `案内が名指す『${見出し}』が画面の選択肢に無い`).toContain(見出し);
        expect(文, `"${語}": 選択肢『${見出し}』を書いていない`).toContain(見出し);
      });
      /* この欄は締切日からの日数 – 会期の長さと取り違えない事を言う（`<select>` の title と同じ事）。 */
      expect(文, `"${語}": 会期の長さでないと書かない`).toContain("会期の長さ");
      expect(画面(), "欄の title が締切日からの日数と言わなくなった").toContain(
        "締切日からの日数で絞ります",
      );
    });
  });

  it("行が出る期間の言い方を曖昧な側に混ぜない（`来週` `30日以内` `来月以降`）", () => {
    ["来週", "30日以内", "来月以降", "今週中"].forEach((語) => {
      expect(行数(語), `"${語}" が 0 行になった（前提が変わった）`).toBeGreaterThan(0);
      expect(Recommender.uiWordNoteJa(語), `"${語}" に曖昧な案内を立てた`).toBe("");
    });
  });

  it("『以降』の言い方に案内を二重に立てない（既存の解答が在る）", () => {
    /* `明日以降` `来週以降` は第 328 回から `relativeDayNotes` が解いている – 同じ事に別の
     * 案内を足して二重にしない（件数欄に同じ話が出ると、どちらを信じるか分からなくなる）。 */
    ["明日以降", "来週以降", "来週から", "今週以降"].forEach((語) => {
      expect(Recommender.uiWordNoteJa(語), `"${語}" に案内を重ねた`).toBe("");
    });
    /* 第 475 回で `以降` を続ける形は幅で絞れるので件の数欄の解答は要らない（行が出る – 実測
     * 422 件）。案内が残るのは `から` を付けた形だけ（其の方は幅の区切りでもあるので寄せない）。*/
    ["明日以降", "来週以降", "今週以降"].forEach((語) => {
      expect(Recommender.relativeDayNotes(語, 基準), `"${語}" に解答が残つた`).toEqual([]);
    });
    expect(Recommender.relativeDayNotes("来週から", 基準).join("")).toContain("以降のこと");
    /* 基準日が変わると『明日以降』と『来週以降』は違う日付 – 日曜の基準では此れらが重なるので、
     * 水曜の基準で潰れていない事を見る（固定時刻のビルドだけでは見えない穴 – 第 339 回）。 */
    const 水曜 = Date.parse("2026-08-12T00:00:00Z");
    /* 案内が残る `から` の形で見る – 基準日が変わると『明日から』と『来週から』は違う日付で、
     * 水曜の基準では此れらが重なるので、日曜の基準で潰れていない事を見る（第 339 回と同じ目）。*/
    const 明日 = Recommender.relativeDayNotes("明日から", 水曜).join("");
    const 来週 = Recommender.relativeDayNotes("来週から", 水曜).join("");
    expect(明日).toContain("2026年8月13日");
    expect(来週).toContain("2026年8月17日");
    /* 其の方の日の行が其のまま違う事 – 案内が消えても幅は別の日に解れて居る（第 475 回）。*/
    expect(行数("明日以降", 水曜), "水曜基準で『明日以降』の行が消えた").toBeGreaterThan(0);
    expect(行数("来週以降", 水曜), "水曜基準で『来週以降』の行が消えた").toBeGreaterThan(0);
    expect(行数("明日以降", 水曜)).not.toBe(行数("来週以降", 水曜));
    expect(明日).not.toBe(来週);
  });
});

describe("か月・年の範囲の言い方", () => {
  it("寄せないが、黙って 0 件にしない – 欄と代わりの形を書く", () => {
    ["1か月以内", "2か月以内", "3か月以内", "3ヶ月以内", "1年以内"].forEach((語) => {
      /* 日数の語へ寄せていない（暦のか月は 28〜31 日で変わる – 第 318 回の判断）。 */
      expect(行数(語), `"${語}" を受けてしまった（寄せた）`).toBe(0);
      const 文 = Recommender.relativeDayNotes(語, 基準).join("");
      expect(文, `"${語}" に何も言わない`).not.toBe("");
      expect(文, `"${語}": 打たれた語を書いていない`).toContain(語);
      expect(文, `"${語}": 暦の幅で絞る欄が無いと言わない`).toContain("暦の");
      /* 換えない理由（暦のか月は長さが変わる）を隠さない – 90 日と 3 か月が同じだと読ませない。 */
      expect(文, `"${語}": か月の長さが変わる事を隠した`).toContain("28〜31");
      /* 換えているとは言わせない（寄せた readings は 0 行のままである事と組で見る）。 */
      expect(文, `"${語}": 換えたと言っている`).toContain("換えません");
      expect(文, `"${語}": 『締切まで』の欄を名指さない`).toContain("締切まで");
      /* 案内が教える日数の語が、本当に効く事（嘘の案内を pins しない – 第 336 回の教訓）。 */
      const 例 = /『([0-9]{1,3}日以内)』/.exec(文);
      expect(例, `"${語}": 日数の語の例を書かない`).not.toBeNull();
      expect(
        行数(String((例 as RegExpExecArray)[1])),
        `"${語}": 教えた ${String((例 as RegExpExecArray)[1])} が効かない`,
      ).toBeGreaterThan(0);
    });
  });

  it("暦のか月を日数に換えない（`3か月以内` は `90日以内` と同じ行を出さない）", () => {
    /* 寄せたなら行集合は一致する – 寄せていないので違う（不一致を保つ事自体が噓の防止）。 */
    expect(行数("3か月以内")).toBe(0);
    expect(行数("90日以内")).toBeGreaterThan(0);
  });

  it("1 年より長い幅は日数の語の外だと書く（上限を隠さない）", () => {
    /* 実測: `365日以内` は品書全体を覆うが `366日以内` は 0 行（展開の上限）–
     * なので『2年以内』に日数の例を出してはならない。 */
    expect(行数("365日以内")).toBeGreaterThan(行数("366日以内"));
    expect(行数("366日以内"), "上限が変わった（案内の前提を見直す）").toBe(0);
    const 文 = Recommender.relativeDayNotes("2年以内", 基準).join("");
    expect(文).toContain("365 日まで");
    expect(文, "上限の内の日数の例を教えてしまった").not.toContain("『730日以内』");
    /* 代わりに書く暦の語が効く事。 */
    expect(文).toContain("来年");
    expect(行数("来年"), "案内が名指す『来年』が効かない").toBeGreaterThan(0);
  });

  it("効いている言い方（週・半年）の解答を変えない", () => {
    const 週 = Recommender.relativeDayNotes("3週間以内", 基準).join("");
    expect(週).toContain("21日以内");
    expect(行数("3週間以内")).toBe(行数("21日以内"));
    const 半年 = Recommender.relativeDayNotes("半年以内", 基準).join("");
    expect(半年).toContain("180 日以内");
    expect(行数("半年以内")).toBeGreaterThan(0);
  });

  it("成果物が二つの案内を持つ（第 339 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 断片列表: Array<[RegExp, string]> = [
      [/という曖昧な幅では絞り込めません/, "曖昧な期間の案内"],
      [/の幅で絞る欄がありません/, "か月・年の範囲の案内"],
      [/"当面"|"しばらく"|"締切の近い"/, "曖昧な期間の語"],
    ];
    断片列表.forEach(([形, 名前]) => {
      expect(形.test(rec), `組み立てた画面から ${名前} が消えた`).toBe(true);
    });
  });
});
