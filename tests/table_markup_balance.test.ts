/**
 * 一覧の表の組み立てが、閉じ要素まで揃った HTML になっているかの検査（SPEC §7・第 279 回）。
 *
 * 2026-09-24 にビルド成果物で実測した形（`index.html`）:
 *   - `<th` が 7 個開いているのに `</th>` は **3 個**。並び順を切り替えられる 5 列のうち
 *     「残り」「日時（JST）」「会議」「ランク」の 4 列が閉じられていなかった
 *     （閉じていたのは「種別」「会期」「開催地」だけ）。
 *   - 画面を表示する仕組みは次の `<th>` で前のセルを勝手に閉じるので、画面では壊れて見えない。
 *     しかしこれは不正な HTML で、検証器は落ちるし、表を組み直して扱う処理系
 *     （紙への書き出し・他サービスへの貼り付け・読み上げ側の HTML 補正）では
 *     セルの区別が潰れることがある。`upcoming.html` は同じ表を組み立てているのに閉じていた
 *     （`src/build.ts` 側は閉じを書いていた – 静的な側だけ抜けていた）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

const TABLE_TAGS = ["table", "thead", "tbody", "tr", "th", "td", "caption"] as const;

/** 静的な HTML（`<style>` と `<script>` を落とした本体）を返す。 */
function body(name: string): string {
  const html = readFileSync(join(site, name), "utf8");
  const noScript = html.replace(/<script\b[\s\S]*?<\/script>/g, " ");
  const noStyle = noScript.replace(/<style\b[\s\S]*?<\/style>/g, " ");
  return noStyle.replace(/<!--[\s\S]*?-->/g, " ");
}

function rows(src: string): string[] {
  return [...src.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((m) => m[0]);
}

function cellText(cell: string): string {
  return cell
    .replace(/^<t[hd]\b[^>]*>/, "")
    .replace(/<\/t[hd]>$/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/↕/g, "")
    .trim();
}

describe("一覧の表が閉じ要素まで揃った HTML で出る（第 279 回）", () => {
  it("表を組み立てる要素の開きと閉きが、両ページで対応している", () => {
    for (const name of ["index.html", "upcoming.html"]) {
      const src = body(name);
      for (const tag of TABLE_TAGS) {
        const open = (src.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
        const close = (src.match(new RegExp(`</${tag}>`, "g")) || []).length;
        expect(open, `${name}: <${tag}> が閉じていない（開き ${open} / 閉じ ${close}）`).toBe(
          close,
        );
      }
    }
  });

  it("既定画面の見出しは 7 個の列で、1 個ずつ閉じている", () => {
    const src = body("index.html");
    const head = rows(src)[0];
    expect(head, "先頭の行（見出し）が無い").toBeTruthy();
    const cells = [...head.matchAll(/<th\b[\s\S]*?<\/th>/g)].map((m) => cellText(m[0]));
    expect(cells, "見出しの列が 7 個に読めない（閉じ忘れで中身が混ざった可能性がある）").toEqual([
      "残り",
      "日時（JST）",
      "会議",
      "種別",
      "ランク",
      "会期",
      "開催地",
    ]);
  });

  it('見出しの列はすべて行の先頭（scope="col"）を名乗っている', () => {
    const head = rows(body("index.html"))[0];
    const ths = [...head.matchAll(/<th\b[^>]*>/g)].map((m) => m[0]);
    expect(ths.length).toBe(7);
    for (const th of ths) {
      expect(th, `列見出しが scope を持たない: ${th.slice(0, 60)}`).toContain('scope="col"');
    }
  });

  it("並び順を切り替えられる列の数と印が崩れていない", () => {
    const head = rows(body("index.html"))[0];
    const sortable = [...head.matchAll(/<th\b[^>]*data-sort="([a-z]+)"[^>]*>/g)].map((m) => m[1]);
    expect(sortable).toEqual(["rem", "date", "conf", "rank", "event"]);
    // 押せる列には読み上げ向けの状態（aria-sort）が必ず付いている（閉じ忘れの修正で消えていない）。
    // 押せない列（種別・開催地）は状態を出さないのが正しい（第 258 回で揃えた並び）。
    expect((head.match(/aria-sort="/g) || []).length, "aria-sort が揃っていない").toBe(5);
    for (const th of [...head.matchAll(/<th\b[^>]*>/g)].map((m) => m[0])) {
      if (th.includes("data-sort=")) {
        expect(th, `押せる列が状態を出していない: ${th.slice(0, 60)}`).toContain("aria-sort=");
      }
    }
  });

  it("直近の締切と会期の表は、すべての行が 8 列持っている", () => {
    const src = body("upcoming.html");
    const list = rows(src);
    expect(list.length, "行が無い（組み立てが壊れた）").toBeGreaterThan(100);
    // 見出しの行（`scope="col"` を持つ行）は別扱いで、そちらも 8 個であることを見る。
    const headRow = list.find((r) => r.includes('scope="col"'));
    expect(headRow, "見出しの行が無い").toBeTruthy();
    expect(
      [...String(headRow).matchAll(/<th\b[\s\S]*?<\/th>/g)].map((m) => cellText(m[0])),
      "列の名が変わった",
    ).toEqual(["日付", "残り", "会議", "種別", "ラウンド", "推定", "開催地", "会期"]);
    const data = list.filter((r) => r.includes("<td"));
    expect(data.length, "データの行が無い").toBeGreaterThan(100);
    /* 第 284 回から行の先頭（「どの会議か」）が行ヘッダー（`<th scope="row">`）なので、
     * マスの数は `td` だけで数えると足りなく見える。両方合わせて数える。 */
    const bad = data.filter((r) => (r.match(/<t[hd]\b/g) || []).length !== 8);
    expect(bad.slice(0, 2), `${bad.length} 行が 7 列でない`).toEqual([]);
  });
});
