import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { jsFunction, siteRuntime } from "./runtime_extract.ts";

/* 一覧の書き出しは絞り込みごと入るので、「この締切だけ」を持ち出すには 1 件に絞る手間が
 * 要った（2026-10-18）。行の詳細から 1 件だけカレンダーへ入れる入口を置く。 */
it("行の詳細から、その 1 件だけをカレンダーに持ち出せる", () => {
  const app = siteRuntime();
  const template = readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8");
  /* ボタンは行の詳細にあり、名前は画面の語（てびきも同じ語で説明する）。 */
  expect(app, "行の詳細に 1 件の入口が無い").toContain("この締切をカレンダー（.ics）に入れる");
  expect(template, "てびきが同じ語で説明していない").toContain(
    "この締切をカレンダー（.ics）に入れる",
  );
  expect(template, "ボタンの見た目が無い").toContain(".drawer-action");
  /* 押した時の配線（文字列の HTML には函数を書けないので、描いた後に組み立てる）。 */
  expect(app, "ボタンを押しても何も起きない").toContain(
    'ics.addEventListener("click", () => exportRowIcs(',
  );
  expect(app, "行の詳細の描画から呼んでいない").toContain("renderDrawerRowActions(r);");
  /* 一覧の書き出しと同じ 1 行分の組み立てを使う（同じ締切が別の予定として並ばない）。 */
  const rowInput = jsFunction(app, "icsInputForRow");
  const shownInput = jsFunction(app, "shownIcsInput");
  expect(shownInput, "一覧の書き出しが 1 行分の組み立てを使っていない").toContain(
    "icsInputForRow(r)",
  );
  expect(rowInput, "書き出しの材料に UID を渡していない").toContain("ics_uid");
  expect(rowInput, "画面のランクの語を渡していない").toContain("rankPairLabelJa");
  const exportRow = jsFunction(app, "exportRowIcs");
  expect(exportRow, "1 件の書き出しが 1 行分の組み立てを使っていない").toContain(
    "icsInputForRow(r)",
  );
  expect(exportRow, "1 件でも識別子を揃えていない").toContain("icsViewText([one]");
  expect(exportRow, "同じ日に何件も落とすと上書きする").toContain("one.day");
});
