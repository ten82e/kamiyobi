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

/** RFC 4180 の形を讀む（引用符・轉義・改行入り）。 */
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
  expect(app, "畫面の種別が正本を呼んで居ない").toContain("Recommender.kindLabelJa(r.kind)");
  expect(app, "畫面の日付の欄の名が正本を呼んで居ない").toContain(
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
