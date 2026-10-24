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
  it("数の相対日はその方の日から幅で絞る（第 476 回 – 案内でなく範囲で名乗る）", () => {
    const 組: Array<[string, string]> = [
      ["3日前から", "2026年8月6日"],
      ["1週間前から", "2026年8月2日"],
      ["10日後から", "2026年8月19日"],
      ["1か月前から", "2026年7月9日"],
      ["3か月後から", "2026年11月9日"],
      ["2年後から", "2028年8月9日"],
      ["1年後から", "2027年8月9日"],
    ];
    const 範囲 = (打ち方: string) =>
      (Recommender.dayRangePairs(打ち方, 基準) as Array<[string, string]>)[0]?.[1] || "";
    for (const [打ち方, 日] of 組) {
      expect(範囲(打ち方), `\`${打ち方}\` が其の方の日を決めていない`).toContain(日);
      expect(日の案内(打ち方), `\`${打ち方}\` に絞り込まない案内が残つた`).toBe("");
      /* その方が先の年（2 年後・1 年後）はこの品書に締切が無いので 0 件で正しい –
       * それ以遠を推して行を足して居ない事の実測。*/
      if (/年後/.test(打ち方)) {
        /* 実測 – 『1年後から』1 件・『2年後から』0 件（この品書の締切は 2027 年夏までに並ぶ為）。
         * その方の日から先の年まで勝手に幅を伸ばして居ない事は上の 範囲() の先で張る。*/
        expect(当たり行列表(打ち方).length).toBeLessThanOrEqual(1);
      } else {
        expect(当たり行列表(打ち方).length, `\`${打ち方}\` が 0 件の侭`).toBeGreaterThan(0);
      }
    }
  });

  it("単位だけの形（『3日以降』『1週間以降』）はその方の単位ぶん後から絞る（第 475 回）", () => {
    /* その日からの幅で絞れる形になつたので案内は出ない – その日の決め方はその侭（実測の行数で張る）。*/
    for (const [語, 件] of [
      ["3日以降", 423],
      ["10日以降", 414],
      ["1週間以降", 417],
      ["1か月以降", 362],
      ["半年以降", 94],
    ] as Array<[string, number]>) {
      expect(当たり行列表(語).length, `『${語}』が其の方の単位ぶん後から絞れて居ない`).toBe(件);
      expect(日の案内(語), `『${語}』に案内が残つた`).toBe("");
    }

    expect(当たり行列表("1か月以降")).not.toEqual(当たり行列表("30日以降"));
    /* 週は日数に換える – 『1週間以降』と『7日以降』は同じ行に出る（実測 416 件 ⇔ 416 件）。*/
    expect(当たり行列表("1週間以降")).toEqual(当たり行列表("7日以降"));
  });

  it("和暦で打たれた日はその日 – 過ぎた月日を打つ人は来年を見る", () => {
    const 範囲 = (打ち方: string) =>
      (Recommender.dayRangePairs(打ち方, 基準) as Array<[string, string]>)[0]?.[1] || "";
    expect(範囲("8月20日から")).toContain("2026年8月20日");
    expect(範囲("5月20日から"), "過ぎた月をその年として書いていないか").toContain("2027年5月20日");
    expect(範囲("2026-08-20から")).toContain("2026年8月20日");
    expect(日の案内("8月20日から"), "絞れる形に『絞りません』の案内が残つている").toBe("");
    /* 週と曜日を繋げた形も同じ日にちで受ける。 */
    /* 週と曜日を繋げた形も同じ幅で絞る。*/
    expect(範囲("来週金曜から")).toContain("2026年8月14日");
    expect(日の案内("来週金曜から")).toBe("");
    expect(当たり行列表("来週金曜から").length).toBeGreaterThan(0);
  });

  it("月のまとまりの語は『末』は末日、『初め』は一日 – その日から絞る（第 476 回）", () => {
    const 範囲 = (打ち方: string) =>
      (Recommender.dayRangePairs(打ち方, 基準) as Array<[string, string]>)[0]?.[1] || "";
    for (const [打ち方, 日] of [
      ["来月末から", "2026年9月30日"],
      ["年度初めから", "2027年4月1日"],
      ["年度末から", "2027年3月31日"],
      ["年初から", "2027年1月1日"],
    ] as Array<[string, string]>) {
      expect(範囲(打ち方), `\`${打ち方}\` が其の方の日を決めていない`).toContain(日);
      expect(日の案内(打ち方), `\`${打ち方}\` に案内が残つた`).toBe("");
    }
  });
});

describe("案内を書かない打ち方", () => {
  it("月の範囲の言い方はその方の欄が絞るので、其上に『絞りません』と書かない", () => {
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

  it("相対語の `から` は案内でなく幅で答える（第 476 回）", () => {
    /* 前はこの三語が 0 行＋案内だつた。その日の読み方は其侭 – 幅の方に出る。*/
    for (const [語, 件] of [
      ["明日から", 423],
      ["来週から", 423],
      ["来年から", 114],
    ] as Array<[string, number]>) {
      expect(当たり行列表(語).length, `\`${語}\` が絞れて居ない`).toBe(件);
      expect(日の案内(語), `\`${語}\` に案内が残つた`).toBe("");
    }
  });
});

describe("成果物", () => {
  it("直し方が実測どおりの形で成果物に入っている", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    for (const [条目, 数] of [
      ["function 以降の初日Ja", 1],
      ["function 日付らしき語Ja", 1],
      /* 第 475 回で案内側の連鎖は `その日以降の初日Ja` に抜けた – 其它の换算はその中にいる。*/
      ["return 以降の初日Ja(芯, nowMs);", 1],
      ["function 其の日以降の初日Ja", 1],
      ["前の語をこの表の日として探せないので", 1],
    ] as Array<[string, number]>) {
      expect(rec.split(条目).length - 1, `成果物の中の語の数: ${条目.slice(0, 14)}`).toBe(数);
    }
  });
});
