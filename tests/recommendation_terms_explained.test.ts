import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { site } from "./built_golden_shared.ts";

function page(): string {
  return readFileSync(join(site, "index.html"), "utf8");
}

function app(): string {
  return readFileSync(join(site, "app.js"), "utf8");
}

/** 論文ごとの内訳の行に出る要素の短い名前（ビルド後の画面の組み立てから取る）。 */
function perLineLabels(): string[] {
  const src = app();
  const from = src.indexOf('<div class="perline">');
  const to = src.indexOf('<div class="perline-item">');
  expect(from, "内訳の行の組み立てが見つからない").toBeGreaterThan(0);
  expect(to, "内訳の行の組み立ての末尾が見つからない").toBeGreaterThan(from);
  const labels = [
    ...new Set([...src.slice(from, to).matchAll(/parts\.push\("([^"]+)"\)/g)].map((m) => m[1])),
  ];
  expect(labels.length, "内訳の名前が 1 つも読めない（空振り検査の防止）").toBeGreaterThanOrEqual(
    5,
  );
  return labels;
}

/** 候補のカードのチップ（ラベル・値・説明）をビルド後の組み立てから取る。 */
function chipTuples(): Array<{ label: string; why: string }> {
  const src = app();
  const out: Array<{ label: string; why: string }> = [];
  // chips.push([ "ラベル", "値", "説明" ]) の形（改行・空白込み）。
  for (const m of src.matchAll(/chips\.push\(\s*\[\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]+)"/g)) {
    out.push({ label: m[1], why: m[3] });
  }
  expect(out.length, "チップの組み立てが読めない（空振り検査の防止）").toBeGreaterThanOrEqual(5);
  return out;
}

function guideItem(term: string): string {
  return guideRaw(term).replace(/<[^>]+>/g, " ");
}

/** 組み立ての目印（`<strong>` と括弧）を生かしたまま返す（語だけ残す改ざんを見るため）。 */
function guideRaw(term: string): string {
  const g = page();
  const at = g.indexOf('id="helpPanel"');
  const end = g.indexOf("</details>", at);
  const m = new RegExp(`<dt>${term}</dt>\\s*<dd>([\\s\\S]*?)</dd>`).exec(g.slice(at, end));
  expect(m, `てびきに「${term}」の項目が無い`).toBeTruthy();
  return String(m![1]).replace(/\s+/g, " ");
}

describe("当たった要素の名前が、てびきで意味を引ける（第 280 回）", () => {
  it("内訳の行に出る名前は、てびきの項目に一覧として意味付きで書いてある", () => {
    /* 「語が一度出ていれば良い」検査では、語だけ残して意味の括弧を消す改ざんが通る
     * 。名前を並べて括弧で意味を添える形その物を見る。 */
    const dd = guideRaw("当たった要素の名前");
    for (const label of perLineLabels()) {
      const listed = new RegExp(`${label}</strong>（[^（）]{6,}）`);
      expect(dd, `内訳に出る「${label}」が、意味の括弧付きで並んでいない`).toMatch(listed);
    }
  });

  it("名前の説明を、画面と同じ向きの意味で書いている", () => {
    const dd = guideItem("当たった要素の名前");
    // 過去掲載先は「主題が合う」とは別の物だという区別が要る（混ざると強い証拠に見える）。
    expect(dd).toContain("補助情報");
    expect(dd, "主題の一致との区別が書いていない").toContain("主題");
    // 内訳の数字を一致スコアの点の足し算と読み違えないことも書く。
    // 「一致スコア」という語を出すだけでは足りず、点の足し算では**ない**と否定していることを見る
    // （「昔は足した数字を並べていた」という過去の説明だけが残ると、読み手を逆に誘導する）。
    expect(dd, "一致スコアの点の足し算ではないと否定していない").toMatch(
      /一致スコア[^。]{0,18}足を?して[^。]{0,18}ではありません/,
    );
  });

  it("候補のカードのチップは、自分の説明文を必ず持っている", () => {
    /* チップは説明を隣の欄に常に出す（`title` の注記に逃がした過去がある – 第 233 回）。
     * ここでは説明の欄が空の組み立てが 1 つも無いことを見る。 */
    const empty = chipTuples().filter((c) => c.why.trim().length < 8);
    expect(
      empty.map((c) => c.label),
      "説明のないチップがある",
    ).toEqual([]);
  });

  it("チップに出る語も、てびきの本文で読める語だけ", () => {
    /* チップには説明が付くが、語その物がてびきに 1 回も無いと、用語を集めた場所から
     * 探せなくなる。少なくとも語の本体（接尾の「一致」を除いた物）はてびきにある。 */
    const g = page();
    const at = g.indexOf('id="helpPanel"');
    const guide = g.slice(at, g.indexOf("</details>", at)).replace(/<[^>]+>/g, " ");
    for (const c of chipTuples()) {
      const stem = c.label.replace(/の?一致$/, "");
      expect(guide, `チップの語「${c.label}」の本体がてびきに無い`).toContain(stem);
    }
  });
});

describe("順位表に入る条件", () => {
  it("画面は順位表に入る条件を言う", () => {
    const html = page();
    expect(html, "順位表に入る条件が書かれていない").toContain("順位表に入る");
    expect(html, "実質的な一致が条件だと書かれていない").toContain("実質的な一致がある投稿先");
  });

  it("分野だけの一致では候補にせず、会議名の一致があれば候補になる", () => {
    const rows = Recommender.candidateRows({
      conferences: [
        {
          key: "compute",
          title: "Compute Venue",
          categories: ["hpc"],
          editions: [
            {
              id: "compute-2027",
              year: 2027,
              deadlines: [{ kind: "paper", precision: "exact", utc: "2027-01-01T00:00:00Z" }],
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    const recommend = (title: string) =>
      Recommender.venueRecommendations(
        rows,
        Recommender.parsePaperLines(title),
        null,
        Date.parse("2026-10-13T00:00:00Z"),
        { fieldedLexical: true, venueCats: ["hpc"] },
      );
    expect(recommend("unknownterm98765")).toEqual([]);
    const matched = recommend("Compute Venue");
    expect(matched).toHaveLength(1);
    expect(matched[0].venueKey).toBe("compute");
    expect(matched[0].fit.score).toBeGreaterThan(0);
  });
});
