/**
 * 数値の相対日が「日」以外の単位も前後とも受ける事の検査。SPEC §4・§7・第 367 回。
 * 実測（2026-10-23 – 実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）で、直し前は
 * `1週間前` `2週間前` `1か月前` `2か月後` `1年前` `2年後` `半年前` が**すべて 0 行・案内も無し**
 * （同じビルドで `1週間後` 17 行・`7日前` 7 行・`3日前` 3 行は通る – 前側と月・年の単位だけが
 * 落ちていた）。日の言い方も明後日（+2）に当たる一昨日（-2）が無く、週の語も `昨週`、
 * 月の語も `昨月` が無かった。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 当たり行列表(語: string): string[] {
  const 目録 = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  const 品書 = Recommender.candidateRows(目録);
  const マッチ = Recommender.searchMatcher(語, 基準);
  return 品書.filter((行) => マッチ(行.hay) === true).map((行) => 行.hay);
}

function 日の案内(語: string, 基準時刻: number = 基準): string {
  return Recommender.relativeDayNotes(語, 基準時刻).join(" ");
}

function 幅の案内(語: string): string {
  return Recommender.dayRangeNoteJa(語);
}

describe("数値の相対日の単位と前側", () => {
  it("週の前は、同じ数日の前と同じ行を出す（1 週 = 7 日は暦の決まり）", () => {
    const 組: Array<[string, string]> = [
      ["1週間前", "7日前"],
      ["2週間前", "14日前"],
      ["3週間前", "21日前"],
    ];
    let 当たった物 = 0;
    for (const [打ち方, 寄せ先] of 組) {
      const 相手 = 当たり行列表(寄せ先);
      const 自分 = 当たり行列表(打ち方);
      const 差 = 自分
        .filter((文) => 相手.indexOf(文) < 0)
        .concat(相手.filter((文) => 自分.indexOf(文) < 0));
      expect(差, `\`${打ち方}\` が \`${寄せ先}\` と違う行を出している`).toEqual([]);
      /* 案内は其の方が指す日を其のまま書く – 行の無い打ち方でも噓をつかない為、
       * 行の有無に依らない検査を上に置く（品書の行数に依る固定値は張らない）。 */
      expect(日の案内(打ち方), `\`${打ち方}\` の日にちの案内が無い`).toContain("=");
      expect(
        日の案内(打ち方).split(" = ")[1],
        `\`${打ち方}\` の案内が \`${寄せ先}\` と違う日を書いている`,
      ).toBe(日の案内(寄せ先).split(" = ")[1]);
      if (相手.length > 0) 当たった物++;
    }
    expect(当たった物, "三つの形すべて品書に当たらず、検査が空振りしている").toBeGreaterThan(0);
  });

  it("か月・年は日数に換えない（暦の上で其の単位ぶん動かす）", () => {
    /* 「1 か月 = 30 日」は畫面のどこにも書いていないので、其の方の語と同じ行にしてはならない
     * （第 318 回の決まり）。其の日の案内に出る日付で張る。 */
    expect(日の案内("1か月前"), "1 か月前が 30 日前と同じ日になっている").toContain("2026年7月9日");
    expect(日の案内("30日前")).toContain("2026年7月10日");
    expect(日の案内("半年前"), "半年前が 180 日前と同じ日になっている").toContain("2026年2月9日");
    expect(日の案内("180日前")).not.toBe(日の案内("半年前"));
    expect(日の案内("1年前")).toContain("2025年8月9日");
    expect(日の案内("1か月後")).toContain("2026年9月9日");
    expect(日の案内("2年後")).toContain("2028年8月9日");
  });

  it("短い月に動かす日は其の月の末日に置く（4月31日を作らない）", () => {
    /* JST の暦日で張る – UTC の時刻をそのまま渡すと前の日になる（其上の 9 時間ずらす
     * 決まりと同じ – 実測で検査の方が間違っていても取れた）。 */
    const 三月三十一日 = Date.parse("2026-03-30T15:00:00Z"); // JST 2026年3月31日
    expect(日の案内("1か月前", 三月三十一日), "2月31日を作っている").toContain("2026年2月28日");
    const 五月三十一日 = Date.parse("2026-05-30T15:00:00Z"); // JST 2026年5月31日
    expect(日の案内("1か月前", 五月三十一日), "4月31日を作っている").toContain("2026年4月30日");
    expect(日の案内("7か月前", 五月三十一日)).toContain("2025年10月31日");
  });

  it("表記ゆれで打たれても受ける – 案内は打たれた形を書く（寄せた形に化けない）", () => {
    for (const 打ち方 of ["1か月前", "1カ月前", "1ヶ月前", "1ケ月前", "1ヵ月前", "1箇月前"]) {
      const 案内 = 日の案内(打ち方);
      expect(案内, `\`${打ち方}\` の案内が無い`).toContain(打ち方);
      expect(案内, `\`${打ち方}\` の案内が日付を書いていない`).toContain("2026年7月9日");
    }
  });

  it("上限を超えた打ち方は寄せない（今日の日を其の通りに書かない）", () => {
    for (const 打ち方 of ["999か月前", "40年前", "121か月前", "31年後"]) {
      expect(日の案内(打ち方), `\`${打ち方}\` を其の通りだと嘘をついている`).toBe("");
      expect(当たり行列表(打ち方).length, `\`${打ち方}\` が行を出している`).toBe(0);
    }
  });
});

describe("日の言い方の対になる語", () => {
  it("明後日に対して一昨日、翌週に対して昨週、来月に対して昨月が同じ数え方", () => {
    const 組: Array<[string, string]> = [
      ["一昨日", "2日前"],
      ["おととい", "2日前"],
      ["明々後日", "3日後"],
      ["昨週", "先週"],
      ["昨月", "先月"],
    ];
    for (const [打ち方, 対] of 組) {
      const 相手 = 当たり行列表(対);
      expect(相手.length, `対の \`${対}\` の行が無い – 比較できない`).toBeGreaterThan(0);
      const 自分 = 当たり行列表(打ち方);
      const 差 = 自分
        .filter((id) => 相手.indexOf(id) < 0)
        .concat(相手.filter((id) => 自分.indexOf(id) < 0));
      expect(差, `\`${打ち方}\` が \`${対}\` と違う行を出している`).toEqual([]);
    }
  });
});

describe("過去方向に開いた幅（『3日前まで』）", () => {
  const 形列表 = ["3日前まで", "1週間前まで", "1か月前まで", "半年前まで", "2年前まで"];

  it("黙って 0 件にせず、過ぎた締切の欄の名前を書く", () => {
    for (const 打ち方 of 形列表) {
      const 案内 = 幅の案内(打ち方);
      expect(案内, `\`${打ち方}\` が案内も無しで 0 件`).toContain("過去の締切も表示");
      expect(案内, `\`${打ち方}\` の案内が打たれた語を書いていない`).toContain(打ち方);
      expect(案内, `\`${打ち方}\` の案内が幅の開きを言っていない`).toContain("いつまで遡るか");
      expect(当たり行列表(打ち方).length, `\`${打ち方}\` で行を足している`).toBe(0);
    }
  });

  it("件数欄の短い一文は 70 字以内に収まる", () => {
    for (const 打ち方 of 形列表) {
      const 文 = Recommender.dayRangeLiveNoteJa(打ち方);
      expect(文.length, `\`${打ち方}\` の件数欄の文が長い: ${文.length} 字`).toBeLessThan(70);
      expect(文).toContain("過去の締切も表示");
    }
  });

  it("締切の日まで受ける形（『明日までに』『8月22日まで』）は動かしていない", () => {
    expect(当たり行列表("明日までに").length).toBeGreaterThan(0);
    expect(幅の案内("明日までに")).not.toContain("過去の締切も表示");
    expect(当たり行列表("8月22日まで").length).toBeGreaterThan(0);
    /* 画面の絞り込みと同じ話になる形も其の方の案内の侭。 */
    expect(幅の案内("30日以内")).toContain("「締切まで」");
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["const PAST_RANGE_UNTIL_JA = ", 1],
      /* `半年後` は相対語の表・数値の相対日の規則・日付の語の表（第 399 回）の三處に並ぶ。
       * 第 426 回 – 数値の相対日の目印に『半月後を通す代わりに半年後は通さない』注が加わり 4 處。*/
      ["半年後", 7],
      ["昨週: -1", 1],
      ["一昨日: -2", 1],
      ["昨月: -1", 1],
      ["明々後日: 3", 1],
      ["(?:週間|週)\\s*(?:前|まえ)/g, (n) => ", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 20)}`).toBe(数);
    }
  });
});
