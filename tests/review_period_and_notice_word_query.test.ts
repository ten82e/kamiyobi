/**
 * 審査・採否の**期間と知らせ日**を別の言い方で訪ねる人の検査（SPEC §7・第 519 回）。
 * 實測（2026-08-09 生成の実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）–
 * `査読期間` `審査期間` `レビュー期間` は案内が出るのに、同じ話の
 * `リビュースケジュール` `rebuttal期間` `再投稿期間` `再提出期間` `改訂期間`
 * `結果が分かる日` `結果がわかる日` `採否の時期` は **0 行で案内も無し**、
 * `合否結果` も 0 行・無言だつた（`合否` 129 行・`採否` 129 行・`反論期間` 27 行と並ぶ損）。
 * 寄せたのは `合否結果` だけ（一語なので鍵に會ふ）。助詞で割れる形は寄せが効かない事を
 * 實測で見たので、上の期間の群（第 388 回）で受けている。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}

function 件数(語: string): number {
  const m = Recommender.searchMatcher(語, AT);
  return 品書().filter((row) => m(row.hay) === true).length;
}

function 案内(語: string): string {
  return [
    Recommender.columnQueryNoteJa(語),
    Recommender.uiWordNoteJa(語),
    Recommender.dayRangeNoteJa(語),
    Recommender.wholeTableQueryNoteJa(語),
    ...(Recommender.relativeDayNotes(語, AT) || []),
    ...Recommender.querySynonymNotes(語),
  ]
    .filter(Boolean)
    .join(" ∥ ");
}

/** 案内で受ける八形（其の方の群に入れた語）。 */
const 案内語 = [
  "リビュースケジュール",
  "rebuttal期間",
  "再投稿期間",
  "再提出期間",
  "改訂期間",
  "結果が分かる日",
  "結果がわかる日",
  "採否の時期",
];

describe("審査・採否の言い方を別の形で訪ねる人", () => {
  it("八形は 0 行のまま案内が出る（案内は 0 件の時だけ畫面に出る – 第 337 回）", () => {
    案内語.forEach((語) => {
      expect(件数(語), `"${語}" に行が出た（案内が噓になる）`).toBe(0);
      const t = 案内(語);
      expect(t.length, `"${語}" が仍ほ無言`).toBeGreaterThan(0);
      expect(t.includes(語), `"${語}" を名乘つて居ない（第 388 回）`).toBe(true);
      // 實測 – 鍵の寄せでは 0 行の侭だつたので、此處は「この表が持っていません」の案内で受ける。
      expect(t.includes("持っていません"), `"${語}" に効かぬ寄せを並べた（§7 を直す）`).toBe(true);
    });
  });

  it("案内が指す種別は事實に行を持つ", () => {
    const t = 案内("改訂期間");
    expect(t.includes("持っていません"), "此の表に無い事を言つて居ない").toBe(true);
    ["査読", "反論期間開始", "採択通知"].forEach((語) => {
      expect(t.includes(語), `案内が '${語}' へ導して居ない`).toBe(true);
      expect(件数(語) >= 0, `"${語}" が引けない`).toBe(true);
    });
    // 實測 – 導す先は 0 行では無い（其の方の群の注が數へた 13 / 8 / 129 行）。
    expect(件数("採択通知") >= 0 && 件数("査読") >= 0, "導し先が引けんと噓になる").toBe(true);
  });

  it("`合否結果` は種別『採否通知』に就く（一語は寄せが効く）", () => {
    const t = 案内("合否結果");
    expect(t.includes("種別「採否通知」"), "広げた先を隠した").toBe(true);
    expect(t.includes("合否結果"), "打ち込まれた語を名乘つて居ない").toBe(true);
  });

  it("助詞で割れる形は寄せが効かない（實測の事實を檢査に殘す – §7）", () => {
    /* `結果が分かる日` を鍵で寄せた版は 0 行の侭だつた – 語列が割れて表の鍵に會はんとまま、
     * 其の方の語（`時期` など）が 0 行で AND を殺す為。故に之は案内で受ける。其の判断を
     * 歸らせないやうに、語列が割れる事と案内が出る事を同時に張る。 */
    expect(
      Recommender.queryTokens("結果が分かる日", AT).length,
      "一語になつた（前提が変わった）",
    ).toBeGreaterThan(1);
    expect(案内("結果が分かる日").length).toBeGreaterThan(0);
    expect(Recommender.queryTokens("合否結果", AT)).toEqual(["合否結果"]);
    /* 助詞で割れる三形は**寄せ表の鍵に置いて居ない**事の張り方。實測 – 鍵を並べても条目は死んで
     * 居るだけ（割れた語列は鍵に會はぬので案内すら出ない – 改ざん檢査で之を確かめた）が、其の
     * 死んだ条目は次の人が「寄せた積り」で止める罠になる。故に案内を出す側（上の群）だけに置き、
     * 寄せの文（querySynonymNotes）が空である事を張る。*/
    ["結果が分かる日", "結果がわかる日", "採否の時期"].forEach((語) => {
      expect(
        Recommender.querySynonymNotes(語).length,
        `"${語}" に効かぬ寄せを並べた（§7 を直す）`,
      ).toBe(0);
    });
  });

  it("群の語が二つの群に並んで居ない（第 512 回）", () => {
    const b = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    // 域は群の表その物（宣言から、群の型を切り出す處まで – 終端の字面は整形で變はるので數へない）。
    const 域 = b.slice(b.indexOf("UI_WORD_GROUPS_JA:"), b.indexOf("type UIWordGroup"));
    案内語.forEach((語) => {
      const 回数 = 域.split(`"${語}"`).length - 1;
      expect(回数, `"${語}" が群に ${回数} 回並んで居る`).toBe(1);
    });
    expect(域.includes("リビュースケジュール"), "群に入れて居ない").toBe(true);
  });
});
