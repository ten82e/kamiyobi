import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

const 幕 = deadlineHintFunction();

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
  it("打ち替え語がない死語の文も、「別の語で試す」に落ちる（旧來は打ち止めだった）", () => {
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

  it("外した残りが 0 件なら「増えます」と言い切らん – 実測の通りに言う", () => {
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
    expect(嘘になる形).toContain("それを外しても残りの語では 0 件のままです。");
    expect(嘘になる形, "增えんのに增へると言つている").not.toContain("その語を外すと増えます");
    /* 残りで 0 件でも、打ち替え語を同じ文に添へて置く（之が無ければ行き止まり）。 */
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
    /* 第 623 回の門は「死語がある時だけ」緩める – 原因が他に分かつている時は旧來の侬讓る。 */
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

  it("読み上げの側は六十字に収まつた侬打ち替えを置く（画面の文を変はつても壊れん）", async () => {
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
  /* 屑除けの家 `shorterWordNotes` は行の表を閉ぢているので検査から呼べん。
     だから形を張る – 同じ目に会ふ所で之を変へたら、ここが落ちる。 */
  const src = readFileSync(`${REPO_ROOT}/site/app.ts`, "utf8");
  const body = src.slice(src.indexOf("function shorterWordNotes("));
  const 中 = body.slice(0, body.indexOf("\n  }"));
  it("假名だけ三字以下を候選から落とす目を、その家が持つ", () => {
    expect(中).toMatch(/HIRAGANA_ONLY_JA\.test/);
    expect(中).toMatch(/length <= 3/);
    expect(中).toMatch(/return Recommender\.shorterHitWordsJa\(trimmed, hays, now\)\.filter/);
  });
  it("假名だけの目は app の一處にしか無く、同じ列表を其它の家が寫さぬ", () => {
    expect(src.match(/HIRAGANA_ONLY_JA/g)?.length).toBe(2);
    expect(src).toContain("const HIRAGANA_ONLY_JA = /^[\\u3041-\\u309f]+$/;");
  });
});

describe("画面の文が噓を言はんと実測で張る（第 623 回）", () => {
  /* ビルド品書の語の数へを app と同じ目で通し、「外すと增へます」を出した文は全て
     残りの語で実際に 0 件を抜ける事を張る。 fixtures でも実ビルドでも同じ目が通る形にした
     （件の数は張らん – 張るのは「言い切りの背後に実測があるか」だけ）。 */
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
  it("品書で 0 件の文だけを検べている（空振りを防ぐ）", () => {
    for (const 文 of 檢べ文) expect(當(文), 文).toBe(0);
  });
  it("「その語を外すと増えます」と言った文は、残りの語で実際に增える", () => {
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
    expect(張つた, "一回も張れていない（検べ文が皆其它の案内に拔かれた）").toBeGreaterThan(0);
  });
});
