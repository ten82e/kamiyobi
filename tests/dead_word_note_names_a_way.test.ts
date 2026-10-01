/**
 * 死語を名指す案内が、次に打つ語まで言う（第 623 回）。
 *
 * 實測 – 2026-08-09 生成の実ビルド（品書 3,280 行）で 0 件になる自然な打ち方 783 本を、
 * ビルド済み `emptyDeadlineHint` その物に通すと、
 *  ① 146 本が「その語を外すと増えます」を出す內訳、**外した殘りの語でも 0 件の物が在つた**
 *     （`査読の手数料はある` → 殘り「査読・ある」で 0 件）。增えん物增えると云ふて居た。
 *  ② 同じ 146 本の內 **58 本は打ち替えの語を一つも添えて居なかつた**。原因は門の形 –
 *     死語が在ると `specific` が真になり（第 258 回）、その門が「別の語で試す」の受けまで
 *     閉め出して居た（`スマホでも見られる` `再審査をお願いできる` 等が「外すと増えます」で
 *     打ち止め）。打ち直した人は何も變はらず、もう一打ちできない。
 *  ③ 打ち替えの案內を「外せる条件」と同じ袋に入れて居た為、單一の語の打ち直しは
 *     「**多いのは** 検索語を『計算』に打ち替える」という意味の通らん文になつた（`高速計算`）。
 *  ④ 打ち替えの候選 266 件のうち 48 件（18%）が假名だけの二文字語（`ある`×18・`たい`×6・
 *     `いつ`×5・`する`×4・`える`×4）で、內譯は動詞の活用切れ端だった。
 * 直し – 增えるかは數へてから言い切る（`termRemainder`）、死語だけの時は門を通す、打ち替えは
 * 「打ち直すなら」で別に取り出す、假名だけ三字以下は候選から落とす。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const 幕 = deadlineHintFunction();

/* 絞り込みは全部外れた 0 件の形 – 案内の文だけを見るので其它の欄は此處に置く（第 248 回など
   と同じ組み立て）。`termRemainder` は app が實測で入れる欄なので、檢査は之をExplicitに渡す。 */
function 幕の文(上書き: Record<string, unknown>): string {
  return 幕({
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    est: false,
    hiddenKindWords: [],
    hidden: { past: 1200, est: 134 },
    queryMatch: { catalog: 0, journal: 0 },
    termCounts: [],
    urlQuery: false,
    catalogConferences: 12,
    ...上書き,
  });
}

describe("死語の案内に行き止まりを残さん（第 623 回）", () => {
  it("打ち替え語が無い死語の文も、「別の語で試す」に落ちる（舊來は打ち止めだつた）", () => {
    const out = 幕の文({
      query: "スマホでも見られる",
      termCounts: [
        { term: "スマホ", count: 0 },
        { term: "見られる", count: 0 },
      ],
      shorterHits: [],
    });
    expect(out).toContain("その語を外すと増えます");
    expect(out, "死語を名指して打ち止めにしている（次に打つ語が誰も教へない）").toContain(
      "打ち直すなら",
    );
    expect(out).toContain("別の語で試す（分野名・主題・開催地の日本語でも引けます）");
  });

  it("外した殘りが 0 件なら「増えます」と言い切らん – 實測の通りに言う", () => {
    const 語 = [
      { term: "査読", count: 32 },
      { term: "手数料", count: 0 },
      { term: "ある", count: 5 },
    ];
    const 嘘になる形 = 幕の文({
      query: "査読の手数料はある",
      termCounts: 語,
      termRemainder: 0,
      shorterHits: [{ word: "査読", count: 32, how: "alone" }],
    });
    expect(嘘になる形).toContain("其れを外しても殘りの語では 0 件の侭です。");
    expect(嘘になる形, "增えんのに增へると言つて居る").not.toContain("その語を外すと増えます");
    /* 殘りで 0 件でも、打ち替え語を同じ文に添へて置く（之が無ければ行き止まり）。 */
    expect(嘘になる形).toContain("検索語を「査読」だけに絞る");

    const 增える形 = 幕の文({
      query: "査読の手数料はある",
      termCounts: 語,
      termRemainder: 13,
      shorterHits: [{ word: "査読", count: 32, how: "alone" }],
    });
    expect(增える形).toContain("その語を外すと増えます");
    expect(增える形).not.toContain("0 件の侭");
  });

  it("打ち替えの案内に「多いのは」を付けん – 別の言い出しで受ける", () => {
    const out = 幕の文({
      query: "高速計算",
      termCounts: [],
      shorterHits: [{ word: "計算", count: 298, how: "shorten" }],
    });
    expect(out, "条件の話と打ち替えの話が同じ袋で混つた").not.toContain("多いのは 検索語を");
    expect(out).toContain("打ち直すなら 検索語を「計算」に打ち替える");
    expect(out).toContain("298 件");
  });

  it("原因を言い切った案内（欄の名前を打つた等）には打ち替えを重ねん", () => {
    /* 第 623 回の門は「死語が在る時だけ」緩める – 原因が他に分かつて居る時は舊來の侬讓る。 */
    const out = 幕の文({
      query: "会場 京都",
      termCounts: [
        { term: "会場", count: 0 },
        { term: "京都", count: 0 },
      ],
      shorterHits: [{ word: "会場", count: 868, how: "alone" }],
    });
    expect(out).toContain("この表の欄（開催地）の名前");
    expect(out, "原因が欄の名前なのに打ち替えを並べた").not.toContain("打ち直すなら");
  });

  it("讀み上げの側は六十字に収まつた侬打ち替えを置く（畫面の文を變はつても壞れん）", async () => {
    const { zeroResultLiveFunction } = await import("./runtime_extract.ts");
    const out = zeroResultLiveFunction()({
      window: "all",
      past: false,
      cats: 0,
      domestic: false,
      online: false,
      rank: "all",
      kind: "",
      est: false,
      clearable: true,
      pastShown: false,
      hidden: { past: 1200, est: 134 },
      queryMatch: { catalog: 0, journal: 0 },
      catalogConferences: 12,
      urlQuery: false,
      termCounts: [
        { term: "スマホ", count: 0 },
        { term: "見られる", count: 0 },
      ],
      query: "スマホでも見られる",
      shorterHits: [{ word: "発表", count: 24, how: "alone" }],
    });
    expect(out.length, `読み上げが長い: ${out.length} 字`).toBeLessThanOrEqual(60);
  });
});

describe("打ち替えの候選から假名だけの切れ端を落とす（第 623 回 ④）", () => {
  /* 屑除けの家 `shorterWordNotes` は行の表を閉ぢて居るので檢査から呼べん（第 341 回）。
     だから形を張る – 同じ目に會ふ所で之を變へたら、此處が落ちる。 */
  const src = readFileSync(`${REPO_ROOT}/site/app.ts`, "utf8");
  const body = src.slice(src.indexOf("function shorterWordNotes("));
  const 中 = body.slice(0, body.indexOf("\n  }"));
  it("假名だけ三字以下を候選から落とす目を、其の家が持つ", () => {
    expect(中).toMatch(/HIRAGANA_ONLY_JA\.test/);
    expect(中).toMatch(/length <= 3/);
    expect(中).toMatch(/return Recommender\.shorterHitWordsJa\(trimmed, hays, now\)\.filter/);
  });
  it("假名だけの目は app の一處にしか無く、同じ列表を其它の家が寫さぬ", () => {
    expect(src.match(/HIRAGANA_ONLY_JA/g)?.length).toBe(2);
    expect(src).toContain("const HIRAGANA_ONLY_JA = /^[\\u3041-\\u309f]+$/;");
  });
});

describe("畫面の文が噓を言はんと實測で張る（第 623 回）", () => {
  /* ビルド品書の語の數へを app と同じ目で通し、「外すと增へます」を出した文は全て
     殘りの語で実際に 0 件を抜ける事を張る。 fixtures でも實ビルドでも同じ目が通る形にした
     （件の數は張らん – 張るのは「言い切りの背後に實測が在るか」だけ）。 */
  const 基準 = Date.parse("2026-08-09T00:00:00Z");
  const 品書 = Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  );
  const hays = 品書.map((r: { hay?: string }) => String(r.hay));
  function 當(文: string): number {
    const 展 = Recommender.expandRelativeMonths(文, 基準);
    if (!展) return 品書.length;
    const m = Recommender.searchMatcher(展, 基準);
    return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
  }
  const 檢べ文 = [
    "査読の手数料はある",
    "shepherdingがある",
    "再審査をお願いできる",
    "スマホでも見られる",
    "配信の予定はある",
    "学生だけのセッションがある国際会議はどこですか",
    "プログラム委員会が決める",
  ];
  it("品書で 0 件の文だけを檢べて居る（空振りを防ぐ）", () => {
    for (const 文 of 檢べ文) expect(當(文), 文).toBe(0);
  });
  it("「その語を外すと増えます」と言った文は、殘りの語で実際に增える", () => {
    let 張つた = 0;
    for (const 文 of 檢べ文) {
      const tc = Recommender.queryTermCounts(
        Recommender.expandRelativeMonths(文, 基準),
        hays,
        基準,
      );
      if (tc.length < 2) continue;
      const 死 = tc.filter((t: { count: number }) => t.count === 0);
      if (!死.length) continue;
      const 生 = tc
        .filter((t: { count: number }) => t.count > 0)
        .map((t: { term: string }) => t.term)
        .join(" ");
      const 殘 = 生 ? 當(生) : null;
      const out = 幕の文({
        query: 文,
        termCounts: tc,
        termRemainder: 殘,
        shorterHits: [],
      });
      if (!/その語を外すと増えます/.test(out)) continue;
      張つた++;
      expect(殘 === null || 殘 > 0, `增へんのに增へると言つた: ${文}`).toBe(true);
      expect(out, `打ち手を添えずに打ち止めにした: ${文}`).toContain("打ち直すなら");
    }
    expect(張つた, "一回も張れて居ん（檢べ文が皆其它の案内に拔かれた）").toBeGreaterThan(0);
  });
});
