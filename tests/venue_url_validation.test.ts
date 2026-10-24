import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";
import { siteRuntime } from "./runtime_extract.ts";

/* URL の `venue` は、収録の鍵に寄せて受ける（画面の札は `SIGMOD` と大文字で出るので、大文字小文字を
 * 問わない）。収録に無い鍵は絞り込みを外して断る – 黙って外すと「会議「zzz」以外の行 183 件」とだけ
 * 出て、鍵が無いのか条件が厳しいのか分からない（2026-10-23 実測）。会期だけの一覧・紙・ICS にも
 * 同じ条件を掛ける（2026-10-24 実測: `?venue=sigmod` で会期だけの一覧が 129 件のままだった）。 */
it("URL の venue は収録の鍵に寄せて受け、合わなければ断って外す", () => {
  const app = siteRuntime();
  const 原文 = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  expect(原文, "収録の鍵と突き合わせていない").toContain("Recommender.venueKeyFromInput(");
  expect(app, "断りを出していない").toContain(
    'urlValueNoticeJa("会議", rawVenue, "会議の絞り込みは外れています")',
  );
  expect(原文, "会期だけの一覧に掛けていない").toContain(
    "if (filter.venue && m.key !== filter.venue) return false;",
  );
  expect(原文, "会期だけの一覧へ会議を渡していない").toContain("venue: state.venue,");
  /* 書き出しの説明も、紙と同じ条件の文を使う（片方だけ「絞り込んだ」と書かない）。 */
  expect(app, "書き出しの説明が紙と別の文").toContain("scopeJa: recMode ? ");
  expect(原文, "紙に会議の絞り込みを書いていない").toContain("if (s.venue) out.push(");
});
