import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { siteRuntime } from "./runtime_extract.ts";

/* 候補のカードは、締切が過ぎた会議に「締切済み」、投稿締切が未収録の会議に「締切未確認」と
 * 出す（2026-10-18）。画面に出る語は検索でも引ける（SPEC §7）ので、その語を打った人に
 * 表のどこを見るかを案内する。 */
const 表 = readFileSync(join(import.meta.dirname, "..", "site", "template.html"), "utf8");

it("カードの「締切済み」は、過去の締切の入口を案内する", () => {
  for (const 語 of ["締切済み", "締め切り済み", "締切済", "募集終了"]) {
    const 案内 = Recommender.uiWordNoteJa(語, false);
    const 聲 = Recommender.uiWordLiveNoteJa(語);
    expect(案内, 語).toContain("『過去の締切も表示』をオン");
    expect(聲, 語).toContain("過去の締切も表示");
    expect([...聲].length, `${語} の読み上げが長い`).toBeLessThanOrEqual(60);
  }
  /* 案内が名指す欄は画面に実在する。 */
  expect(表, "『過去の締切も表示』の欄が画面に無い").toContain("過去の締切も表示");
});

it("カードの「締切未確認」は、会期だけの一覧の在りかを案内する", () => {
  for (const 語 of ["締切未確認", "締切なし", "締切がない会議", "締切の無い研究会", "締切未定"]) {
    const 案内 = Recommender.uiWordNoteJa(語, false);
    const 聲 = Recommender.uiWordLiveNoteJa(語);
    expect(案内, 語).toContain("投稿締切が未収録");
    expect(案内, 語).toContain("投稿締切が未収録の開催回");
    expect(案内, 語).toContain("upcoming.html");
    expect(聲, 語).toContain("会期だけの開催回");
    expect([...聲].length, `${語} の読み上げが長い`).toBeLessThanOrEqual(60);
  }
  /* 案内が名指す物は画面に実在する（表の下の一覧の見出しと、常時受付の語）。 */
  const app = siteRuntime();
  expect(app, "表の下の一覧の見出しが違う").toContain(
    "投稿締切が未収録の開催回（会期だけ分かっている物）",
  );
  expect(Recommender.kindLabelTable().journal, "常時受付の語が違う").toBe("常時受付");
});
