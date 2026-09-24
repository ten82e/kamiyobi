/**
 * 0 件の案内が「打った日付は、いま読み込んでいるデータの果てより先」を言うかの検査
 * （SPEC §7・第 293 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: `2027年3月` を検索欄に打つと 0 件で、案内は
 * 「別の語で試す（分野名・主題・開催地の日本語でも引けます）」だけだった。収録の側にはその月
 * だけで締切 40 件（会議 32 件）が在り、一覧に出る一番遠い締切 2027-02-04 で速く開くための
 * データが切れているだけ – 語を変えても増えないのに、打ち直しを勧めていた。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { deadlineHintFunction, jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 品の窓の切れ目を実測で持つ見立て（ビルドの値と同じ – 2026-08-09 生成ビルドで
 * `catalog.json` の `window.upcoming_days` = 180・`calendar.last_day` = 2028-03-30）。 */
/* 件数欄の内訳の見立て（窓で隠れている行数まで渡さないと、案内はその条件を
 * 候補に並べない – 第 264 回と同じ組み立て）。 */
const HIDDEN = { past: 120, est: 30, window: 0, rank: 0, cats: 0, domestic: 0, online: 0, kind: 0 };
const HORIZON = "2027-02-04";
const RECORD_LAST = "2028-03-30";

function clear(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    window: "all",
    past: false,
    cats: 0,
    domestic: false,
    online: false,
    rank: "all",
    kind: "",
    est: false,
    hiddenKindWords: [],
    termCounts: [],
    catalogConferences: 435,
    queryMatch: { catalog: 0, journal: 0 },
    hidden: { ...HIDDEN },
    loadedLastDay: HORIZON,
    recordLastDay: RECORD_LAST,
    horizonDays: 180,
    ...over,
  };
}

/* ビルドした実行時処理から、画面と同じ入口で日付の幅を取り出す（検査側に書き写さない）。 */
function daySpan(query: string): { first: string; last: string; label: string } | null {
  const rec = siteRuntime("recommender.js");
  const f = new Function(`${jsFunction(rec, "queryDaySpanJa")}; return queryDaySpanJa;`)() as (
    q: string,
  ) => { first: string; last: string; label: string } | null;
  return f(query);
}

function hintFor(query: string, over: Record<string, unknown> = {}): string {
  const hint = deadlineHintFunction();
  return hint(
    clear({
      query,
      // 描画側が検索語から計算して案内に渡す物なので、検査も同じ入口で計算して渡す。
      queryDaySpan: daySpan(query),
      termCounts: [{ term: query, count: 0 }],
      ...over,
    }),
  );
}

describe("0 件の案内が品の窓の切れ目を言う（第 293 回）", () => {
  it("月の語で、読み込んだ範囲より先なら、原因と押し先を言う", () => {
    const out = hintFor("2027年3月");
    expect(out).toContain("2027年3月");
    expect(out, "データの切れ目の日数が言われない").toContain(HORIZON);
    expect(out, "「収録の全体を読み込む」へ送っていない").toContain("収録の全体を読み込む");
    expect(out, "打ち直しの提案を並べたままだ").not.toContain("別の語で試す");
    expect(out, "原因を特定できたのに「多いのは」と推測している").toContain("外せる条件");
  });

  it("暦日と ISO の形でも同じことが言える（画面で引ける形をそのまま扱う）", () => {
    for (const q of ["2027年12月20日", "2027-12-20", "2027-12"]) {
      const out = hintFor(q);
      expect(out, `${q} で切れ目の話が出ない`).toContain("いま読み込んでいるデータ");
      expect(out, `${q} で切れ目の日数が無い`).toContain(HORIZON);
    }
  });

  it("収録その物より先なら、在るか分からないと正直に言う（押し先を作らない）", () => {
    const out = hintFor("2028年6月");
    expect(out).toContain(RECORD_LAST);
    expect(out, "収録の範囲より先の話を「全体を読み込めば出る」にしている").not.toContain(
      "収録の全体を読み込む",
    );
    expect(out, "無いと言っている").toContain("まだ確認できていません");
  });

  it("読み込んでいる範囲の中の日は、この話をしない（別が原因なのに嘘になる）", () => {
    for (const q of ["2026年10月5日", "2026-10-05"]) {
      const out = hintFor(q);
      expect(out, `${q} で品の窓の話が出た`).not.toContain("いま読み込んでいるデータ");
      expect(out, "通常の案内まで消えた").toContain("多いのは");
    }
  });

  it("切れ目にまたがる月は言わない（その月の半分は一覧に出る）", () => {
    const out = hintFor("2027年2月");
    expect(out, "一部だけ先の月を「先」と言い切っている").not.toContain("いま読み込んでいるデータ");
  });

  it("収録の全体を読んだあとは黙る（二度と同じ案内を出さない）", () => {
    const out = hintFor("2027年3月", { loadedLastDay: RECORD_LAST });
    expect(out).not.toContain("いま読み込んでいるデータ");
    expect(out).not.toContain("収録の全体を読み込む");
  });

  it("URL を貼った人を日付の話に引きずり込まない", () => {
    const out = hintFor("https://example.org/2027-03", { urlQuery: true, termCounts: [] });
    expect(out).not.toContain("いま読み込んでいるデータ");
  });

  it("品の窓の日数を知らないビルドでは、数を作らない", () => {
    const out = hintFor("2027年3月", { horizonDays: 0 });
    expect(out, "切れ目の話自体をしなかった").toContain("収録の全体を読み込む");
    expect(out, "日数をでっち上げた").not.toMatch(/生成から [0-9]/);
    const none = hintFor("2027年3月", { loadedLastDay: "" });
    expect(none, "データの果てを知らないのに「より先」と言った").not.toContain("より先です");
  });

  it("「締切まで」の窓が狭いときは、他の案内に重ねる（原因を一つに絞れない）", () => {
    const out = hintFor(
      "2027年3月",
      // 窓が狭いことを検査に出すには、件数欄と同じ「窓で隠れている行数」も渡す（0 だと
      // 案内は窓を候補に並べない – 第 264 回と同じ組み立て）。
      { window: "7", hidden: { ...HIDDEN, window: 412 } },
    );
    expect(out).toContain("いま読み込んでいるデータ");
    expect(out, "窓の話が消えた").toContain("「締切まで」を「かまわない」に変更");
    expect(out, "原因が二つあるのに一つに絞った言い方になっている").toContain("多いのは");
  });

  it("描画側が、日付の幅と品の果てを案内に渡している（渡し忘れで案内が黙らない）", () => {
    const app = siteRuntime();
    // 幅も果ても、描画側が実データから計算して案内に渡す – 案内の関数だけに有っても、
    // 画面では空振りする（第 293 回）。
    expect(app).toMatch(/queryDaySpan:\s*Recommender\.queryDaySpanJa\(searchQuery\)/);
    expect(app).toMatch(/loadedLastDay:\s*farthestRowDayJa\(rows\)/);
    expect(app).toMatch(/horizonDays:\s*DATA\.window\s*\?\s*DATA\.window\.upcoming_days\s*:/);
  });

  it("品書は、品の窓を越えた締切を一覧に混ぜていない", () => {
    const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as {
      generated_at?: string;
      window?: { upcoming_days?: number };
      calendar?: { last_day?: string };
      conferences?: { editions?: { deadlines?: { local_date?: string }[] }[] }[];
    };
    /* 見立ての日付（`HORIZON`・`RECORD_LAST`）は 2026-08-09 生成ビルドの実測で、ビルドの
     * 品書は検査ごとに作り替わるので、絶対値では比べない – 比べるのは不変側のほう。 */
    let farthest = "";
    (catalog.conferences || []).forEach((conf) => {
      (conf.editions || []).forEach((ed) => {
        (ed.deadlines || []).forEach((dl) => {
          const day = String(dl.local_date || "").slice(0, 10);
          if (day > farthest) farthest = day;
        });
      });
    });
    expect(farthest, "品書に締切が 1 件も無い").toBeTruthy();
    const cut = new Date(
      Date.parse(String(catalog.generated_at)) + Number(catalog.window?.upcoming_days) * 86400000,
    )
      .toISOString()
      .slice(0, 10);
    // 暦日の文字列は辞書順がそのまま日付順（ISO の利点はここ – 数に直さない）。
    expect(farthest <= cut, "品の窓を越えた締切が、一覧に差し込んでいる品書に載っている").toBe(
      true,
    );
    // 収録の果て（カレンダーの末尾）は、一覧に出る果てより手前にならない。
    if (catalog.calendar?.last_day) {
      expect(farthest <= String(catalog.calendar.last_day)).toBe(true);
    }
  });

  it("案内が使う押し先は、画面のボタンと同じ語（書き写しでズレない）", () => {
    const html = readFileSync(join(site, "index.html"), "utf8");
    const button = /id="fullRecordButton"[^>]*>([^<]+)</.exec(html);
    expect(button, "品書の全体を読み込むボタンが見つからない").not.toBeNull();
    const label = (button?.[1] || "").trim();
    expect(label).toBeTruthy();
    expect(hintFor("2027年3月"), `案内がボタン（${label}）と違う語を送っている`).toContain(label);
  });

  it("画面が読む品の窓は品書の申告で、てびきの書いた日数と一致している", () => {
    const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8")) as {
      window?: { upcoming_days?: number };
    };
    expect(catalog.window?.upcoming_days, "品書に品の窓の申告が無い").toBeTypeOf("number");
    const days = Number(catalog.window?.upcoming_days);
    expect(days).toBeGreaterThan(0);
    const html = readFileSync(join(site, "index.html"), "utf8");
    const guide = new RegExp(`${days} 日先`).test(html);
    expect(guide, `てびきに ${days} 日先と書かれていない（画面とてびきが別の数を言う）`).toBe(true);
  });
});

describe("検索語の日付の幅（第 293 回）", () => {
  it("一覧の検索が持つ形だけ、幅として取り出す", () => {
    expect(daySpan("2027年3月")).toEqual({
      first: "2027-03-01",
      last: "2027-03-31",
      label: "2027年3月",
    });
    expect(daySpan("2027年12月20日")).toEqual({
      first: "2027-12-20",
      last: "2027-12-20",
      label: "2027年12月20日",
    });
    expect(daySpan("2027-03")).toEqual({
      first: "2027-03-01",
      last: "2027-03-31",
      label: "2027-03",
    });
    expect(daySpan("2028-01-15")).toEqual({
      first: "2028-01-15",
      last: "2028-01-15",
      label: "2028-01-15",
    });
    // 月末は暦から求める（2028 年はうるう年）。
    expect(daySpan("2028年2月")?.last).toBe("2028-02-29");
    expect(daySpan("2027年2月")?.last).toBe("2027-02-28");
  });

  it("年を言わない形・有り得ない日付・会議名に付いた年数は幅にしない", () => {
    // 年を作ると締切の推測になるので扱わない（AGENTS.md の収録の契約）。
    expect(daySpan("3月10日")).toBeNull();
    expect(daySpan("10月")).toBeNull();
    expect(daySpan("2027年13月")).toBeNull();
    expect(daySpan("2027年2月31日")).toBeNull();
    expect(daySpan("MLSys 2027")).toBeNull();
    expect(daySpan("12345年1月")).toBeNull();
    expect(daySpan("")).toBeNull();
  });

  it("会議名に混じる語と並んでも、日付の語は拾える", () => {
    expect(daySpan("SC 2027年2月")?.first).toBe("2027-02-01");
  });
});
