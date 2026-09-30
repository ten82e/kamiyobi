/**
 * 都市・国の和名の検査（SPEC §4・§7・第 312 回）。
 * 同じ読みを表記の違う二通りで書く人が居るので、片方だけ通る形を作らない。
 * ビルド済みサイトは `tests/built_site.ts` 経由で共有する。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; ed?: { place?: string }; conf?: { acronym?: string } };

const ACCENTS = /[\u0300-\u036f]/g;
/** 上流の表記はアクセント記号付き（`Valparaíso` `Kraków`）で、表の英文字側は畳んだ形
 * （`valparaiso` `krakow`）。照合は両側アクセントを畳んでから行う（第 312 回で実測 –
 * 畳まないと 7 語が「収録に現れない死語」という偽の欠陥になった）。 */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(ACCENTS, "")
    .replace(/[^a-z0-9 ,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function source(): string {
  return readFileSync(join(REPO_ROOT, "site", "place-aliases.ts"), "utf8");
}

function aliasTable(): Array<[string, string]> {
  const src = source();
  const begin = src.indexOf("const PLACE_QUERY_ALIASES_JA");
  expect(begin, "開催地の寄せ語の表が見当たらない").toBeGreaterThan(-1);
  const table = src.slice(begin, src.indexOf("\n  ];", begin));
  return [...table.matchAll(/^\s*\["([^"]+)", "([^"]+)"\],$/gm)].map((m) => [
    String(m[1]),
    String(m[2]),
  ]);
}

const AT = Date.parse("2026-08-09T00:00:00Z");
const ROWS = Recommender.candidateRows(
  JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as { conferences: unknown },
) as Row[];

const 語として = (t: string) => new RegExp(`(^|[^a-z0-9])${t}([^a-z0-9]|$)`);

it("同じ読みの別表記で打っても、同じ行に出会う（第 312 回）", () => {
  /* `モントリオール` は通るが `モントリアル` は 0 行（13 行の収録に対して当たり 0 行）、
   * `マドリード` は通るが `マドリッド` は 0 行、という形になっていた。長音と小書きの差は
   * 検索の折り合わせでは埋まらないので、表記の数だけ表に置く（SPEC §7）。 */
  const 表 = aliasTable();
  const 寄せ先 = (word: string): string[] =>
    [...new Set(表.filter(([ja]) => ja === word).map(([, latin]) => fold(latin)))].sort();
  for (const [a, b] of [
    ["マドリッド", "マドリード"],
    ["モントリアル", "モントリオール"],
  ] as const) {
    expect(寄せ先(a), `「${a}」の寄せ先が空`).not.toEqual([]);
    expect(寄せ先(a), `「${a}」と「${b}」で寄せ先が違う`).toEqual(寄せ先(b));
    const reached = (w: string) => {
      const m = Recommender.searchMatcher(w, AT);
      return new Set(ROWS.filter((r) => m(r.hay) === true));
    };
    const A = reached(a);
    const B = reached(b);
    expect(
      [...A].filter((r) => !B.has(r)),
      `「${a}」にだけ当たる行がある`,
    ).toEqual([]);
    expect(
      [...B].filter((r) => !A.has(r)),
      `「${b}」にだけ当たる行がある`,
    ).toEqual([]);
  }
});

it("今回和名を足した都市は、収録の行を漏らさず余計な行を呼ばない（第 312 回）", () => {
  const added: Array<[string, string]> = [
    ["モントリアル", "montreal"],
    ["マドリッド", "madrid"],
    ["バルパライソ", "valparaiso"],
    ["パナマシティ", "panama city"],
    ["フェニックス", "phoenix"],
    ["グラナダ", "granada"],
    ["チャールストン", "charleston"],
    ["リッチモンド", "richmond"],
    ["アリカンテ", "alicante"],
    ["マンガロール", "mangalore"],
    ["平昌", "pyeongchang"],
    ["長沙", "changsha"],
    ["無錫", "wuxi"],
    ["ゴア", "goa"],
  ];
  const 表 = aliasTable();
  for (const [ja, latin] of added) {
    expect(
      表.some((w) => w[0] === ja && fold(w[1]) === fold(latin)),
      `「${ja}」→ ${latin} が表に無い`,
    ).toBe(true);
    const matcher = Recommender.searchMatcher(ja, AT);
    const got = ROWS.filter((r) => matcher(r.hay) === true);
    const 都市の行 = ROWS.filter((r) => {
      const seg = fold(String(r.ed?.place ?? "").split(",")[0] ?? "");
      return seg === fold(latin) || 語として(fold(latin)).test(fold(String(r.ed?.place ?? "")));
    });
    const 漏れ = 都市の行
      .filter((r) => matcher(r.hay) !== true)
      .map((r) => String(r.ed?.place).slice(0, 40));
    expect(
      漏れ,
      `「${ja}」で開催地に ${latin} と書く行がこぼれている: ${漏れ.join(" / ")}`,
    ).toEqual([]);
    const 寄与外 = got
      .filter((r) => !語として(fold(latin)).test(fold(r.hay)))
      .map((r) => String(r.hay).slice(0, 40));
    expect(
      寄与外,
      `「${ja}」の寄せが ${latin} を書かない行を呼んだ: ${寄与外.join(" / ")}`,
    ).toEqual([]);
  }
});

it("表の英文字側が品書の開催地に現れる語は、和名で打つと 1 行以上に出会う（第 312 回）", () => {
  /* 表に語を置いただけで実際に当たっていない形（寄せの配線を間違える、見出し語だけ増やす）を
   * 防ぐ。品書の開催地に英文字側が現れる項目だけを、品書の行に対して引く。 */
  const 該当: Array<[string, string]> = [];
  for (const [ja, latin] of aliasTable()) {
    const t = fold(latin);
    if (!ROWS.some((r) => 語として(t).test(fold(String(r.ed?.place ?? ""))))) continue;
    該当.push([ja, latin]);
    const matcher = Recommender.searchMatcher(ja, AT);
    expect(
      ROWS.filter((r) => matcher(r.hay) === true).length,
      `「${ja}」（原文の ${latin}）で 1 行にも出会えない`,
    ).toBeGreaterThan(0);
  }
  expect(
    該当.length,
    "品書の開催地に現れる寄せ語が 1 語も見当たらない（検査が空振りしている）",
  ).toBeGreaterThan(10);
});

it("表の英文字側は、収録か品書に一度は現れる（第 312 回）", () => {
  /* 収録に現れない表記を寄せ先にしない（第 309 回からの不変条件）。品書（ビルド済みハーネス）は
   * 検査用のデータなので、収録 `data/snapshot.json` も見る。 */
  const 収録 = fold(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8"));
  const 品書 = fold(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
  /* 例外は理由付きで 1 語だけ。`aizuwakamatsu` は今の収録に開催地が 0 行だが、上流の取得状況で
   * 増える行に備えて置く（`tests/built_golden_2.test.ts` の合成行の検査が同じ約束を留めている）。 */
  const 例外 = new Set(["aizuwakamatsu"]);
  const 死語 = aliasTable()
    .filter(([, latin]) => {
      const t = fold(latin);
      return !収録.includes(t) && !品書.includes(t) && !例外.has(t);
    })
    .map(([ja, latin]) => `${ja}/${latin}`);
  expect(死語, "収録にも品書にも一度も出ない英文字側を寄せ先にしている").toEqual([]);
});
