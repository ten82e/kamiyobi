import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

/* 2026-10-17 実測 – 分野の語の後ろに「3月まで」を打つと、「3月」に寄せた事の案内が消え、
 * 期間で絞ったと思い込ませた（実際は 3 月の行だけ – 63 件が 3 件になる）。 */
it("「X月まで」を何として探したかは、前に別の語が在っても書く", () => {
  const 単 = Recommender.querySynonymNotes("3月まで").join(" ");
  expect(単).toContain("「3月まで」は「3月」");
  for (const 文 of ["分散システム 3月まで", "セキュリティ 3月まで", "機械学習 8月まで"]) {
    const 月 = /([0-9]+月)まで/.exec(文)?.[1];
    expect(Recommender.querySynonymNotes(文).join(" "), `「${文}」の案内`).toContain(
      `「${月}まで」は「${月}」`,
    );
  }
});
