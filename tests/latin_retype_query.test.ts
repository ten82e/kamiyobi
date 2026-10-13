import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";
import { deadlineHintFunction, siteRuntime, zeroResultLiveFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 畫面 = deadlineHintFunction();
const 聲 = zeroResultLiveFunction();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8")),
);
const hays = 品書.map((r: { hay?: string }) => String(r.hay ?? ""));

function 搜(文: string): number {
  const f = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return hays.filter((h) => f(h) === true).length;
}
function 見当(文: string): Array<{ word: string; count: number; how: string }> {
  return (Recommender.shorterHitWordsJa(文, hays, 基準, 4) || []) as Array<{
    word: string;
    count: number;
    how: string;
  }>;
}

/** 0 件の画面の袋（外せる条件は既定の二つ – 第 632 回の実測の形）。 */
function 袋(文: string, 追加: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    termCounts: [{ term: 文, count: 0 }],
    shorterHits: [],
    hiddenKindWords: [],
    query: 文,
    ...追加,
  };
}

describe("欧文の一文字違いに収録の綴りを見当として出す（第 680 回）", () => {
  it("品書は実測した 3,250 行の侬（桁が違へば上の実測が読み直せんなる）", () => {
    expect(品書.length).toBe(3250);
  });

  it("七語が収録の綴りへ屆く（打ち手の先頭に立つ）", () => {
    const 見當 = [
      ["camera-redy", "camera ready", 147],
      ["registraton", "registration", 66],
      ["workshp", "workshop", 174],
      ["embeded", "embedded", 982],
      ["netwrok", "network", 373],
      ["sumposium", "symposium", 585],
      ["hybird", "hybrid", 111],
    ] as const;
    for (const [打ち手, 綴り, 件] of 見當) {
      expect(搜(打ち手), `『${打ち手}』は搜 0 行のはず`).toBe(0);
      const 列 = 見当(打ち手);
      expect(列.length, `『${打ち手}』に見当が無い`).toBeGreaterThan(0);
      expect(列[0].word, `『${打ち手}』の先頭の打ち手`).toBe(綴り);
      expect(列[0].how, `『${打ち手}』の種別は打ち替え`).toBe("retype");
      expect(列[0].count, `『${打ち手}』→『${綴り}』の件數`).toBe(件);
      // 見当に說ふ件数は検索し欄と同じ数（検べが別々の数へ方をして居ん證）。
      expect(搜(綴り), `『${綴り}』を搜した數と揃ふ`).toBe(件);
    }
  });

  it("検索し自体は広がらん（黙つて隣りの綴りまで連れて来ん）", () => {
    for (const 打ち手 of ["camera-redy", "embeded", "netwrok", "sumposium"]) {
      expect(搜(打ち手), `『${打ち手}』の搜しは 0 行の侬`).toBe(0);
    }
    // 近い綴りの方を検索せば同じ行が出る – 打ち手が效いている證。
    expect(搜("embedded")).toBeGreaterThan(0);
  });

  it("収録の綴りは語の切れ端より先に出し、切れ端は打ち手から落す", () => {
    // 実測 – 『embe』63 件・『ded』16 件と並んでいた（収録の語で無い切れ端を打てとは言へん）。
    expect(見当("embeded").map((h) => h.word)).toEqual(["embedded"]);
    expect(見当("clustar").map((h) => h.word)).toEqual(["cluster"]);
    // 二語に割る見当は残るが、収録の綴りが先（落とした一文字を足す方が遠ざからん）。
    const 列 = 見当("registraton");
    expect(列[0].word).toBe("registration");
    expect(列[0].count).toBeGreaterThan(列[列.length - 1].count);
  });

  it("二文字離れと収録外の語は黙る（噓の打ち手を表示しない）", () => {
    for (const 打ち手 of ["shorch", "keynote", "cameradd"]) {
      const 列 = 見当(打ち手).filter((h) => h.how === "retype");
      expect(列, `『${打ち手}』に一文字違ひの見當が出る`).toEqual([]);
    }
    // `specifical` は収録の語に一文字で屆かん（specific al 等）ので、切れ端も出して空になる
    // （旧 – 『cal』64 件・『specifi』4 件と打てない物を並べていた – 受皿の文に讓る）。
    expect(見当("specifical")).toEqual([]);
  });

  it("二字・三字の略語は収録の語なので打ち手から落さん", () => {
    // 語彙の門を嚴しくしていた時、`AI` が「収録に無い切れ端」と間違へられて落ちた。
    for (const 文 of ["AIセミナー", "HPCソナー", "OSトラック"]) {
      const 列 = 見当(文);
      expect(列.length, `『${文}』の打ち手が消えた`).toBeGreaterThan(0);
      expect(
        列.some((h) => /^(AI|HPC|OS)$/i.test(h.word)),
        `『${文}』に略語の打ち手が殘らん`,
      ).toBe(true);
    }
    expect(搜("AI")).toBe(1090);
  });

  it("轉位（隣り合う二文字の入れ替）も通す", () => {
    expect(見当("netwrok")[0].word).toBe("network");
    expect(見当("hybird")[0].word).toBe("hybrid");
    // ハイフンと空格は同じ骨に落ちる。
    expect(見当("camera redy").some((h) => h.how === "retype")).toBe(true);
  });

  it("画面の文が打ち手として件数を說ふ", () => {
    const 文 = "camera-redy";
    const out = String(畫面(袋(文, { shorterHits: 見当(文) })));
    expect(out).toContain(
      "検索語を「camera ready」に打ち替える（いまの絞り込みで 147 件当たります）",
    );
    const 音 = String(聲(袋(文, { shorterHits: 見当(文) })));
    expect(音).toContain("camera ready");
    expect(音).toContain("147");
    expect(Array.from(音).length).toBeLessThanOrEqual(60);
  });

  it("新しい runtime ファイルが build 側に載つている（成果物から黙って消えん為の張リ）", () => {
    const 配線 = readFileSync(join(REPO_ROOT, "site/recommender.ts"), "utf8");
    expect(配線).toContain('from "./latin-retype.ts"');
    const tsconfig = readFileSync(join(REPO_ROOT, "site/tsconfig.build.json"), "utf8");
    expect(tsconfig).toContain('"latin-retype.ts"');
    const build = readFileSync(join(REPO_ROOT, "src/build.ts"), "utf8");
    expect(build).toContain('"latin-retype.js"');
    // 説明も置いている（build.ts は説明表の型で強ひるが、寫らん内は通らん所以念）。
    expect(build).toContain("site/latin-retype.ts から生成する");
  });
});

it("打ち直しの件数は、打ち直した時に見える行で数える（第 761 回）", () => {
  /* 実測 2026-10-06: `デモができる会議` の提案「デモが」は素では 10 件だが、**画面の既定の
   * 絞り込みでは 0 件** – 提案に従ふと行き止まりに着いていた（第 756・757 回）。0 件の時に
   * **問ひを外した行**（今の絞り込みを通過する行）で数へる事を見る。
   * 行の動きはこの検查では追へない（DOM を持つ環境でしか動かん）ので、**配線**を張る。 */
  const runtime = siteRuntime();
  expect(runtime, "問ひを外した行で数えて居ない").toContain("shorterWordsForZero(searchQuery)");
  expect(runtime, "短い語の見当を、渡された行で数えて居ない").toContain("基準の行 ?? ");
  expect(runtime, "問ひを外した行を得て居ない").toContain('filter("")');
});
