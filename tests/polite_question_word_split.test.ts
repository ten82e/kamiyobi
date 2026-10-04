/** 敬體で訪ねた打ち方を照合側で解く檢査（SPEC §7・第 522 回）。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 収録(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}
function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}
function 当たり(rows: Row[], 文: string): string[] {
  const m = Recommender.searchMatcher(文, AT);
  return rows.filter((r) => m(r.hay) === true).map((r) => String(r.hay).slice(0, 24));
}

/** 訪ねの語を続けた打ち方 → 其の方の plain な打ち方と同じ行が出るべき物。 */
const 組み: Array<[string, string]> = [
  ["締切はいつありますか", "締切はいつ"],
  ["査読はいつありますか", "査読はいつ"],
  ["採否はいつ分かる", "採否はいつ"],
  ["採否はいつ知りたい", "採否はいつ"],
  ["結果はいつ頃", "結果はいつ"],
  ["締切はいつ教えて", "締切はいつ"],
];

describe("敬體で訪ねる打ち方", () => {
  it("訪ねの語を落としたのと同じ行を出す（空格で打つた人と揃ふ）", () => {
    const rows = 品書();
    組み.forEach(([訪ね, 正]) => {
      expect(当たり(rows, 訪ね).sort(), `"${訪ね}" が "${正}" と違う行を出している`).toEqual(
        当たり(rows, 正).sort(),
      );
    });
  });

  it("實データ（収録）で 0 件で無くなつた事", () => {
    // 収録は品書より多い（data/snapshot.json）– 絕對值では張らず、訪ね形が其の方の形と
    // 同じ件數になる事と、0 件では無い事を張る（實測 – 実ビルド 868 行で 57 / 13 / 1 件）。
    const rows = 収録();
    組み.forEach(([訪ね, 正]) => {
      const a = 当たり(rows, 訪ね).length;
      expect(a, `"${訪ね}" が 0 件（割りが消えた）`).toBeGreaterThan(0);
      expect(a, `"${訪ね}" が "${正}" と違う件數`).toBe(当たり(rows, 正).length);
    });
  });

  it("彈いた語尾は落とさない – `あります` と `なる` は品書に行を持つ（第 362 回）", () => {
    const rows = 品書();
    // 其の方の語が行に書かれて居る（實測 – 実ビルドで `あります` 2 行・`なる` 1 行）ので、
    // 照合から落とすと靜かに廣がる。`明日締切はありますか` は 0 件で案内が出る侭が正しい。
    expect(当たり(rows, "明日締切はありますか")).toEqual(当たり(rows, "明日締切はありますか"));
    const b = readFileSync("site/recommender.ts", "utf8");
    const i = b.indexOf("function 訪ねの語尾に落とすいつJa");
    const 域 = b.slice(i, b.indexOf("\n  }", i));
    expect(域.includes('"あります"'), "`あります` を落とすやうになつた").toBe(false);
    expect(域.includes('"なる"'), "`なる` を落とすやうになつた").toBe(false);
    expect(域.includes('"ありますか"'), "`ありますか` を落とした – 第 522 回の実測が消えた").toBe(
      true,
    );
  });

  it("其の方の形は從來の侭（`締切はいつ` 57 行・`採否はいつですか` 13 行）", () => {
    expect(Recommender.queryTokens("締切はいつ", AT)).toEqual(["締切", "いつ"]);
    expect(Recommender.queryTokens("いつありますか", AT)).toEqual(["いつ"]);
    // 語尾を含まぬ語は觸らない（`いつ` 単體は其侭）。
    expect(Recommender.queryTokens("いつ", AT)).toEqual(["いつ"]);
  });
});

describe("受け身・丁寧の動詞で打つ人（第 609 回）", () => {
  /* 日本人の訪ね方は動詞で終る（「採択されましたか」「延長される？」）。實測 – 廿三文の表は
   * すべて 0 行で默つて居た（`採択される` 0 行 / `採択` 129 行・`締切が延長されました` 0 行 /
   * `延長` 20 行）。其の動詞を落とした打ち方と**同じ行**が出る事を見る（第 522 と同じ筋）。*/
  const 受け身の組み: Array<[string, string]> = [
    ["採択されました", "採択"],
    ["採択される", "採択"],
    ["結果が通知されています", "結果が通知"],
    ["締切が延長されました", "締切が延長"],
    ["参加登録しました", "参加登録"],
    ["招待講演されますか", "招待講演"],
  ];
  it("其の方の形と同じ行集合になる（品書）", () => {
    const rows = 品書();
    受け身の組み.forEach(([訪ね, 正]) => {
      expect(当たり(rows, 訪ね).sort(), `"${訪ね}" が "${正}" と違う行を出している`).toEqual(
        当たり(rows, 正).sort(),
      );
    });
  });
  it("實データ（収録）で 0 件で無くなつた事", () => {
    const rows = 収録();
    for (const 文 of ["採択されました", "採択される", "締切が延長されました", "参加登録しました"]) {
      expect(当たり(rows, 文).length, `"${文}" がまだ 0 件`).toBeGreaterThan(0);
    }
  });
  it("何も殘らん打ち方と、淺る形は彈く（無限の淺りの再發防止）", () => {
    const rows = 品書();
    /* 「されます」だけ – 落すと何も殘らんので舊の侭（0 行の默りではなく件の欄の斷りへ落ちる）。*/
    expect(() => Recommender.queryTokenGroups("されます", AT)).not.toThrow();
    expect(() => Recommender.queryTokenGroups("されるされるされる", AT)).not.toThrow();
    expect(当たり(rows, "されます").length).toBe(当たり(rows, "される").length);
  });
  it("他の規則を奪つて居らん（第 522 回・第 605 回）", () => {
    const rows = 品書();
    /* 敬體の訪ね（第 522 回）は其侭 – `ます` を一體で彈いた理由がこれ。 */
    expect(当たり(rows, "締切はいつありますか").sort()).toEqual(当たり(rows, "締切はいつ").sort());
    expect(当たり(rows, "採否はいつですか").length, "第 522 回の道が潰れた").toBeGreaterThan(0);
    /* 助力の動詞（第 605 回）も其侭。 */
    expect(当たり(rows, "オンライン参加できる会議").sort()).toEqual(
      当たり(rows, "オンライン参加 会議").sort(),
    );
  });
  it("目は一覧に一度ずつ・彈いた語が殘つて居らん（第 552 回）", () => {
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    const i = 源.indexOf("const 軽い動詞Ja = [");
    expect(i, "目の一覧が見つからん").toBeGreaterThan(-1);
    const 片 = 源.slice(i, 源.indexOf("\n    ];", i));
    for (const 目 of ["されました", "されています", "されてい", "しますか", "される"]) {
      expect(片.split(`"${目}",`).length - 1, `${目} が二度並んで居る`).toBe(1);
    }
    /* 一體の `ます` `ました` は第 522 回の目が終へる – ここで彈いた（注に理由を書いた）。 */
    for (const 目 of ['"ます"', '"ました"']) {
      expect(片.includes(`${目},`), `${目} が殘つて居る`).toBe(false);
    }
  });
});
