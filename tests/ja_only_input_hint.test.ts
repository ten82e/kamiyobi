import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

/* 2026-10-18 – 研究者役の試しで、日本語だけの題名・概要では分野違いの会議が上位に並んだ。意味検索が
 * 使えない時（語彙検索のみ）には、英語の専門用語を足す直し方を結果の横で言う。 */
it("意味検索が使えず入力が日本語だけの時に、英語表記を足す案内を出す", () => {
  const app = readFileSync(join(site, "app.js"), "utf8");
  const at = app.indexOf("意味検索は利用不可（語彙検索のみ");
  expect(at, "意味検索の注が見つからない").toBeGreaterThan(0);
  const near = app.slice(Math.max(0, at - 1500), at + 200);
  expect(near).toContain("日本語だけの入力は語の一致が弱くなります");
  expect(near, "日本語だけの判定が無い").toMatch(
    /u3040-\\u30ff|\\u3040-\\u30ff|ぁ-ヶ|\\u3400-\\u9fff/,
  );
  expect(near, "英字 3 字以上の語を見る条件が無い").toContain("[A-Za-z]{3,}");
  /* \`paperText\` は JSON の文字列（英字のキー名を含む）。それを見ると常に「英字あり」になり案内が出ない。 */
  expect(near, "題名・概要・キーワードの値で見ていない").toMatch(
    /record\.title, record\.abstract, record\.keywords/,
  );
});
