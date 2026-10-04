/** 寄せ表の**並べた語**を搜しが語ごとに數える檢査（SPEC §7・第 675 回）。
 *
 * 搜しの述語は、寄せ表（開催地・主題の別表記）が語を並べた綴りを持つ時、其の侬の文字列を
 * 連なりで探して居た（2026-08-09 生成の実ビルド・搜しの品書 3,250 行で實測）。
 *   `ネットワーク測定` → `network measurement`（連なりで書く行は 0 行）
 *   同じ二語を別々に書く行は 21 行（IMC・PAM – `network measurement` と打つ人は 21 行受ける）
 * よって和名を打つ人だけ 0 行で、搜し欄に英語で打つ人との差が開いて居た。檢査側の門
 * 「別表記の表は、実際に新しい行を増やしている」は已に語に割つて數えて居り、**門と實裝が
 * ズレて居た**のが根本原因（`site/recommender.ts` の `matchFoldedGroups` を `latinFoldedHit`
 * に纏め、並べ語は語ごとに同じ門を通すやうにした – 表示は變はらん）。
 *
 * 载せ直した五本（`性能評価`・`ワイヤレスネットワーク`・`ネットワーク測定`・`ネットワーク計測`・
 * `ネットワーク管理`）と、此の直しで初めて屆くやうにした七本（`データ管理`・`データマネジメント`・
 * `分散ファイル`・`分散ファイルシステム`・`ヘテロジニアス計算`・`ヘテロジニアスコンピューティング`・
 * `メタバース`）を張る。載せきれん組（收錄が和名 only で
 * 書く語を含む `distributed file system`）もその理由ごと張る。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
type Row = { hay: string };
function 品書(): Row[] {
  /* 搜の土臺は實際の品書（目録 3,280 行とは少し當りが違ふので、此方の數を正とする）。*/
  return Recommender.candidateRows(
    JSON.parse(readFileSync(`${REPO_ROOT}/data/snapshot.json`, "utf8")),
  ) as Row[];
}
const rows = 品書();
function 當る行(文: string): Row[] {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, AT), AT);
  return rows.filter((r) => m(String(r.hay)) === true);
}
function 當(文: string): number {
  return 當る行(文).length;
}
function 畳(文: string): string {
  return String(文).normalize("NFKC").toLowerCase();
}
function 注(文: string): string {
  return Recommender.querySynonymNotes(文).join("\n");
}

/** 此の回に屆いた十二本（載せる前は搜し 0 行 – 實測の當り）。 */
const 載せ直: [string, string, number][] = [
  ["性能評価", "performance evaluation", 2],
  ["ワイヤレスネットワーク", "wireless networks", 13],
  ["ネットワーク測定", "network measurement", 21],
  ["ネットワーク計測", "network measurement", 21],
  ["ネットワーク管理", "network management", 5],
  ["データ管理", "data management", 51],
  ["データマネジメント", "data management", 51],
  ["分散ファイル", "file system", 15],
  ["分散ファイルシステム", "file system", 15],
  ["ヘテロジニアス計算", "heterogeneous computing", 1],
  ["ヘテロジニアスコンピューティング", "heterogeneous computing", 1],
  ["メタバース", "metaverse", 1],
];

describe("並べた語の寄せ先を搜しが語ごとに數える（第 675 回）", () => {
  it("十二本が搜しで行を受け、案内が英字の綴りを復唱する", () => {
    for (const [和名, , 件] of 載せ直) {
      expect(當(和名), `搜 ${和名}`).toBe(件);
      expect(注(和名), `${和名} の案内が英字を復唱して居ん`).toContain("も探しています");
    }
  });

  it("当たりは寄せ先の語を**すべて**持つ – 語を離して書く收錄に屆いた證", () => {
    for (const [和名, 英] of 載せ直) {
      const 語 = 英.split(/\s+/).filter(Boolean);
      const 外 = 當る行(和名).filter((r) => {
        const x = 畳(r.hay);
        if (x.includes(畳(和名))) return false;
        return !語.every((w) => x.includes(畳(w)));
      });
      expect(外, `${和名} が寄せ先の語を揃へん行を當てた`).toEqual([]);
    }
    /* 連なりを數えた昔は `ネットワーク測定` は 0 行だつた – 今は其の方の英字を打つ人と同じ數。*/
    expect(當("network measurement"), "英字を打つ人と和名を打つ人の数がズレた").toBe(
      當("ネットワーク測定"),
    );
  });

  it("收錄が和名だけで書く語は寄せ先にならん – `分散ファイル` を寄せる先", () => {
    /* `distributed file system` と寄せると 0 行の侬だつた（搜しは語ごとに數えるが、FAST ら
     * 15 行は `distributed` を英文字で書かず、分野欄の和名 `分散` だけ持つ – 內譯で實測）。
     * `file system` なら其の 15 行と**同じ集まり**に屆く（行のキーまで揃ふ）。*/
    expect(當("distributed file system")).toBe(15);
    expect(
      當る行("distributed file system").filter((r) => 畳(r.hay).includes("distributed")),
      "distributed を英文字で書く行が入つたか？",
    ).toEqual([]);
    expect(new Set(當る行("分散ファイル").map((r) => 畳(r.hay)))).toEqual(
      new Set(當る行("distributed file system").map((r) => 畳(r.hay))),
    );
    expect(當("分散ファイル")).toBe(15);
  });

  it("助詞で割れる和名も载せられるやうにした – 拔いた理由の订正（第 676 回）", () => {
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    /* 第 674 回は「搜しが助詞の で先に割れるので載せても屆かん」（決まり⑤）と拔いた。實は割れる
     * 事自体が穴だつた – 搜し側が寄せ表の鍵を守るやうにしたので（`splitQueryToken` の門）、其の侬が
     * 鍵として引ける。載せ直して屆いた實測は `tests/japanese_particle_compound_alias_search.test.ts`。*/
    expect(
      表.includes('["モノのインターネット", "IoT"]'),
      "モノのインターネット が載つて居ん",
    ).toBe(true);
    expect(當("モノのインターネット"), "搜し欄で IoT と打つ人は 9 行").toBe(9);
    expect(Recommender.queryTokenGroups("モノのインターネット", AT)).toEqual([
      ["モノのインターネット", "IoT", "internet of things"],
    ]);
    /* 略語の門（第 414 回）は其侭 – 英字の綴り側も同じ組を向く。*/
    expect(Recommender.queryTokenGroups("IoT", AT)[0]).toContain("internet of things");
  });

  it("搜の振ひは無傷 – 並べ語の門を纏めても單語の當たりは今まで通り", () => {
    const 金庫: Record<string, number> = {
      暗号: 117,
      視覚: 250,
      機械学習: 504,
      AI: 1090,
      ネットワーク: 257,
      multimedia: 69,
      計算機科学: 0,
      検索技術: 58,
      "30日以内": 689,
      "7日以内": 206,
      OA: 0,
      // 單語の門は今まで通り（`system` は `systems` を含めて數へる – 語尾を閉ぢん理由）。
      file: 15,
      systems: 1004,
      system: 1004,
    };
    for (const [文, 件] of Object.entries(金庫)) expect(當(文), `搜 ${文}`).toBe(件);
    expect(rows.length).toBe(3250);
    /* 讓りが數へん直す – 門と實裝が揃つたので、案内に出す件數も其の方の当たりと齒合いが合う。*/
    expect(當("情報理論"), "並べ語の語ごとに數えて增えた筈").toBe(9);
    expect(當("高性能計算")).toBe(207);
    const 表 = readFileSync(`${REPO_ROOT}/site/topic-aliases.ts`, "utf8");
    expect((表.match(/^\s*\["/gm) || []).length, "条目の合計が計畫外に動いた").toBe(138);
  });
});
