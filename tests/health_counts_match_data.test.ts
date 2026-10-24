/**
 * `health.json` の件数が、`data.json` から数え直した物と一致する事を見る。
 *
 * `health.json` は配信前ゲートにも使ふ（`evaluateHealthGate`）ので、此処の數が實際の
 * 收録とずれると、**ゲートが「健全」と言つた物が健全で無い**事に成る。数え方を 2 か所に
 * 書いて居るのは元からの事なので、突き合わせて置く。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** 締切の「最後の日」を解釈する（date-only は latest、exact は utc）。 */
function 最後の日(dl: Record<string, unknown>): number {
  const 候補 = [
    typeof dl.utc === "string" ? Date.parse(dl.utc) : Number.NaN,
    typeof dl.latest_utc === "string" ? Date.parse(dl.latest_utc) : Number.NaN,
    typeof dl.local_date === "string" ? Date.parse(`${dl.local_date}T00:00:00Z`) : Number.NaN,
  ].filter((t) => Number.isFinite(t));
  return 候補.length ? Math.max(...候補) : Number.NaN;
}

it("health.json の件数が、data.json から数え直した物と一致する", () => {
  const out = builtSite();
  const health = JSON.parse(readFileSync(join(out, "health.json"), "utf8")) as Record<
    string,
    number
  >;
  const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
    generated_at?: string;
    conferences?: Array<Record<string, unknown>>;
  };
  const 今 = Date.parse(String(data.generated_at ?? ""));
  expect(Number.isFinite(今), "生成時刻を讀めない").toBe(true);

  let 未來確定 = 0;
  let 未來推定 = 0;
  let 未來時刻付 = 0;
  let 未來日付のみ = 0;
  for (const c of data.conferences ?? [])
    for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
      for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>) {
        const 遅 = 最後の日(dl);
        if (!Number.isFinite(遅) || 遅 < 今) continue;
        const 推定 = e.estimated === true;
        if (推定) 未來推定++;
        else {
          未來確定++;
          if (String(dl.precision ?? "") === "exact") 未來時刻付++;
          else 未來日付のみ++;
        }
      }

  expect(未來確定, "窓の確定締切が 100 件未満（前提が崩れた）").toBeGreaterThan(100);
  expect(
    health.confirmed_deadlines,
    "health.json の確定の数が、data.json と違う（次回以降の確定締切）",
  ).toBe(未來確定);
  expect(health.estimated_deadlines, "health.json の推定の數が、data.json と違う").toBe(未來推定);
  /* 同じ値を 2 つの鍵で持つ決まり（ゲートも兩者の一致を見てゐる）。 */
  expect(health.confirmed_future_deadlines, "確定の 2 つの鍵が違う").toBe(
    health.confirmed_deadlines,
  );
  expect(health.estimated_future_deadlines, "推定の 2 つの鍵が違う").toBe(
    health.estimated_deadlines,
  );
  /* 内訳の合計も合ふ（時刻まで確定 + 日付のみ = 確定）。 */
  expect(
    (health.future_exact_deadlines ?? 0) + (health.future_date_only_deadlines ?? 0),
    "確定の內訳の合計が、確定の數と違う",
  ).toBe(health.confirmed_deadlines);
  expect(health.future_exact_deadlines, "時刻まで確定の數が data.json と違う").toBe(未來時刻付);
  expect(health.future_date_only_deadlines, "日付のみの數が data.json と違う").toBe(未來日付のみ);
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
    健康の確定が全体より少ない(health.confirmed_deadlines, 確定),
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

function 健康の確定が全体より少ない(健康: number, 全体: number): boolean {
  return 健康 > 0 && 健康 < 全体;
}
