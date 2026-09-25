/**
 * 『から』『以降』の付き方の検査。SPEC §4・§7・第 369 回。
 * 実測（2026-10-24 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で、直し前は
 * 相対語（`明日から` `来週から` `来年から` `8月上旬から`）だけ日にちの案内が出て、
 * 数が付いた形と曜日の語は**案内も無しで 0 行**だった – `3日前から` `1週間前から`
 * `10日後から` `1か月前から` `2年後から` `3か月後から` `3日以降` `1週間以降` `1か月以降`
 * `半年以降` `8月20日から` `2026-08-20から` `来週金曜から` `来月末から` `年度初めから`。
 * 其れより後の締切は既定の並びに並ぶので絞り込まない（第 328 回の決まり）が、
 * 黙って 0 行にはしない – 其の方の日を案内で書く。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 日の案内(語: string): string {
  return Recommender.relativeDayNotes(語, 基準).join(" ");
}

function 当たり行列表(語: string): string[] {
  const 目録 = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  const マッチ = Recommender.searchMatcher(語, 基準);
  return Recommender.candidateRows(目録)
    .filter((行) => マッチ(行.hay) === true)
    .map((行) => 行.hay);
}

describe("数と単位で打たれた『から』『以降』", () => {
  it("数の相対日は其の方の日を案内に書く（絞り込まない – 既定の並びに並ぶ）", () => {
    const 組: Array<[string, string]> = [
      ["3日前から", "2026年8月6日"],
      ["1週間前から", "2026年8月2日"],
      ["10日後から", "2026年8月19日"],
      ["1か月前から", "2026年7月9日"],
      ["3か月後から", "2026年11月9日"],
      ["2年後から", "2028年8月9日"],
      ["1年後から", "2027年8月9日"],
    ];
    for (const [打ち方, 日] of 組) {
      const 案内 = 日の案内(打ち方);
      expect(案内, `\`${打ち方}\` が案内も無しで 0 件の侭`).toContain(日);
      expect(案内, `\`${打ち方}\` の案内が其れより後だと言っていない`).toContain("以降");
      expect(当たり行列表(打ち方).length, `\`${打ち方}\` で行を足している`).toBe(0);
    }
  });

  it("単位だけの形（『3日以降』『1週間以降』）は其の方の単位ぶん後", () => {
    expect(日の案内("3日以降")).toContain("2026年8月12日");
    expect(日の案内("10日以降")).toContain("2026年8月19日");
    expect(日の案内("1週間以降")).toContain("2026年8月16日");
    /* 週は 1 週 = 7 日で寄せるが、月・年は日数に換えない（第 318 回の決まり）。 */
    expect(日の案内("1か月以降")).toContain("2026年9月9日");
    expect(日の案内("1か月以降")).not.toBe(日の案内("30日以降"));
    expect(日の案内("半年以降")).toContain("2027年2月9日");
  });

  it("和暦で打たれた日は其の日 – 過ぎた月日を打つ人は来年を見る", () => {
    expect(日の案内("8月20日から")).toContain("2026年8月20日");
    expect(日の案内("5月20日から"), "過ぎた月を其の年として書いていないか").toContain(
      "2027年5月20日",
    );
    expect(日の案内("2026-08-20から")).toContain("2026年8月20日");
    /* 週と曜日を繋げた形も同じ日にちで受ける（第 368 回と同じ暦の読み）。 */
    expect(日の案内("来週金曜から")).toContain("2026年8月14日");
  });

  it("月のまとまりの語は『末』は末日、『初め』は一日 – 幅の終わりは推測しない", () => {
    expect(日の案内("来月末から")).toContain("2026年9月30日");
    expect(日の案内("年度初めから")).toContain("2027年4月1日");
    expect(日の案内("年度末から")).toContain("2027年3月31日");
    expect(日の案内("年初から")).toContain("2027年1月1日");
  });
});

describe("案内を書かない打ち方", () => {
  it("月の範囲の言い方は其の方の欄が絞るので、其上に『絞りません』と書かない", () => {
    for (const 打ち方 of ["9月から", "9月以降", "来月から", "来月以降"]) {
      expect(日の案内(打ち方), `\`${打ち方}\` に絞りませんの案内を足している`).not.toContain(
        "絞り込まず",
      );
      expect(当たり行列表(打ち方).length, `\`${打ち方}\` が通らなくなっている`).toBeGreaterThan(0);
    }
  });

  it("日付の言い方でない『から』には何も言わない", () => {
    expect(日の案内("関西から")).toBe("");
    expect(日の案内("機械学習 関西")).toBe("");
  });

  it("解けない日付の言い方でも黙らせない – 絞れる欄の名前を書く", () => {
    const 案内 = 日の案内("100万年前から");
    expect(案内, "解けない形が案内も無しで 0 件の侭").toContain("探せないので");
    expect(案内).toContain("締切まで");
    expect(案内).toContain("過去の締切も表示");
    expect(当たり行列表("100万年前から").length).toBe(0);
  });

  it("今まで出ていた相対語の案内は動いていない", () => {
    expect(日の案内("明日から")).toContain("2026年8月10日以降");
    expect(日の案内("来週から")).toContain("2026年8月10日以降");
    expect(日の案内("来年から")).toContain("2027年1月1日以降");
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["function 以降の初日Ja", 1],
      ["function 日付らしき語Ja", 1],
      ["first = 以降の初日Ja(stem, nowMs);", 1],
      ["前の語を此の表の日として探せないので", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 14)}`).toBe(数);
    }
  });
});
