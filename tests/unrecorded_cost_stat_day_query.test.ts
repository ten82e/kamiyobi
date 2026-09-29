/* 第 516 回 – 収録に無い情報を訪ねる語の、抜けて居た三つの家（費用の兄弟・採否の数・当日の様子）
 *
 * 実測（2026-09-30 – 2026-08-09 生成の実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）。
 * 「其の情報はこの表が持っていません」と告げる群（`UI_WORD_GROUPS_JA`）は第 337 回から四十に
 * 増えて居るが、実際の打ち方として集めた文では仍ほ壁になつて居た:
 *   `交通費` `出張費` `宿泊費` `宿泊` `会費` `年会費` `出展料` `聴講料` `受講費` `参加登録料`
 *   `招待券` `入場料` `チケット` `学生無料` `グラント` `lodging` `accommodation` – **0 行・無言**
 *   （同じ家の `参加費` `登録費` `旅費` `補助` `学割` は案内が出る – 群に語が抜けただけ – 第 348 回）
 *   `採択率` `採択数` `投稿数` `投稿本数` `応募数` `競争率` `倍率` `審査員` `査読者数` `定員`
 *   `参加者数` `人数` `acceptance rate` – **0 行・無言**（審査の**方式**は群 23・**期間**は群 25が
 *   受けるが、**数**はどこにも受け先が無く、投稿先を選ぶ人が最初に訊く事が默つて居た）
 *   `録画` `アーカイブ` `発表資料` `スライド` `発表時間` `持ち時間` `質疑` `通訳` `翻訳` `プログラム`
 *   `演目` `タイムテーブル` `後日` `当日` – **0 行・無言**（参加するかと決める時に訊く事）
 * 足した六十七語は**すべて品書の文本に 0 箇所**（一本ずつ實測 – 下の「噓を言はない」の檢査が其れを
 * 張る）ので「収録していません」は噓にならない（第 337 回の決まり）。
 *
 * 彈いた語（實測で噓になる・案内が当たらない）
 *   `ホテル` – 品書の文本に 2 箇所（『開催地』の "Hyatt Hotel, Shatin, Hong Kong"
 *     "Clarion Congress Hotel Prague"）→「其の語は現れません」が書けない
 *   `採択`（129 行）・`acceptance`（36 行）・`言語`（31 行）・`公開`（13 行）・`査読`（13 行）・
 *     `資料`（2 行） – 当たりが在る（第 337 回）
 *   `収録` – この畫面自身の語彙で、案内文も「収録するのは…」と書く（自分の事を言つて化ける – 第 512 回）
 *   `会員` – 0 行だが負担の話ではなく会員資格の区別なので、費用の群の案内が当たらない（残した差）
 *   `費用対効果分析` – 第 505 回の磁石。語尾を問わない印（`anyTail`）を付けて居ないので默つて居る
 *
 * 檢査は `builtSite()` の品書（fixtures から立てる – 実ビルドの 868 行ではなく 435 行）で動く。
 * 足した語は fixtures でも 0 行（實測）なので 0 を張つて良いが、**当たり側の数は張らない**
 *（`採択通知`・`会期` は fixtures に 0 行の可能性がある為、案内の文が其の名を名乘る事だけ張る）。*/

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Array<{ hay: string }> {
  const 物 = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown;
  return Recommender.candidateRows(物) as unknown as Array<{ hay: string }>;
}

function 件数(文: string): number {
  const 照合 = Recommender.searchMatcher(文, 基準);
  return 品書().filter((行) => 照合(String(行.hay)) === true).length;
}

/** 畫面が 0 件時に出す案内の文（六道を並べた一字列）。 */
function 案内(文: string): string {
  return [
    Recommender.columnQueryNoteJa(文),
    Recommender.uiWordNoteJa(文),
    Recommender.dayRangeNoteJa(文),
    Recommender.wholeTableQueryNoteJa(文),
    ...(Recommender.relativeDayNotes(文, 基準) || []),
    ...Recommender.querySynonymNotes(文),
  ]
    .filter(Boolean)
    .join(" ∥ ");
}

/** ビルド成果物から案内の群の一覧を読む（第 512 回の棚卸し檢査と同じ讀み方）。 */
function 群々(): Array<{ k: number; words: string[]; note: string; live: string }> {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
  expect(始, "群の一覧が見つからない（組み立て方が変はつた）").toBeGreaterThan(0);
  const 後 = 物.slice(始);
  const 終 = 後.match(/\n\s*\];/);
  expect(終, "群の一覧の終りが見つからない").not.toBeNull();
  return 後
    .slice(0, 終 ? 終.index : 後.length)
    .split(/\n\s+\{\n/)
    .slice(1)
    .map((塊, k) => {
      const 合 = 塊.match(/words:\s*\[([\s\S]*?)\]/);
      const 語塊 = (合 ? 合[1] : "").replace(/\/\*[\s\S]*?\*\//g, "");
      const 清 = 塊.replace(/\/\*[\s\S]*?\*\//g, "");
      const 取 = (名: string) => {
        const 目 = new RegExp(`\\n\\s*${名}:\\s*(?:\\n\\s*)?"((?:[^"\\\\]|\\\\.)*)"`);
        const m = 清.match(目);
        return m ? m[1] : "";
      };
      return {
        k,
        words: [...語塊.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
        note: 取("note"),
        live: 取("live"),
      };
    });
}

const 費用の家 = [
  "交通費",
  "出張費",
  "宿泊費",
  "宿泊",
  "宿泊代",
  "ホテル代",
  "宿代",
  "会費",
  "年会費",
  "出展料",
  "展示料",
  "協賛金",
  "広告料",
  "聴講料",
  "聴講費",
  "受講費",
  "参加登録料",
  "招待券",
  "入場料",
  "チケット",
  "チケット代",
  "学生無料",
  "グラント",
  "lodging",
  "accommodation",
];

const 数の家 = [
  "採択率",
  "採択数",
  "採択本数",
  "採択傾向",
  "通過率",
  "競争率",
  "倍率",
  "投稿数",
  "投稿本数",
  "応募数",
  "応募者数",
  "審査員",
  "審査員数",
  "査読者数",
  "レビュアー数",
  "定員",
  "収容人数",
  "参加者数",
  "参加登録者数",
  "人数",
  "acceptance rate",
];

const 当日の家 = [
  "録画",
  "録画公開",
  "後日アーカイブ",
  "アーカイブ",
  "archive",
  "発表資料",
  "スライド",
  "発表時間",
  "持ち時間",
  "質疑",
  "質疑応答",
  "通訳",
  "同時通訳",
  "翻訳",
  "当日配布",
  "当日",
  "後日",
  "プログラム",
  "タイムテーブル",
  "進行表",
  "演目",
];

describe("費用・旅費・宿泊の兄弟語が費用の案内を受ける（第 516 回）", () => {
  it("二十五語がどれも 0 行で、其の名を名乗る費用の案内が出る", () => {
    for (const 語 of 費用の家) {
      expect(件数(語), `\`${語}\` が品書に行を出す（収録に無いと言へない）`).toBe(0);
      const 注 = 案内(語);
      expect(注, `\`${語}\` が 0 件で無言（案内の群から抜けて居る）`).toContain(語);
      expect(注, `\`${語}\` の案内が費用の家へ導かない`).toContain("費用の欄はありません");
    }
  });

  it("助詞で繋がれた打ち方と空格に並べた打ち方も同じ案内を受ける", () => {
    // 實測の打ち方（155 文の群） – 第 513 回の連体・第 354 回の `multiword` が受ける筈
    for (const 文 of [
      "交通費の補助",
      "宿泊の手配",
      "出張費は出るか",
      "宿泊費の相場",
      "会費はいくら",
      "年会費の締切",
      "聴講料 学生",
      "宿泊費 2026年9月",
      "入場料は？",
    ]) {
      const 注 = 案内(文);
      expect(件数(文), `\`${文}\` が行を出す（彈いて居る語が混じつた）`).toBe(0);
      expect(注, `\`${文}\` が 0 件で無言`).toContain("費用の欄はありません");
    }
  });

  it("`ホテル` は受けない – 『開催地』に実在するので『現れません』が噓になる（門）", () => {
    const 群 = 群々();
    for (const g of 群) expect(g.words, `群 ${g.k} が \`ホテル\` を持つ`).not.toContain("ホテル");
    // 其の外の形は受ける（實測 – 文本 0 箇所）
    expect(案内("ホテル代")).toContain("費用の欄はありません");
    expect(案内("宿代")).toContain("費用の欄はありません");
  });

  it("`会員` は費用の家に入れない – 負担ではなく資格の区別なので案内が当たらない（門）", () => {
    for (const g of 群々()) expect(g.words, `群 ${g.k} が \`会員\` を持つ`).not.toContain("会員");
  });
});

describe("採否・投稿・規模の数の群が新たに受ける（第 516 回）", () => {
  it("二十一字がどれも 0 行で、採択率の家へ導く案内が出る", () => {
    for (const 語 of 数の家) {
      expect(件数(語), `\`${語}\` が品書に行を出す`).toBe(0);
      const 注 = 案内(語);
      expect(注, `\`${語}\` が 0 件で無言（数の案内の群が無い）`).toContain(語);
      expect(注, `\`${語}\` の案内が統計の欄が無いと言はない`).toContain("採択率");
      // 噓にならない受け先を名乗る（採否の**日**はこの表が持つ – 群 23・25 と同じ形）
      expect(注, `\`${語}\` の案内が『採択通知』への道を言はない`).toContain("採択通知");
    }
  });

  it("実測の打ち方 – 連体で繋がれた文が其の名を乗つたまま導かれる", () => {
    for (const 文 of ["採択率の高い会議", "投稿本数の制限", "定員は何人", "参加登録者数"]) {
      expect(件数(文)).toBe(0);
      expect(案内(文), `\`${文}\` が 0 件で無言`).toContain("数の統計を書く欄はありません");
    }
  });

  it("当たり語は数の群に混じれない – `採択` `acceptance` `査読` は品書に行を持つ（門）", () => {
    const 群 = 群々();
    for (const g of 群) {
      for (const 語 of ["採択", "acceptance", "査読"]) {
        expect(g.words, `群 ${g.k} が当たり語 \`${語}\` を収録に無いと言つて居る`).not.toContain(
          語,
        );
      }
    }
    // 訪ねて並べた形（`acceptance rate 関西`）は語その物で受け、当たり語 `acceptance` 単體は受けない
    expect(案内("acceptance rate")).toContain("採択率");
  });
});

describe("催し物の当日の様子・記録の群が新たに受ける（第 516 回）", () => {
  it("二十一字がどれも 0 行で、当日の家へ導く案内が出る", () => {
    for (const 語 of 当日の家) {
      expect(件数(語), `\`${語}\` が品書に行を出す`).toBe(0);
      const 注 = 案内(語);
      expect(注, `\`${語}\` が 0 件で無言`).toContain(語);
      expect(注, `\`${語}\` の案内が当日の様子の欄が無いと言はない`).toContain("演目・録画");
      expect(注, `\`${語}\` の案内が『会期』への道を言はない`).toContain("会期");
    }
  });

  it("実測の打ち方 – 公開・録画・通訳を尋ねた文が導かれる", () => {
    for (const 文 of [
      "録画の公開",
      "発表資料の公開",
      "後日アーカイブ",
      "発表時間はどれくらい",
      "通訳があるか",
      "スライドはどれくらい",
    ]) {
      expect(件数(文), `\`${文}\` が行を出す`).toBe(0);
      expect(案内(文), `\`${文}\` が 0 件で無言`).toContain("当日の様子を書く欄はありません");
    }
  });

  it("`収録` は受けない – この畫面自身の語彙で、案内が自分を否定して化ける（門）", () => {
    for (const g of 群々()) expect(g.words, `群 ${g.k} が \`収録\` を持つ`).not.toContain("収録");
    expect(案内("録画")).toContain("当日の様子を書く欄はありません");
  });

  it("当たり語 `資料` `言語` `公開` を当日の群に混じれない（門）", () => {
    for (const g of 群々()) {
      for (const 語 of ["資料", "言語", "公開"]) {
        expect(g.words, `群 ${g.k} が当たり語 \`${語}\` を持つ`).not.toContain(語);
      }
    }
    // 部品として含む語は受ける（実測 – 文本 0 箇所）
    expect(案内("発表資料")).toContain("当日の様子を書く欄はありません");
  });
});

describe("訪ねる語尾の新規条目が三つの家で同じ様に聞く（第 516 回）", () => {
  it("量の尋ね方・人数の尋ね方・有無の尋ね方が案内に屆く", () => {
    for (const 文 of [
      "参加費はどれくらい",
      "登録費はいくつある",
      "旅費はあるか",
      "交通費がありますか",
      "採択率はある？",
      "審査員は何人",
      "定員は何人",
      "宿泊費はありますか",
    ]) {
      expect(件数(文), `\`${文}\` が行を出す`).toBe(0);
      expect(案内(文), `\`${文}\` が 0 件で無言（語尾が白一覧に無い）`).not.toBe("");
    }
  });

  it("其の方の語が収録に無い語で無い訪ね方は黙つの侭（語尾だけを廣げない）", () => {
    // `査読` は当たり語（実測 13 行）なので、語尾を廣げても「収録に無い」と言ひ出さない
    expect(案内("査読は何人")).not.toContain("収録していません");
    expect(案内("会期は何人")).not.toContain("収録していません");
  });
});

describe("案内の文その物の清浄（第 516 回で二箇所の実測バグ）", () => {
  it("畫面に出す文に強調の記号と舊字体を殘さない", () => {
    const 舊字体 = "會檢數實對關經錄應圖廢變讓歸";
    for (const g of 群々()) {
      for (const [名, 文] of [
        ["note", g.note],
        ["live", g.live],
      ] as const) {
        if (!文) continue;
        expect(文, `群 ${g.k} の ${名} が Markdown の記号を畫面に出す`).not.toContain("**");
        for (const 字 of 舊字体) {
          expect(文, `群 ${g.k} の ${名} に舊字体「${字}」が混じつて居る`).not.toContain(字);
        }
      }
    }
  });
});

describe("磁石と舊の決まりが其侭通る（第 505 回・第 513 回・第 514 回・第 515 回）", () => {
  it("主題を打つた打ち方に費用の案内を被せない", () => {
    for (const 文 of ["費用対効果分析", "リアルタイム処理", "メジャーな学会", "対面について"]) {
      expect(案内(文), `\`${文}\` に収録に無い案内が化けた`).not.toContain("費用の欄はありません");
    }
  });

  it("値を並べた打ち手は舊の決まりが勝つ（第 250 回・第 354 回）", () => {
    const 注 = 案内("過去の締切 関西");
    expect(注).toContain("関西");
    expect(注).not.toContain("費用の欄はありません");
  });

  it("全行の語の案内と語尾の割り、原文の語への寄せが其侭効く", () => {
    expect(案内("締切一覧")).toContain("では絞り込めません");
    expect(件数("AI会議")).toBe(件数("AI"));
    expect(件数("査読締切日")).toBe(件数("査読 締切日"));
    expect(件数("国際")).toBe(件数("international"));
    expect(件数("国内会議")).toBe(件数("国内"));
  });
});

describe("品書の側には手を付けて居ない（第 516 回）", () => {
  it("足した語は品書の文本に一箇所も現れない –『収録に無い』が噓にならない實測", () => {
    const 文本 = 品書()
      .map((行) => String(行.hay))
      .join("\n");
    for (const 語 of [...費用の家, ...数の家, ...当日の家]) {
      expect(文本.toLowerCase().indexOf(語.toLowerCase()), `品書に \`${語}\` の字面が現れる`).toBe(
        -1,
      );
    }
  });

  it("同じ語を二つの群に載せず、一つの群に二重に載せない（第 512 回）", () => {
    const 群 = 群々();
    const 持ち = new Map<string, number[]>();
    for (const g of 群) {
      const 見た = new Set<string>();
      for (const 語 of g.words) {
        const 鍵 = 語.toLowerCase();
        if (見た.has(鍵)) expect.fail(`群 ${g.k} が \`${語}\` を二重に載せて居る`);
        見た.add(鍵);
        持ち.set(鍵, [...(持ち.get(鍵) || []), g.k]);
      }
    }
    for (const 語 of [...費用の家, ...数の家, ...当日の家]) {
      const 所 = 持ち.get(語.toLowerCase()) || [];
      expect(所.length, `\`${語}\` が ${所.length} 個の群に載つて居る`).toBe(1);
    }
  });

  it("成果物の群の一覧に新しい語が一度ずつしか並ばない（追記の二重走らせ防止）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    expect(終, "群の一覧の終りが見つからない").not.toBeNull();
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const 語 of [...費用の家, ...数の家, ...当日の家]) {
      // 行頭にある条目だけ數える（其の外の表 – 例: `後日` を含む語列表 – と取り違へない為）
      const 度 = 本.split("\n").filter((行) => 行.trim() === `"${語}",`).length;
      expect(度, `群の一覧に \`${語}\` が ${度} 本並んで居る`).toBe(1);
    }
  });
});
