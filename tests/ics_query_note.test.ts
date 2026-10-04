/**
 * `ics` を打った人の検査（SPEC §4・§7・第 323 回）。
 * `ics` はこの画面が配るファイルの名前でもあり、会議名の語の途中でもある。
 * 実測（2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `ics` は 14 行に当たり、**10 行は会議名の語の途中に貼り付いた物**（"ICSOC" `@icsa2027`）、
 * `ical` は 2 行で同じ形。当たりが行に在るので 0 件案内は立たず、画面は黙って 14 件を
 * 並べていた。探している物（カレンダーに入れるファイル）は一覧の下に在る –
 * 件数欄に常に出す案内（`always`）を new に追加した。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");

describe("`ics` を打った人", () => {
  it("当たりが行に在っても、件数欄に出す案内が有る", () => {
    ["ics", "ical"].forEach((語) => {
      const 文 = Recommender.uiWordAlwaysNoteJa(語);
      expect(文, `"${語}" を打った人に件数欄で何も言わない`).not.toBe("");
      /* 混じり方の事実を隠さない（「表がそう書いている」ことにすると嘘になる）。 */
      expect(文.includes("語の途中"), `"${語}": 語の途中で当たっていることを隠した`).toBe(true);
      /* 探している物への道も言う – 一覧の下の操作の名前は画面の正本から読む（次の検査）。 */
      expect(文.includes("カレンダーに追加"), `"${語}": ファイルへの道を言っていない`).toBe(true);
      expect(文.includes("引き継がれません"), `"${語}": 絞り込みが引き継がれないことを隠した`).toBe(
        true,
      );
    });
  });

  it("案内が書く操作の名前は、画面の正本と一致する", () => {
    const html = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
    const 画面の語 = /<a id="icsLink"[^>]*>([\s\S]*?)<\/a\s*>/.exec(html)?.[1].trim();
    expect(画面の語, "カレンダーへのリンクの語が見つからない").toContain("カレンダーに追加");
    ["ics", "ical"].forEach((語) => {
      expect(Recommender.uiWordAlwaysNoteJa(語).includes(画面の語 || "?")).toBe(true);
    });
  });

  it("件数欄に常に出すのは `ics` だけで、画面の他の語で欄を埋めない", () => {
    /* 0 件案内にしか出さない語（持ち出し・画面の操作・欄の名前）がここから出てくると、
     * 一覧が出ているときにも案内が並んで件数欄が読めなくなる。 */
    [
      "csv",
      "書き出し",
      "購読",
      "カレンダー",
      "使い方",
      "過去の締切",
      "分野",
      "ランク",
      "30日以内",
      "機械学習",
    ].forEach((語) => {
      expect(Recommender.uiWordAlwaysNoteJa(語), `"${語}" まで件数欄に出した`).toBe("");
    });
  });

  it("件数欄の配線は、一覧が出ているときだけ案内を出す形になっている", () => {
    /* このハーネスは画面を描かないので、ビルド成果物の配線を文字で見る
       （一覧が 0 件のときは 0 件案内が同じことを言う – 二重に出さないための門）。 */
    const js = readFileSync(join(builtSite(), "app.js"), "utf8");
    expect(js, "件数欄に案内を出す配線が消えている").toContain("uiWordAlwaysNoteJa");
    /* 一覧が 0 件のときは 0 件案内が同じことを言う – 二重に出さないための門を見る。 */
    expect(js, "一覧が出る条件が付いていない").toMatch(
      /shown\.length\s*\?\s*\[Recommender\.uiWordAlwaysNoteJa\(/,
    );
  });

  it("実データでは当たりが行に在り、貼り付きも残っている（別の手当が必要）", () => {
    const rows = Recommender.candidateRows(
      JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
    ) as Row[];
    const match = Recommender.searchMatcher("ics", AT);
    const 当たる = rows.filter((row) => match(row.hay) === true);
    expect(当たる.length, "`ics` が 0 行になった（前提が変わった）").toBeGreaterThan(10);
    const 貼り付き = 当たる.filter(
      (row) => !/(^|[^a-z0-9])ics([^a-z0-9]|$)/.test(String(row.hay).toLowerCase()),
    ).length;
    expect(貼り付き, "貼り付きが消えた – §7 の記述とこの案内の必要性を見直す").toBeGreaterThan(0);
  });
});
