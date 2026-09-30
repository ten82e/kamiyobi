import { readFileSync } from "node:fs";
import { join } from "node:path";
/** 英語の機械語とバリアフリーを訪ねる打ち方の檢査（SPEC §7・第 525 回）。 */
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

/** 第 527 回 – 訪ね方だけでは決まる打ち方と、日付の欄の訪ね方。 */
const ただ斷り = [
  "日付",
  "スケジュール",
  "知りたい",
  "教えて",
  "何か教えて",
  "詳細を教えて",
  "どのくらい",
  "わかります",
  "分かる",
  "わかる",
];

import { builtSite } from "./built_site.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 件(rows: Row[], 文: string): number {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).length;
}
function 案内(語: string): string {
  return [
    Recommender.columnQueryNoteJa(語),
    Recommender.uiWordNoteJa(語),
    Recommender.dayRangeNoteJa(語),
    Recommender.wholeTableQueryNoteJa(語),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ");
}

/** 表が持つ欄の外のこと – 寄せない語（第 518 回・第 525 回の決まり）。
 * 分野『システム』『機械学習』へ寄せると實測で 256 件・542 件に靜かに廣がるので彈いた
 *（第 525 回 – 自分は之を足さうとして四本の檢査に止められた。教訓は SPEC §8 の同條に置く）。*/
const 寄せない = ["GPU", "CUDA", "Kubernetes", "CTF", "推薦システム", "レコメンド"];

/** 0 件の侭斷りが出る打ち方（會場の費用・バリアフリー・子の預け先 – 第 525 回・第 526 回）。 */
const 訪ね = [
  "アクセシビリティ",
  "バリアフリー",
  "車椅子",
  "車いす",
  "手話",
  "字幕",
  "accessibility",
  "wheelchair",
  "会場費",
  "懇親会費",
  // 第 526 回 – 子の預け先と介助访ね（實測で品書 0 行の語だけ入れた）。
  "託児",
  "授乳室",
  "子連れ",
  "子ども同伴",
  "介助者",
  "手話通訳",
  "バリアフリー対応",
  "障害者",
  "障がい者",
  "介護",
];

describe("英語の機械語とバリアフリー", () => {
  it("英語の機械語は寄せない – 0 件の侭（靜かに廣げない決まり）", () => {
    const rows = 品書();
    寄せない.forEach((文) => {
      expect(件(rows, 文), `"${文}" に行が届いた（分野への寄せは數百件の廣がり）`).toBe(0);
    });
  });

  it("其の他で行が 0 件の時だけ斷る（其の方で行が出る語を入れない – 第 337 回）", () => {
    const rows = 品書();
    訪ね.forEach((文) => {
      expect(件(rows, 文), `"${文}" が行に出る（斷るのは噓になる）`).toBe(0);
      const t = 案内(文);
      expect(t.length, `"${文}" が無言`).toBeGreaterThan(0);
      expect(t.includes("持っていません"), `"${文}": 欄が無いと斷つて居ない`).toBe(true);
      expect(t.includes(文), `"${文}": 打ち込まれた語を名乘つて居ない`).toBe(true);
    });
  });

  it("訪ね方だけ・日付の欄の打ち方が斷りに就く（第 527 回）", () => {
    const rows = 品書();
    ただ斷り.forEach((文) => {
      expect(件(rows, 文), `"${文}" が行に出る（斷るのは噓になる）`).toBe(0);
      const t = 案内(文);
      expect(t.length, `"${文}" が無言`).toBeGreaterThan(0);
      expect(t.includes(文), `"${文}": 打ち込まれた語を名乘つて居ない`).toBe(true);
    });
    expect(案内("知りたい").includes("締切はいつ"), "`知りたい` に例を示して居ない").toBe(true);
    expect(案内("日付").includes("論文締切"), "`日付` に種別の例を示して居ない").toBe(true);
  });

  it("其の方で行が出る語を二つの新群に混ぜない（第 337 回）", () => {
    const b = readFileSync("site/recommender.ts", "utf8");
    for (const 語 of ["日程", "締切日", "いつですか"]) {
      const i = b.indexOf('note: "はこの表の日付の欄の名前です');
      const j = b.indexOf('note: "だけでは、何を訪ねるか決まりません');
      const 域 = b.slice(b.lastIndexOf("words: [", i), b.indexOf("];", j));
      expect(域.includes(`"${語}"`), `"${語}" を新群に混ぜた（行が出る語）`).toBe(false);
    }
  });

  it("寄せの先は品書に實在する語（第 322 回）", () => {
    const rows = 品書();
    ["システム", "セキュリティ", "機械学習"].forEach((語) => {
      expect(件(rows, 語), `寄せ先の "${語}" が品書に無い`).toBeGreaterThan(0);
    });
  });

  describe("聞こえ方・見え方と配膳の申し出、當日の進行の打ち方（第 597 回）", () => {
    // 同じ檔案の module 級の 品書()/件() を使う（書き寫すと正本とズレる – 第 244 回）。

    it("聽覚・視覚・食事の打ち方がアクセシビリティの斷りを受ける", () => {
      const rows = 品書();
      for (const 語 of ["聴覚障害", "視覚障害", "食物アレルギー", "アレルギー", "ハラル"]) {
        const 群の注 = Recommender.uiWordNoteJa(語);
        expect(群の注.length, 語).toBeGreaterThan(0);
        expect(群の注, 語).toContain(語);
        expect(群の注, 語).toContain("公式ページ");
        expect(件(rows, 語), `${語} は行を持つのに敎へて居らん事（第 337 回）`).toBe(0);
      }
      /* 斷りの文に配膳の話を增やした事（噓を書かん – 第 519 回）。 */
      expect(Recommender.uiWordNoteJa("車椅子")).toContain("食事の申し出");
    });

    it("當日の進行と名簿の打ち方が運營と手続きの斷りを受ける", () => {
      const rows = 品書();
      for (const 語 of ["途中参加", "途中退出", "遅刻", "名簿", "参加者一覧", "スライド公開"]) {
        const 群の注 = Recommender.uiWordNoteJa(語);
        expect(群の注.length, 語).toBeGreaterThan(0);
        expect(群の注, 語).toContain("運営と手続き");
        expect(件(rows, 語), 語).toBe(0);
      }
      expect(Recommender.uiWordNoteJa("録画配信")).toContain("運営と手続き");
      /* 「服装」を待つて居た群（會場の中と外）に「ドレスコード」も據へた – 手続きより會場の話（第 597 回）。 */
      for (const 語 of ["ドレスコード", "服装"]) {
        const 注 = Recommender.uiWordNoteJa(語);
        expect(注, 語).toContain("会場の中と外");
        expect(件(品書(), 語), `${語} は行を持つのに敎へて居らん事（第 337 回）`).toBe(0);
      }
    });

    it("枠の打ち方が數の統計の斷りを受ける", () => {
      for (const 語 of ["募集枠", "枠数"]) {
        expect(Recommender.uiWordNoteJa(語), 語).toContain("数の統計");
      }
      /* 同じ語を二つの群に載せたら斷りの文が先取りされる（第 543 回） – 定員は其の群の侭。 */
      expect(Recommender.uiWordNoteJa("定員")).toContain("定員");
    });
  });
});
