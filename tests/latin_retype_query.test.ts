/**
 * 欧文の語を一字違ひに打った人へ、收錄の綴りを打ち手として出す路（第 680 回）。
 *
 * 實測（2026-08-09T00:00:00Z 生成の実ビルド・品書 3,250 行）– `camera-redy` `registraton`
 * `workshp` `embeded` `netwrok` `sumposium` `hybird` はいずれも搜 0 行で、語の切れ端の見当も
 * 當たるか空振りかで、畫面は「別の語で試す」の受皿に落ちるだけだつた。近い綴りの語は同じ品書に
 * `camera ready` 147 行・`registration` 66 行・`workshop` 174 行・`embedded` 982 行・
 * `network` 373 行・`symposium` 585 行・`hybrid` 111 行と出て居るのに、その一言が無かつた。
 *
 * 直しは**打ち手の提案だけ** – 搜し自体は廣げん（默つて廣げるのは第 246 回で禁じた）。
 * 一文字の插し・落・置換と隣り合う二文字の轉位だけを通す（二文字離れると誤爆するので彈く –
 * `specifical`・`shorch` は默つた侭）。收錄に無い語（`keynote`）も默る（噓の打ち手を出さん）。
 * 表の作りは `site/latin-retype.ts`（新しい runtime 檔案 – 1 MiB の壁を越えん為の分け方でも在る）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { deadlineHintFunction, zeroResultLiveFunction } from "./runtime_extract.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 畫面 = deadlineHintFunction();
const 聲 = zeroResultLiveFunction();
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(join(REPO_ROOT, "data/snapshot.json"), "utf8")),
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

/** 0 件の畫面の袋（外せる条件は既定の二つ – 第 632 回の実測の形）。 */
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

describe("欧文の一字違ひに收錄の綴りを見當として出す（第 680 回）", () => {
  it("品書は實測した 3,250 行の侬（桁が違へば上の實測が讀み直せんなる）", () => {
    expect(品書.length).toBe(3250);
  });

  it("七語が收錄の綴りへ屆く（打ち手の先頭に立つ）", () => {
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
      // 見當に說ふ件數は搜し欄と同じ數（檢べが別々の數へ方をして居ん證）。
      expect(搜(綴り), `『${綴り}』を搜した數と揃ふ`).toBe(件);
    }
  });

  it("搜し自体は廣がらん（默つて隣りの綴りまで連れて来ん）", () => {
    for (const 打ち手 of ["camera-redy", "embeded", "netwrok", "sumposium"]) {
      expect(搜(打ち手), `『${打ち手}』の搜しは 0 行の侬`).toBe(0);
    }
    // 近い綴りの方を搜せば同じ行が出る – 打ち手が效いて居る證。
    expect(搜("embedded")).toBeGreaterThan(0);
  });

  it("收錄の綴りは語の切れ端より先に出し、切れ端は打ち手から落す", () => {
    // 實測 – 『embe』63 件・『ded』16 件と並んで居た（收錄の語で無い切れ端を打てとは言へん）。
    expect(見当("embeded").map((h) => h.word)).toEqual(["embedded"]);
    expect(見当("clustar").map((h) => h.word)).toEqual(["cluster"]);
    // 二語に割る見當は殘るが、收錄の綴りが先（落とした一文字を足す方が遠ざからん）。
    const 列 = 見当("registraton");
    expect(列[0].word).toBe("registration");
    expect(列[0].count).toBeGreaterThan(列[列.length - 1].count);
  });

  it("二文字離れと收錄外の語は默る（噓の打ち手を出さん）", () => {
    for (const 打ち手 of ["shorch", "keynote", "cameradd"]) {
      const 列 = 見当(打ち手).filter((h) => h.how === "retype");
      expect(列, `『${打ち手}』に一文字違ひの見當が出る`).toEqual([]);
    }
    // `specifical` は收錄の語に一文字で屆かん（specific al 等）ので、切れ端も出して空になる
    // （舊 – 『cal』64 件・『specifi』4 件と打てない物を並べて居た – 受皿の文に讓る）。
    expect(見当("specifical")).toEqual([]);
  });

  it("二字・三字の略語は收錄の語なので打ち手から落さん", () => {
    // 語彙の門を嚴しくして居た時、`AI` が「收錄に無い切れ端」と間違へられて落ちた（第 680 回の実測）。
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
    // ハイフンと空格は同じ骨に落ちる（第 680 回の門）。
    expect(見当("camera redy").some((h) => h.how === "retype")).toBe(true);
  });

  it("畫面の文が打ち手として件數を說ふ", () => {
    const 文 = "camera-redy";
    const out = String(畫面(袋(文, { shorterHits: 見当(文) })));
    expect(out).toContain("検索語を「camera ready」に打ち替える（収録で 147 件当たります）");
    const 音 = String(聲(袋(文, { shorterHits: 見当(文) })));
    expect(音).toContain("camera ready");
    expect(音).toContain("147");
    expect(Array.from(音).length).toBeLessThanOrEqual(60);
  });

  it("新しい runtime 檔案が build 側に載つて居る（成果物から黙って消えん為の張リ）", () => {
    const 配線 = readFileSync(join(REPO_ROOT, "site/recommender.ts"), "utf8");
    expect(配線).toContain('from "./latin-retype.ts"');
    const tsconfig = readFileSync(join(REPO_ROOT, "site/tsconfig.build.json"), "utf8");
    expect(tsconfig).toContain('"latin-retype.ts"');
    const build = readFileSync(join(REPO_ROOT, "src/build.ts"), "utf8");
    expect(build).toContain('"latin-retype.js"');
    // 説明も置いて居る（build.ts は説明表の型で強ひるが、寫らん內は通らん所以念）。
    expect(build).toContain("site/latin-retype.ts から生成する");
  });
});
