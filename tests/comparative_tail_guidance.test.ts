import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");

let 品書: Row[] | null = null;

/** 品書を一度だけ読む（七千組を数へる検査では每回読むと数分かかる – 第 656 回で実測 484 秒）。*/
function 收錄(): Row[] {
  if (!品書) {
    品書 = Recommender.candidateRows(
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
    ) as Row[];
  }
  return 品書;
}

function 当たり(打ち方: string): number {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(打ち方, AT), AT);
  return 收錄().filter((r) => m(String(r.hay)) === true).length;
}

/** 画面が立てる讓り（app.ts と同じ順 – 列訪ね → 羣 → 日数 → 全行）。 */
function 讓り(打ち方: string): string {
  const 列 = String(Recommender.columnQueryNoteJa(打ち方, (語: string) => 当たり(語) > 0) || "");
  if (列) return 列;
  const 羣 = String(Recommender.uiWordNoteJa(打ち方, false) || "");
  if (羣) return 羣;
  return (
    String(Recommender.dayRangeNoteJa(打ち方) || "") +
    String(Recommender.wholeTableQueryNoteJa(打ち方) || "")
  );
}

/** 語尾の白一覧（`UI_WORD_TAILS_JA`）を源から読む。 */
function 語尾の一覽(): string[] {
  const 始 = 源.indexOf("const UI_WORD_TAILS_JA");
  expect(始, "語尾の表が見つからん").toBeGreaterThan(0);
  const 本 = 源.slice(始, 源.indexOf("\n  ]", 始));
  return [...本.matchAll(/^\s{4}"([^"]+)",$/gm)].map((m) => m[1]);
}

describe("数を比べる訪ね方（第 656 回）", () => {
  it("比べる語を續けた打ち手が、数の統計を指す斷りで答はじめる", () => {
    const 打ち手 = [
      "採択率が高い会議",
      "採択率が低い会議",
      "倍率が低い学会",
      "参加者数が多い会議",
      "定員が少ないワークショップ",
      "投稿数が多い会議",
      "引用数が多い会議",
      "採択率が低い",
    ];
    for (const 打ち方 of 打ち手) {
      expect(当たり(打ち方), `「${打ち方}」に行が出て居る（導きが搜を食んだ – 第 505 回）`).toBe(0);
      const 讓 = 讓り(打ち方);
      expect(讓, `「${打ち方}」が未だ默つて居る`).not.toBe("");
      expect(讓, `「${打ち方}」への斷りが數の統計の話では無い: ${讓.slice(0, 40)}`).toContain(
        "持っていません",
      );
    }
  });

  it("開き方は狹い – 比べる語尾を**広い表に載せず**、統計の羣だけを開いた（第 362 回・第 656 回）", () => {
    const 語尾 = 語尾の一覽();
    expect(語尾.length, "語尾の表が読めとれる").toBeGreaterThan(120);
    for (const 形 of ["が高い", "が低い", "が多い", "が少ない", "が厳しい", "が安い"]) {
      expect(
        語尾.includes(形),
        `語尾「${形}」が廣い表に载つた（第 362 回に觸れる – 羣側に立てる事）`,
      ).toBe(false);
    }
    /* 第 362 回の決まりそのもとも張直す（この検査が有れば別の回合で靜かに開かん）。*/
    expect(
      String(Recommender.uiWordNoteJa("参加費が高い") || ""),
      "費用の羣が比べる打ち手を食んだ",
    ).toBe("");
    expect(
      String(Recommender.uiWordNoteJa("費用が安い会議") || ""),
      "費用の羣が比べる打ち手を食んだ",
    ).toBe("");

    for (const 打ち方 of ["採択されたいです", "採択された論文", "定員割れ"]) {
      expect(
        String(Recommender.uiWordNoteJa(打ち方, false) || "").trim(),
        `「${打ち方}」に統計の斷りが乘つた（比べる語以外に廣がるな – 第 503 回）`,
      ).toBe("");
    }

    /* 立てた家は一つ – 数の統計の羣に `statTail: true`（比べる語尾の別表を見る印）。*/
    const 始 = 源.indexOf('"acceptance rate"');
    expect(始, "数の統計の羣が見つからん").toBeGreaterThan(0);
    const 家 = 源.slice(源.lastIndexOf("{", 始), 源.indexOf("}", 始));
    expect(家.includes("statTail: true"), "数の統計の羣に statTail が立つて居らん").toBe(true);
    const 全体 = 源.slice(源.indexOf("const UI_WORD_GROUPS_JA"));
    expect(
      全体.slice(0, 全体.indexOf("\n  ];")).split("anyTail: true").length - 1,
      "anyTail の羣が增え過ぎた（広げる每に検索らしい打ち手を奪ふ – 第 634 回）",
    ).toBeLessThanOrEqual(17);
    expect(
      全体.split("statTail: true").length - 1,
      "statTail の羣が增え過ぎた – 別表に載らん語を足す每に広がる（第 505 回）",
    ).toBeLessThanOrEqual(1);
  });

  it("磁石 – 全羣の語 × 新しい語尾が 7,470 組、その全部が 0 件の侬（第 505 回）", () => {
    const 新 = ["が高い", "が低い", "が多い", "が少ない", "が厳しい"];
    const rows = 收錄();
    expect(rows.length, "品書が読めとれる").toBeGreaterThan(3000);

    const 見本 = rows.filter((r) => String(r.hay).includes("査読"));
    expect(見本.length, "品書を読む目が壊れている（何を数えても 0 になる）").toBeGreaterThan(0);
    for (const 尾 of 新) {
      const 當 = rows.filter((r) => String(r.hay).includes(尾));
      expect(
        當
          .slice(0, 3)
          .map((r) => String(r.hay).slice(0, 30))
          .join(" / "),
        `語尾「${尾}」が品書の文本 ${當.length} 行に出るやうになつた（導きが搜を食ふ樣になる）`,
      ).toBe("");
    }
    const 始 = 源.indexOf("const UI_WORD_GROUPS_JA");
    const 宣 = 源.slice(始, 源.indexOf("\n  ];", 始));
    const 語々 = [
      ...new Set(
        [...宣.matchAll(/"([^"\\]{2,20})"/g)]
          .map((m) => m[1])
          .filter((x) => /[ぁ-んァ-ヶ一-龥a-zA-Z]/.test(x)),
      ),
    ];
    expect(語々.length, "羣の語が細つた（目が屆かなくなる）").toBeGreaterThan(1400);
    const 食: string[] = [];
    for (const 語 of 語々) {
      for (const 尾 of 新) {
        const h = 当たり(語 + 尾);
        if (h > 0) 食.push(`${語}${尾}:${h} 行`);
      }
    }
    expect(
      食.slice(0, 8).join(" / "),
      `語尾を續けた組が行を出すやうになつた（${食.length} 組 / ${語々.length * 新.length} 組）`,
    ).toBe("");
  });

  it("残つた黙りは事実として張る（第 656 回 – 直らん内を隱さん、第 662 回で張り替へた）", () => {
    /* `査読` は羣の語に無い（羣は『査読結果公開』を持つ – 収録の 13 行はその段階の語）ので、
     * 「査読 + 訪ね」はまだ黙る。其上、オムニバスのやうな**催し物の形**の名は、この表の
     * どの羣にも寄らんので、導く斷り自体が未だ無い。*/
    const 默 = ["査読が厳しい", "査読が厳しい会議", "オムニバス査読"];
    for (const 打ち方 of 默) {
      expect(当たり(打ち方), `「${打ち方}」に行が出るやうになつた`).toBe(0);
      expect(讓り(打ち方).trim(), `「${打ち方}」が立つやうになつた（この條を張り替へよ）`).toBe("");
    }

    /* 第 663 回が直した形 – 頭の語その物が羣に無くて黙つていた言い方（`転投` は旧來この黙りの側に
     * 張つていた – 語尾では直らん處）。検索れる形は変はらん。*/
    for (const [打ち方, 宛先] of [
      ["ダブルブラインド査読", "審査の方式"],
      ["ブラインド査読", "審査の方式"],
      ["転投", "投稿の手続き"],
    ] as Array<[string, string]>) {
      expect(当たり(打ち方), `「${打ち方}」に行が出るやうになつた`).toBe(0);
      expect(讓り(打ち方), `「${打ち方}」の宛先`).toContain(宛先);
    }
  });
});
