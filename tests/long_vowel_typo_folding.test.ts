import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
);
const 当たり = (文: string): number => {
  const m = Recommender.searchMatcher(Recommender.expandRelativeMonths(文, 基準), 基準);
  return 品書.filter((r: { hay?: string }) => m(String(r.hay)) === true).length;
};
const 折 = (文: string, 代: string): string => 文.split("ー").join(代);
/** 長音の代はりに打たれる字（NFKC を通っても ー に落ちない物）。 */
const 代 = ["－", "−", "‐", "‑", "–", "—", "-", "～"];

describe("長音の打ち違ひを寄せる（第 639 回）", () => {
  it("品書に出る片假名語 – 八文字の変換が本物と同じ行数で当たる", () => {
    const 語 = new Set<string>();
    for (const r of 品書)
      for (const w of String((r as { hay?: string }).hay).split(/[^぀-ヿー]+/))
        if (w.length >= 4 && w.includes("ー")) 語.add(w);
    expect(語.size, "品書から片假名語が拾へん（分割の方眼が崩れた）").toBeGreaterThan(30);
    let 變換 = 0;
    let 屆く = 0;
    for (const w of 語)
      for (const c of 代) {
        變換 += 1;
        if (当たり(折(w, c)) === 当たり(w)) 屆く += 1;
      }
    expect(屆く, `變換 ${變換} 本の內 ${變換 - 屆く} 本が本物と違う行数`).toBe(變換);
  });
  it("語末の長音も寄る – `デンバー-` は街の名前（第 639 回で残つた漏れ）", () => {
    for (const c of 代)
      expect(当たり(`デンバー${c}`), `語末の ${c} が屆かん`).toBe(当たり("デンバー"));
    expect(当たり("デンバー"), "街の名前その物が数えられん").toBeGreaterThan(0);
  });
  it("拉丁と数字の次は寄せん – 區切りのハイフンはその侬", () => {
    for (const 文 of ["HPC-Grid", "2024-2026", "C++", "ネットワーク-2026"]) {
      expect(Recommender.searchNormalize(文), `折り過ぎた: ${文}`).toBe(
        文.normalize("NFKC").toLowerCase(),
      );
    }
  });
  it("検索の語と品書に同じ目を通す – 正則化が揃つている", () => {
    expect(Recommender.searchNormalize("デ－タベース")).toBe(
      Recommender.searchNormalize("データベース"),
    );
    expect(Recommender.searchNormalize("ネットワ～ク")).toBe(
      Recommender.searchNormalize("ネットワーク"),
    );
  });
});

describe("和名で書かれた打ち手（第 639 回）", () => {
  it("`特別号` は収録の表記『特集号』に寄せる – 旧 0 行で案内も無かつた", () => {
    expect(当たり("特別号"), "旧ビルドで 0 行だった筈").toBeGreaterThan(0);
    expect(当たり("特別号")).toBe(当たり("特集号"));
    const 說 = (Recommender.querySynonymNotes("特別号") || []).join("");
    expect(說, "寄せた事を画面に表示しない").toContain("特集号");
  });
  it("`校了` は載せ替へん – 旧來案内が出て居て、寄せるとそれが消える", () => {
    expect(当たり("校了"), "行が出ていたら判斷が変はる").toBe(0);
    const 案 = String(Recommender.uiWordNoteJa("校了", false) || "").trim();
    expect(案, "讓した語が黙つている – 今度の理由がない").not.toBe("");
  });
});
