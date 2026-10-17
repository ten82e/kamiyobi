import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";

/* 2026-10-17 – 初回利用者の試しで、`国内研究会 今月の締切` の件数欄が「『締切』は『国内研究会』と『締切』に
 * 分けて探しています」と出た（期間の語ではなく先頭の語を名指し、しかも分けていない語を分けたと言う）。
 * `機械学習 週末締切` も「機械学習」と「締切」と書いた。 */
const 案内 = (q: string) => Recommender.querySynonymNotes(q).join("\n");

it("『締切』を期間の語から分けた案内は、その期間の語を名指す", () => {
  expect(案内("機械学習 週末締切")).toContain("「週末」と「締切」");
  expect(案内("機械学習 週末締切")).not.toContain("「機械学習」と「締切」");
});

it("期間の語が書き換わっただけの文は、先頭の語を『締切』と分けたと言わない", () => {
  expect(案内("国内研究会 今月の締切")).not.toContain("「国内研究会」と「締切」");
});
