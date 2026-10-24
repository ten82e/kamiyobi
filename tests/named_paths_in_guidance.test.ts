import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
const 畫面 = [join(builtSite(), "app.js"), join(builtSite(), "index.html")].map((f) =>
  readFileSync(f, "utf8"),
);

function 收錄(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
  ) as Row[];
}

function 当たり(打ち方: string): number {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(打ち方, AT), AT);
  return 收錄().filter((r) => m(String(r.hay)) === true).length;
}

/** 画面が立てる讓り（app.ts と同じ順 – 列訪ね → 羣 → 日数 → 全行）。 */
function 讓り(打ち方: string): string {
  /* app.ts と同じ入力 – 「その値が行に当たるか」を渡す（渡さんはぐつかの讓りが立たない – 実測）。*/
  const 列 = String(Recommender.columnQueryNoteJa(打ち方, (語: string) => 当たり(語) > 0) || "");
  if (列) return 列;
  const 羣 = String(Recommender.uiWordNoteJa(打ち方, false) || "");
  if (羣) return 羣;
  return (
    String(Recommender.dayRangeNoteJa(打ち方) || "") +
    String(Recommender.wholeTableQueryNoteJa(打ち方) || "")
  );
}

/** 羣の斷り・読み上げが名指す『…』を数へる。 */
function 名指し(): Map<string, string> {
  const 始 = 源.indexOf("const UI_WORD_GROUPS_JA");
  const 本 = 源.slice(始, 源.indexOf("\n  ];", 始));
  const 出 = new Map<string, string>();
  for (const m of 本.matchAll(/(note|live):\s*"((?:[^"\\]|\\.)*)"/g)) {
    for (const q of m[2].matchAll(/『([^』]{2,26})』/g)) if (!出.has(q[1])) 出.set(q[1], m[1]);
  }
  return 出;
}

/** 語尾の表（`剥ぐ語尾`）を源から読む。 */
function 語尾の一覽(): string[] {
  const i = 源.indexOf("const 剥ぐ語尾 = [");
  expect(i, "語尾の表が見つからん").toBeGreaterThan(0);
  const 本 = 源.slice(i, 源.indexOf("\n    ];", i));
  const 尾 = [...本.matchAll(/^\s{6}"([^"]+)",$/gm)].map((m) => m[1]);
  expect(尾.length, "語尾が読めとれる").toBeGreaterThan(0);
  return 尾;
}

/** 欄の名前と、其に屆く打ち方の語（`COLUMN_QUERY_WORDS_JA`）。 */
function 欄の語の一覽(): Set<string> {
  const i = 源.indexOf("const COLUMN_QUERY_WORDS_JA");
  const 本 = 源.slice(i, 源.indexOf("\n  ];", i));
  const 出 = new Set<string>();
  for (const m of 本.matchAll(/\["([^"]+)", "([^"]+)"\]/g)) {
    出.add(m[1].toLowerCase());
    出.add(m[2].toLowerCase());
  }
  return 出;
}

/** `columnQueryEntry` の中の同じ筋を再現する – 六度まで、当た最初の語尾を後ろから剥ぐ。 */
function 剥いだ(語: string, 尾: string[]): string {
  let 残 = 語.toLowerCase();
  for (let i = 0; i < 6; i += 1) {
    const 次 = 尾.find((t) => 残.length > t.length && 残.endsWith(t));
    if (!次) break;
    残 = 残.slice(0, 残.length - [...次].length);
  }
  return 残;
}

describe("案内が名指す道は本物か（第 652 回）", () => {
  it("全羣が名指す物を 100 種以上数える（目が細つたら落ちる）", () => {
    const 名 = 名指し();
    expect(名.size, "読める名が少なすぎる").toBeGreaterThanOrEqual(100);
  });

  it("名指した物は画面の実物か、打てば行が出るか、打てば讓りが立つ（切れていたら噓）", () => {
    const 切 = [...名指し().keys()].filter((名) => {
      const 素 = 名.replace(/（[^）]*）/g, "").trim();
      if (!素 || 素.length < 2) return false;
      if (畫面.some((本) => 本.includes(素))) return false; /* 画面にその物がある */
      if (当たり(素) > 0) return false; /* 打つと行が出る */
      return 讓り(素).trim() === ""; /* 打つと讓りが立つ */
    });
    expect(
      切.map((名) => `『${名}』`).join("・"),
      "案内が名指す道が切れている（その通りに打つも何も出ん – 第 338 回と同じ形）",
    ).toBe("");
  });

  it("『会場はどこ』『年末年始』は 0 行だが讓りが立つ（第 652 回に開いた・事実として張る）", () => {
    for (const 打ち方 of ["会場はどこ", "年末年始"]) {
      expect(当たり(打ち方), `"${打ち方}" に行が出るやうになつた`).toBe(0);
      expect(讓り(打ち方).trim(), `「${打ち方}」の讓りが消えた`).not.toBe("");
    }
  });

  it("『欄はどこ？』『どの国で開催？』の聽き方を通した（第 652・653 回）", () => {
    const 始 = 源.indexOf("const 剥ぐ語尾 = [");
    const 尾 = 源.slice(始, 源.indexOf("\n      ];", 始));
    const 受入 = new Set([...尾.matchAll(/^\s{6}"([^"]+)",$/gm)].map((m) => m[1]));
    for (const 語尾 of ["はどこ", "はどちら"]) {
      expect(受入.has(語尾), `語尾「${語尾}」が消えた（五つの打ち手が默る）`).toBe(true);
    }
    const 家 = new Map<string, string>();
    for (const 打ち方 of [
      "会場はどこ",
      "会場はどちら",
      "参加形式はどこ",
      "地域はどこ",
      "分野はどこ",
      "開催場所は",
      /* 第 652 回に欄の語へ別名として足した物（その方を置かんと黙る – 語の表は完全一致の為）。*/
      "会場名はどこ",
      "開催都市はどこ",
      /* 第 653 回 – 「どの国で開催？」といきさつの語を付けた聽き方（語尾に「で開催」を足し、
       * 「どの国」「どの都市」を欄の語に置いた）。*/
      "どの国で開催",
      "どの国で開催ですか",
      "どの都市で開催",
      "どこの国で開催されます",
      "どの地域で開催",
      "どの国",
      "どこの都市",
      /* 第 654 回 – 「〜されますか」「何ですか」の聽き方（「ますか」が先に見えると残りが欄の
       * 名前にならなんだ – 実測 `どの国で開催されますか` が黙つていた）。*/
      "どの国で開催されますか",
      "どの都市で開催されますか",
      "どこの国で開催されますか",
      "分野は何ですか",
      "地域は何ですか",
      "種別はどれですか",
      "開催地は何ですか",
      "会場はどちらですか",
      /* 第 655 回 – 語尾の表を**長き順**に並べ直して開いた形（「ますか」が「ありますか」より先に
       * 在つた為、23 組が黙つていた）。*/
      "会場ありますか",
      "分野ありますか",
      "テーマありますか",
      "参加形式ありますか",
      "どこの国にありますか",
    ]) {
      const 讓 = 讓り(打ち方);
      expect(讓, `「${打ち方}」が默つた`).not.toBe("");
      家.set(打ち方, 讓.includes("欄") ? "欄" : 讓.includes("チップ") ? "チップ" : "未分類");
    }
    expect(
      [...家.values()].filter((v) => v === "欄").length,
      "列訪ねの家に屆いた打ち手が少ない（その方が欄の名前を受ける形）",
    ).toBe(28);
  });

  it("場所の聽き方で残つた黙りは事実として張る（第 653 回 – 直らん内を隱さん）", () => {
    const 默 = [
      "地域で並べると",
      "会場へのアクセス",
      "オンラインはどこ",
      "いつ締切られますか",
      "いつ届きますか",
    ];
    for (const 打ち方 of 默) {
      expect(讓り(打ち方).trim(), `「${打ち方}」が立つやうになつた（この條を張り替へよ）`).toBe("");
      expect(当たり(打ち方), `「${打ち方}」に行が出るやうになつた`).toBe(0);
    }
  });

  it("語尾の表は長き順に並んでいる（順を崩せば長い形が剥げん – 第 655 回）", () => {
    const 尾 = 語尾の一覽();
    expect(尾.length, "語尾の本数が読めとれる").toBeGreaterThanOrEqual(40);
    const 崩 = 尾
      .map((語尾, i) => [語尾, 尾[i + 1]] as [string, string | undefined])
      .filter(([前, 後]) => 後 !== undefined && [...前].length < [...後].length)
      .map(([前, 後]) => `${前} → ${後}`);
    expect(
      崩.join("・"),
      "語尾の表が長き順でない（後ろから当た最初を剥ぐ作りなので順が意味を持つ）",
    ).toBe("");
  });

  it("欄の語 × 語尾の網羅で、剥げ残りが一つもない（第 655 回 – 23 組の黙りの再發防止）", () => {
    const 尾 = 語尾の一覽();
    const 名 = 欄の語の一覽();
    expect(名.size, "欄の語が読めとれる").toBeGreaterThanOrEqual(23);
    const 残 = new Map<string, string>();
    for (const W of [...名].sort()) {
      for (const S of 尾) {
        const 後 = 剥いだ(W + S, 尾);
        if (!名.has(後)) 残.set(W + S, 後);
      }
    }
    expect(
      [...残.entries()]
        .slice(0, 8)
        .map(([問, 答]) => `${問} → 残り「${答}」`)
        .join(" / "),
      `語尾を剥いだ後に欄の名前にならんの組が ${残.size} 組在る（其のまま默る）`,
    ).toBe("");
  });

  it("磁石は崩れん（語尾增しが行の数を作つたり奪つたりして居らん – 第 337 回）", () => {
    for (const [語, 見當] of [
      ["オンライン", 109],
      ["査読", 32],
      ["機械学習", 504],
      ["icassp", 7],
      ["CCF", 2819],
      ["ics", 56],
      ["延長", 35],
      ["開催地", 298],
    ] as Array<[string, number]>) {
      expect(当たり(語), `"${語}" の行數が變はつた`).toBe(見當);
    }
  });
});
