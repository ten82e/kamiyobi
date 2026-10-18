import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

const source = readFileSync(new URL("../site/app.ts", import.meta.url), "utf8");

/** 名前を付けた関数だけを切り出して動かす（画面の他の部分に依存させない）。 */
function 切り出す(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`切り出せない: ${startMarker}`);
  return stripTypeScriptTypes(source.slice(start, end));
}

const 件数の関数 = 切り出す("  function countJa(", "  /* ランク絞り込みの選択肢");
const 案内の関数 = 切り出す(
  "  function recommendationPastNoteJa(",
  "  function recommendationAvailability(",
);
const pastNote = runInNewContext(`${件数の関数}\n${案内の関数}\nrecommendationPastNoteJa;`) as (
  rows: ReadonlyArray<{ _availability?: { status?: string } }>,
) => string;

it("数えるのは締切が過ぎたと確認できた候補だけ（受付状況の未確認は数えない）", () => {
  const rows = [
    { _availability: { status: "past" } },
    { _availability: { status: "open" } },
    { _availability: { status: "past" } },
    { _availability: { status: "uncertain" } },
    { _availability: { status: "ongoing" } },
    { _availability: {} },
    {},
  ];
  const note = pastNote(rows);
  expect(note).toContain("うち 2 件は締切が過ぎた会議です");
  expect(note, "カードの札と同じ語を使う").toContain("「締切済み」");
  expect(note, "候補に載せている理由を書く").toContain("次回の開催に向けた参考");
  for (const 数 of ["3", "4", "5", "6", "7"]) {
    expect(note, `過ぎた側に数えていない: ${数}`).not.toContain(`うち ${数} 件`);
  }
});

it("締切が過ぎた候補が無いときは何も足さない", () => {
  expect(pastNote([{ _availability: { status: "open" } }, {}])).toBe("");
  expect(pastNote([])).toBe("");
});

it("件数は桁区切りで出す（4 桁以上でも読める）", () => {
  const rows = Array.from({ length: 1234 }, () => ({ _availability: { status: "past" } }));
  expect(pastNote(rows)).toContain("うち 1,234 件");
});

it("候補の件数欄に繋いでいる（切り出した関数が画面から呼ばれる）", () => {
  expect(source, "候補の件数欄に足していない").toContain(
    "const pastNote = recommendationPastNoteJa(shown);",
  );
  expect(source, "読み上げ欄にも同じ文を出していない").toContain("cntLive += pastNote;");
});
