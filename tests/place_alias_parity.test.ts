/**
 * 同じ国を指す言い方が、同じ行に出会うかの検査（SPEC §4・§7・第 311 回）。
 * ビルド済みサイトは `tests/built_site.ts` 経由で共有する。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; ed?: { place?: string }; conf?: { acronym?: string } };

function rows(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as {
      conferences: unknown;
    },
  ) as Row[];
}

const AT = Date.parse("2026-08-09T00:00:00Z");

/* 品書は 1 回だけ読む – 呼び出すたびに新しい行オブジェクトが出来ると、集合の突き合わせが
 * 全部「別物」になって差分が空にならない（実測で 6 行の偽の差が出た）。 */
const ROWS = rows();

function reached(word: string, source: Row[] = ROWS): Set<Row> {
  const matcher = Recommender.searchMatcher(word, AT);
  return new Set(source.filter((r) => matcher(r.hay) === true));
}

it("同じ国を指す二つの言い方が、同じ行に出会う（第 311 回）", () => {
  /* 画面の開催地は「Edinburgh, イギリス」の形（表示ラベル）を出す – ラベルの語を打った人は
   * 当たり、書き言葉で多い「英国」を打った人だけ会えない、という形になっていた（実測: `英国`
   * 18 行 / `イギリス` 32 行 – 開催地に `United Kingdom` と書く行が届かなかった）。 */
  for (const [a, b] of [
    ["英国", "イギリス"],
    ["イギリス", "英国"],
    ["米国", "アメリカ"],
    ["アメリカ", "米国"],
  ] as const) {
    const A = reached(a);
    const B = reached(b);
    const 片側だけ = [...A].filter((r) => !B.has(r)).map((r) => String(r.ed?.place).slice(0, 40));
    expect(
      片側だけ,
      `「${a}」で当たって「${b}」で当たらない行が ${片側だけ.length} 行ある（言い方で収録が見えている）`,
    ).toEqual([]);
    expect(A.size, `「${a}」が 1 行にも出会えていない`).toBeGreaterThan(0);
  }
});

it("合衆国・USA は、開催地に其の国の表記を書く行をこぼさない（第 311 回）", () => {
  /* `合衆国` は `米国` より 26 行少なかった（実測 182 行 / 208 行）。届かなかったのは開催地に
   * `United States` と書く行で、寄せ先に `usa` と `america` しか無かったため – 表記を足して
   * 塞いだ（残る差は州名だけで書かれた行で、地域まとめの構成員である `米国` 側にだけ効く –
   * SPEC §7 に理由を書いてある）。 */
  /* 語の区切りで見る – `Busan, South Korea` の `Busan` に `usa` が部分文字列で入る
   * （実測で偽のこぼれが出た）。 */
  const 国の表記 = /(^|[^a-z])(usa|united states|america)([^a-z]|$)/i;
  for (const word of ["合衆国", "USA", "米国"]) {
    const matcher = Recommender.searchMatcher(word, AT);
    const missed = ROWS.filter((r) => 国の表記.test(String(r.ed?.place ?? "")))
      .filter((r) => matcher(r.hay) !== true)
      .map((r) => String(r.ed?.place).slice(0, 44));
    expect(
      missed,
      `「${word}」で開催地に米国の表記を書く行がこぼれている: ${missed.join(" / ")}`,
    ).toEqual([]);
  }
  /* `米国` との残り差は、州名だけで書かれた行に限定される（言い方の差でなく層の差）。 */
  const us = reached("米国");
  const gasshuukoku = reached("合衆国");
  /* 正式名と郵便略記の両方で見る – 実測で差の 5 行のうち 1 行は `San Jose, CA` のように
   * 略記だけを書く行だった（第 310 回で略記を寄せ先に足した州）。 */
  const 州 =
    /(^|[^a-z])(ak|az|ca|co|fl|ga|hi|il|in|md|ma|mi|nv|ny|nc|oh|or|pa|tx|ut|va|wa)([^a-z]|$)|\b(alaska|arizona|california|colorado|florida|georgia|hawaii|illinois|indiana|maryland|massachusetts|michigan|nevada|new york|north carolina|ohio|oregon|pennsylvania|texas|utah|virginia|washington)\b/i;
  const 差 = [...us].filter((r) => !gasshuukoku.has(r));
  const 州で無い = 差.filter((r) => !州.test(String(r.ed?.place ?? "")));
  expect(
    州で無い.map((r) => String(r.ed?.place).slice(0, 44)),
    "合衆国 と 米国 の差が州名以外の行に広がっている（別語を呼んでいる）",
  ).toEqual([]);
});

it("同じ国を指す言い方の寄せ先は、正本の表で等しい（第 311 回）", () => {
  /* 画面の当たり方は地域まとめの層が混むので、寄せ語の層その物は等しいことを別に見る
   * （一方だけ直して言い方で結果がずれる変化を止める）。 */
  const src = readFileSync(join(REPO_ROOT, "site", "place-aliases.ts"), "utf8");
  const begin = src.indexOf("const PLACE_QUERY_ALIASES_JA");
  expect(begin, "開催地の寄せ語の表が見当たらない").toBeGreaterThan(-1);
  const end = src.indexOf("];", begin);
  const 表 = src.slice(begin, end);
  const 寄せ先 = (word: string): string[] =>
    [...表.matchAll(new RegExp(`\\["${word}", "([a-z ]+)"\\]`, "g"))].map((m) => String(m[1]));
  const sort = (xs: string[]) => [...new Set(xs)].sort();
  /* `米国` と `合衆国` は等しくしない – `米国` は地域まとめの構成員なので州名の行まで拾える
   * （SPEC §7）。ここでは言い方の組が同じ層で揃っていることだけ見る。 */
  expect(sort(寄せ先("英国")), "英国 と イギリス の寄せ先が等しくない").toEqual(
    sort(寄せ先("イギリス")),
  );
  for (const word of ["英国", "イギリス", "米国", "合衆国"]) {
    expect(sort(寄せ先(word)).length, `「${word}」の寄せ先が空`).toBeGreaterThan(0);
  }
  /* `合衆国` に `united states` を足した根拠（開催地に其の表記を書く行が 12 種あった – §7）。
   * 表から落ちると、その行への道が閉じる（当たりの検査は検査用データでは見えない）。 */
  expect(寄せ先("合衆国"), "合衆国 の寄せ先から united states が消えた").toContain("united states");
  expect(寄せ先("英国"), "英国 の寄せ先から united kingdom が消えた").toContain("united kingdom");
  /* 収録に現れない表記を寄せ先にしない（第 309 回からの不変条件）。今回の 4 語について、
   * 言い方の組に挙がる語を漏れなく見る – 列挙を自分で絞ると、検査がその語しか見ずに
   * 新しい死語を通す（対称性を保ったまま死語を足す改ざんが通った実測 → 見ていた語を
   * 表の語すべてに広げた）。品書（ビルド済み）には検査用のデータしか入っていないので、
   * 収録の側にも在ることを見る（第 306 回と同じ基準）。 */
  const 品書 = readFileSync(join(builtSite(), "catalog.json"), "utf8").toLowerCase();
  const 収録 = readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8").toLowerCase();
  const 対象語 = [...new Set(["英国", "イギリス", "米国", "合衆国"].flatMap((w) => 寄せ先(w)))];
  expect(対象語.length, "見るべき寄せ先が 1 も無い（表の読み取りが壊れている）").toBeGreaterThan(0);
  const 死語 = 対象語.filter((t) => !品書.includes(t) && !収録.includes(t));
  expect(死語, "品書にも収録にも一度も出ない語を寄せ先にしている").toEqual([]);
});
