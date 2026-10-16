/**
 * `data.csv` の日本語（`kind_ja`・`date_field`）が、畫面と同じ語である事を見る。
 *
 * 列の説明は「畫面と同じ語を同じ正本から入れる」と言つて居るが、**正本を呼んで居る事を
 * 誰も見て居なかつた**（2026-10-17）。語を書き寫すと、種別の名を變へた日に CSV だけが
 * 古い事を言ふ – 第 5 回に「公式で要確認」を手で書いて、畫面と食ひ違つた事故と同じ型。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

/** RFC 4180 の形を読む（引用符・轉義・改行入り）。 */
function 解析(text: string): string[][] {
  const 行: string[][] = [];
  let 今: string[] = [];
  let 欄 = "";
  let 引用 = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (引用) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          欄 += '"';
          i += 1;
        } else 引用 = false;
      } else 欄 += c;
      continue;
    }
    if (c === '"') {
      引用 = true;
      continue;
    }
    if (c === ",") {
      今.push(欄);
      欄 = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      今.push(欄);
      行.push(今);
      今 = [];
      欄 = "";
      continue;
    }
    欄 += c;
  }
  if (欄 || 今.length) {
    今.push(欄);
    行.push(今);
  }
  return 行;
}

it("data.csv の kind_ja と date_field が、畫面と同じ正本の語である", () => {
  /* 畫面が同じ正本を呼んで居る事（書き寫しではない事の裏取り）。 */
  const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  expect(app, "畫面の種別が正本を呼んでいない").toContain("Recommender.kindLabelJa(r.kind)");
  expect(app, "畫面の日付の欄の名が正本を呼んでいない").toContain(
    "Recommender.kindDateFieldJa(r.dl?.kind)",
  );

  const 行々 = 解析(readFileSync(join(builtSite(), "data.csv"), "utf8"));
  const 頭 = 行々[0];
  const 列 = (名: string): number => {
    const i = 頭.indexOf(名);
    expect(i, `data.csv に ${名} の列が無い`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const [kKind, kKindJa, kDateField] = ["kind", "kind_ja", "date_field"].map(列);
  const 見た = new Set<string>();
  const 違う: string[] = [];
  for (const r of 行々.slice(1)) {
    if (r.length <= kKind) continue;
    const kind = (r[kKind] ?? "").trim();
    if (!kind) continue;
    const 望の種別 = String(Recommender.kindLabelJa(kind) ?? "").trim();
    const 望の欄 = String(Recommender.kindDateFieldJa(kind) ?? "").trim();
    見た.add(kind);
    if ((r[kKindJa] ?? "").trim() !== 望の種別)
      違う.push(`${kind}: kind_ja「${r[kKindJa]}」≠ 畫面「${望の種別}」`);
    if ((r[kDateField] ?? "").trim() !== 望の欄)
      違う.push(`${kind}: date_field「${r[kDateField]}」≠ 畫面「${望の欄}」`);
  }
  expect(見た.size, "種別を 1 つも見ていない（前提が崩れた）").toBeGreaterThan(3);
  expect(違う, `CSV の語が畫面と違う: \n${違う.slice(0, 5).join("\n")}`).toEqual([]);
});

it("health.md の「確定した締切」が、次回以降の数だと分かるように書いてある", () => {
  /* `healthReport` は `confirmed_deadlines` と `confirmed_future_deadlines` に**同じ値**を
   * 入れる（ゲートも兩者の一致を見て居る）。見出しに「次回以降」が無いと、
   * 「確定した締切 865」を**収録ぜんぶの確定締切**と読む – 実測 2026-10-17:
   * 収録 4,990・確定 4,916 に対し、この値は 865。 */
  const out = builtSite();
  const health = JSON.parse(readFileSync(join(out, "health.json"), "utf8")) as Record<
    string,
    number
  >;
  expect(health.confirmed_deadlines, "確定の數が無い").toBeGreaterThan(0);
  expect(
    health.confirmed_deadlines,
    "確定の數と次回以降の確定の數が違う（同じ値を入れる決まり）",
  ).toBe(health.confirmed_future_deadlines);
  expect(
    health.estimated_deadlines,
    "推定の數と次回以降の推定の數が違う（同じ値を入れる決まり）",
  ).toBe(health.estimated_future_deadlines);
  /* 収録ぜんぶの確定締切より少ない（次回以降だけを数えて居る事の裏取り）。 */
  const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
    conferences?: Array<Record<string, unknown>>;
  };
  let 確定 = 0;
  for (const c of data.conferences ?? [])
    for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
      if (e.estimated !== true) for (const _ of (e.deadlines ?? []) as unknown[]) 確定++;
  expect(
    健康の確定が全體より少ない(health.confirmed_deadlines, 確定),
    "収録ぜんぶを数えている",
  ).toBe(true);
  /* 見出しの側にも「次回以降」と書いてある（人は md を読む）。 */
  const md = readFileSync(join(out, "health.md"), "utf8");
  const 行 = md.split("\n").find((l) => l.includes("`confirmed_deadlines`")) ?? "";
  expect(行, "health.md に確定の行が無い").not.toBe("");
  expect(行, "見出しが次回以降だと言っていない").toContain("次回以降");
  /* 同じ値の鍵は表の下の註が名指す（見出しに重ねると括弧が二重になる）。 */
  expect(md, "同じ値の鍵を名指していない").toContain("confirmed_future_deadlines");
  expect(md, "同じ値だと書いていない").toContain("同じ値");
});

function 健康の確定が全體より少ない(健康: number, 全體: number): boolean {
  return 健康 > 0 && 健康 < 全體;
}
