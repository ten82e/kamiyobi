import { expect, it } from "vitest";
import R from "../site/recommender.ts";

it("bounds an abstract-only query even when repeating its primary content would exceed the budget", () => {
  const abstract = Array.from({ length: 140 }, (_, i) => `specimen${i}`).join(" ");
  const paper = { title: "", abstract, keywords: "", venue: "" };
  const before = structuredClone(paper);
  expect(abstract.length).toBeGreaterThan(900);
  expect(abstract.length).toBeLessThan(1800);
  const text = R.queryText([paper]);
  expect(text.length).toBeLessThanOrEqual(1800);
  expect(text.startsWith(abstract)).toBe(true);
  expect(paper).toEqual(before);
});

it("bounds an oversized title while retaining its beginning ahead of other papers", () => {
  const title = Array.from({ length: 260 }, (_, i) => `inscription${i}`).join(" ");
  const paper = { title, abstract: "", keywords: "", venue: "" };
  const reference = { title: "Bronze chronology", abstract: "", keywords: "", venue: "" };
  expect(title.length).toBeGreaterThan(1800);
  const text = R.queryText([paper, reference]);
  expect(text.length).toBeLessThanOrEqual(1800);
  expect(text).toBe(title.slice(0, 1800));
  expect(paper.title).toBe(title);
});

it("keeps Japanese research content and adds scientific terminology for cross-language retrieval", () => {
  const papers = [
    {
      title: "特徴とラベルの対応を調べる",
      abstract: "画像分類の訓練データを解析する。",
      keywords: "",
      venue: "",
    },
  ];
  const before = structuredClone(papers);
  const text = R.queryText(papers);
  expect(text).toContain(papers[0].title);
  expect(text).toContain(papers[0].abstract);
  expect(text).toContain("supervised learning");
  expect(text).toContain("training data");
  expect(papers).toEqual(before);
});

it("does not infer supervised learning from an interface label alone", () => {
  const text = R.queryText([
    { title: "画面ラベルの可読性", abstract: "", keywords: "", venue: "" },
  ]);
  expect(text).toContain("画面ラベルの可読性");
  expect(text).not.toContain("supervised learning");
});

it("preserves a mathematical subject alongside a parallel implementation", () => {
  const text = R.queryText([
    {
      title: "高次元分布から並列にサンプリングする",
      abstract: "勾配評価回数の上界を解析する。",
      keywords: "",
      venue: "",
    },
  ]);
  expect(text).toContain("sampling probabilistic statistical");
  expect(text).toContain("gradient optimization");
  expect(text).toContain("高次元分布から並列にサンプリングする");
});

it("keeps the query budget while retaining the primary Japanese title and terminology", () => {
  const title = "ベイズ回帰の汎化保証";
  const text = R.queryText([
    { title, abstract: "長い研究概要。".repeat(500), keywords: "", venue: "" },
  ]);
  expect(text.length).toBeLessThanOrEqual(1800);
  expect(text).toMatch(/^ベイズ回帰の汎化保証 /);
  expect(text).toContain("bayesian");
  expect(text).toContain("regression");
  expect(text).toContain("長い研究概要。");
});

it("derives supplemental terminology from the submitted paper rather than unrelated references", () => {
  const text = R.queryText([
    { title: "並列サンプリングの標本数", abstract: "", keywords: "", venue: "" },
    { title: "プライバシーと暗号", abstract: "参考論文の概要", keywords: "", venue: "" },
  ]);
  expect(text).toContain("sampling probabilistic statistical");
  expect(text).toContain("プライバシーと暗号");
  expect(text).not.toContain("privacy");
  expect(text).not.toContain("cryptography");
});

it("prioritizes the title's subject over incidental abstract terminology", () => {
  const text = R.queryText([
    {
      title: "視覚効果を用いた展示",
      abstract: "生成した画像を比較する。",
      keywords: "",
      venue: "",
    },
  ]);
  expect(text).toContain("visual effects");
  expect(text).toContain("generation");
  expect(text.indexOf("visual effects")).toBeLessThan(text.indexOf("generation"));
  expect(text).not.toContain("generative generation");
});

it("does not turn interface features and labels into supervised learning", () => {
  const text = R.queryText([
    {
      title: "表示ラベルの特徴と読みやすさ",
      abstract: "画面上の文字の配置を調査する。",
      keywords: "",
      venue: "",
    },
  ]);
  expect(text).not.toContain("supervised learning");
  expect(text).toContain("表示ラベルの特徴と読みやすさ");
});

it("keeps the order of subjects within a title", () => {
  const text = R.queryText([
    { title: "視覚効果と芸術を用いた展示", abstract: "", keywords: "", venue: "" },
  ]);
  for (const term of ["visual effects", "art", "exhibition"]) expect(text).toContain(term);
  expect(text.indexOf("visual effects")).toBeLessThan(text.indexOf("art"));
  expect(text.indexOf("art")).toBeLessThan(text.indexOf("exhibition"));
});
