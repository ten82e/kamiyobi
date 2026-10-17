import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

const 基準 = Date.parse("2026-10-18T00:00:00Z");

/* 2026-10-17 実測 – 分野の語の後ろに「3月まで」を打つと、「3月」に寄せた事の案内が消え、
 * 期間で絞ったと思い込ませた。2026-10-18 に「X月まで」を今月からの幅に変えた後も、前に別の語が
 * 在っても同じ案内が出る事を守る。 */
it("「X月まで」の幅は、前に別の語が在っても案内に書く", () => {
  for (const 文 of [
    "3月まで",
    "分散システム 3月まで",
    "セキュリティ 3 月 まで",
    "機械学習 3月までに",
  ]) {
    expect(Recommender.relativeDayNotes(文, 基準).join(" "), `「${文}」の案内`).toContain(
      "2026年10月〜2027年3月の締切（今月からその月の末まで",
    );
  }
});
