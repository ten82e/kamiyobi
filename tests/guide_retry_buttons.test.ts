import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/* 読み込みは三つに分かれている（収録の全体・推薦データ・意味検索）。失敗した時だけ出る
 * ボタンなので、こそく「これは何の失敗か」を確かめたい。てびきが画面と同じ名前で書いて
 * いる事を見る（2026-10-18 まで、収録の全体の再試行だけが書いてあった）。 */
it("てびきが、三つの読み込みの再試行のボタンを画面と同じ名前で書いている", () => {
  const template = readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8");
  const 始 = template.indexOf('<details class="help"');
  const てびき = template.slice(始, template.indexOf("</details>", 始));
  expect(始, "てびきが見つからない").toBeGreaterThan(-1);
  for (const 名 of [
    "収録の全体の締切を再試行",
    "推薦データの読み込みを再試行",
    "意味検索を再試行",
  ]) {
    expect(template, `その名前のボタンが画面に無い: ${名}`).toContain(`>${名}</button>`);
    expect(てびき, `てびきが名前を書いていない: ${名}`).toContain(名);
  }
  /* 失敗しても使える物が残る事も書いてある（全部が止まったと読ませない）。 */
  expect(てびき, "失敗した時の残り方を書いていない").toContain("入力を残したまま");
  expect(てびき, "語彙だけで候補を出す事を書いていない").toContain("語彙の一致だけ");
});
