import { expect, it } from "vitest";
import R from "../site/recommender.ts";

/* 2026-10-18 – 文字の大きさが全行同じ PDF（体裁のない版）で、全行が題名になり概要まで
 * 題名の欄に入った。見出し語の行で題名を打ち切る。 */
function line(str: string, y: number, size = 12) {
  return {
    str,
    transform: [size, 0, 0, size, 50, y],
    width: str.length * size * 0.5,
    height: size,
  };
}

it("全行が同じ大きさの PDF でも、題名は Abstract の行の前で終わる", () => {
  const pages = [
    [
      line("Time-Sensitive Networking Scheduling", 780),
      line("for Deterministic Industrial Networks", 765),
      line("Abstract", 730),
      line("We present a gate control list scheduler for industrial networks.", 715),
      line("Keywords: time-sensitive networking, real-time scheduling", 690),
      line("1 Introduction", 660),
    ],
  ];
  const record = R.pdfPaperRecord({}, pages, "paper.pdf");
  expect(record.title).toBe(
    "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks",
  );
  expect(record.abstract).toContain("gate control list scheduler");
  expect(record.keywords).toContain("time-sensitive networking");
});

it("題名が大きい普通の体裁は今まで通り", () => {
  const pages = [
    [line("A Big Title", 780, 20), line("Abstract", 730), line("Body text of the abstract.", 715)],
  ];
  expect(R.pdfPaperRecord({}, pages, "p.pdf").title).toBe("A Big Title");
});
