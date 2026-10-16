import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";
import { siteRuntime } from "./runtime_extract.ts";

/** てびきの本文（様式とタグを外した、人が読む文）。 */
function てびきの文(): string {
  const tpl = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const 始 = tpl.indexOf('id="helpPanel"');
  const 終 = tpl.indexOf("</details>", 始);
  return tpl
    .slice(始, 終)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

/** てびきの中の、規則を言っている数（實測の例ではなく、決まりの数）。 */
function てびきの数(印: RegExp): number {
  const m = 印.exec(てびきの文());
  expect(m, `てびきに ${印} が無い（文を書き換えた？）`).not.toBeNull();
  return Number(m![1].replace(/,/g, ""));
}

it("てびきが言う窓の日数は、品書が持つ窓と同じ", () => {
  /* てびきは「この一覧に差し込むデータは生成から 180 日先で切れています」と言う。
   * この数は設定（`site.upcoming_days`）から来るので、設定を変えた日に**てびきだけが
   * 古い事を言う**。同じ事を二か所で言っている所は、片方だけ直すと食い違う
   * （2026-10-17 に UID の但し書きで實際に踏んだ）。 */
  const catalog = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as {
    window?: { upcoming_days?: number; lookback_days?: number };
  };
  const 窓 = catalog.window?.upcoming_days;
  expect(typeof 窓, "品書が窓を持っていない").toBe("number");
  expect(てびきの数(/生成から\s*([\d,]+)\s*日先/), "てびきの窓の日數が品書と違う").toBe(窓);
});

it("てびきが言う「先頭 N 件」は、畫面が一度に描く行數と同じ", () => {
  /* `PAGE`（`site/app.ts`）を變へたら、てびきの「先頭 40 件」も直す。 */
  const page = Number(/const PAGE = (\d+);/.exec(siteRuntime())?.[1]);
  expect(Number.isFinite(page), "畫面の PAGE を讀めない").toBe(true);
  expect(てびきの数(/先頭\s*([\d,]+)\s*件/), "てびきの「先頭 N 件」が PAGE と違う").toBe(page);
});

it("てびきが言う強調の日數は、殘りの印を決める數と同じ", () => {
  /* 「あと N 日」（M 日以内は強調）の M。印を決めるのは `remainingLabelJa` である。 */
  const m = てびきの数(/あと N 日」（([\d,]+)\s*日以内は強調）/);
  const now = Date.UTC(2026, 7, 9, 0, 0, 0);
  const 日 = (n: number) => now + n * 86400000;
  const 印 = (n: number) =>
    (
      Recommender as unknown as {
        remainingLabelJa: (t: number, nowMs: number) => { cls: string };
      }
    ).remainingLabelJa(日(n), now).cls;
  expect(印(m), `${m} 日が強調されない（てびきと違う）`).toBe("soon");
  expect(印(m + 1), `${m + 1} 日が強調される（てびきと違う）`).toBe("");
});
