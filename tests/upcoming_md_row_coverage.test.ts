/**
 * `upcoming.md` が、窓に入る締切を**一種別も落とさず**載せている事を見る。
 *
 * 表は「生成時刻から N 日先まで」を宣言している（2026-10-17 実測: 対象期間の外に出る行は
 * 0）。しかし**入るべき行が入つて居るか**は誰も見て居なかつた – 數へ方を 2 か所に書くと、
 * 片方の門を狹めた日に、md だけが静かに行を落とす（畫面や CSV と件數が合はなくなる）。
 * 種別ごとに數へて突き合わせる（合計だけだと、種別の取り違えが相殺されて見えない）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

/** md の種別のセルを、`kind` の鍵へ戻す（「論文締切: Paper submission」の樣な註を落とす）。 */
function 種別の鍵(cell: string): string {
  const 素 = cell
    .replace(/（[^（）]*）\s*$/u, "")
    .replace(/:\s.*$/u, "")
    .trim();
  const 表 = Recommender.kindLabelTable();
  for (const [key, label] of Object.entries(表)) if (String(label) === 素) return key;
  return "";
}

it("upcoming.md は、窓に入る締切を種別ごとに落とさず載せる", () => {
  const out = builtSite();
  const md = readFileSync(join(out, "upcoming.md"), "utf8");
  const 窓 = /対象期間: (\d{4}-\d{2}-\d{2}) 〜 (\d{4}-\d{2}-\d{2})/.exec(md);
  expect(窓, "md に対象期間の宣言が無い").not.toBeNull();
  const 終 = 窓![2];

  const 表の内訳 = new Map<string, number>();
  let 開催 = 0;
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| 日付") || line.startsWith("|---")) continue;
    const セル = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (セル.length < 10) continue;
    if (セル[3] === "開催") {
      開催++;
      continue;
    }
    const key = 種別の鍵(セル[3]);
    expect(key, `種別の語を鍵へ戻せない: ${セル[3]}`).not.toBe("");
    表の内訳.set(key, (表の内訳.get(key) ?? 0) + 1);
  }
  expect(開催, "開催の行が無い（前提が崩れた）").toBeGreaterThan(100);
  expect(表の内訳.size, "種別が 3 つ未満（前提が崩れた）").toBeGreaterThan(3);

  /* `data.json` から、同じ規則（最新が生成時刻以降・窓の終わりまで）で數える。 */
  const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
    generated_at?: string;
    conferences?: Array<Record<string, unknown>>;
  };
  const 今 = Date.parse(String(data.generated_at ?? ""));
  const 果 = Date.parse(`${終}T00:00:00Z`);
  expect(Number.isFinite(今), "生成時刻を讀めない").toBe(true);
  const 正 = new Map<string, number>();
  for (const c of data.conferences ?? [])
    for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
      for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>) {
        const 候補 = [
          typeof dl.utc === "string" ? Date.parse(dl.utc) : Number.NaN,
          typeof dl.latest_utc === "string" ? Date.parse(dl.latest_utc) : Number.NaN,
          typeof dl.local_date === "string" ? Date.parse(`${dl.local_date}T00:00:00Z`) : Number.NaN,
        ].filter((t) => Number.isFinite(t));
        if (!候補.length) continue;
        const 遅 = Math.max(...候補);
        if (遅 < 今 || 遅 > 果) continue;
        const key = String(dl.kind ?? "");
        正.set(key, (正.get(key) ?? 0) + 1);
      }
  expect(
    [...正.values()].reduce((a, b) => a + b, 0),
    "窓の締切が 100 件未満（前提が崩れた）",
  ).toBeGreaterThan(100);
  /* 種別ごとに一致（合計だけだと、種別の取り違えが相殺されて見えない）。 */
  expect(Object.fromEntries([...表の内訳].sort())).toEqual(Object.fromEntries([...正].sort()));
});

it("窓の中では、md とカレンダーが同じ締切を同じ種別で載せる", () => {
  /* 二つの別々の組み立て（md と ICS）が、同じ窓で同じ行を出す事を見る。どちらかが
   * 靜かに行を落とすと、ここで種別ごとの差として出る（2026-10-17 實測: どちらも 793 行、
   * 10 種別すべて一致）。 */
  const out = builtSite();
  const md = readFileSync(join(out, "upcoming.md"), "utf8");
  const 窓 = /対象期間: \d{4}-\d{2}-\d{2} 〜 (\d{4}-\d{2}-\d{2})/.exec(md);
  expect(窓, "md に対象期間の宣言が無い").not.toBeNull();
  const 終 = 窓![1];

  const 表 = new Map<string, number>();
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || line.startsWith("| 日付") || line.startsWith("|---")) continue;
    const セル = line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    if (セル.length < 10 || セル[3] === "開催") continue;
    const key = 種別の鍵(セル[3]);
    expect(key, `種別の語を鍵へ戻せない: ${セル[3]}`).not.toBe("");
    表.set(key, (表.get(key) ?? 0) + 1);
  }

  const ics = readFileSync(join(out, "deadlines.ics"), "utf8").replace(/\r\n[ \t]/g, "");
  const 暦 = new Map<string, number>();
  const 表の種別 = Recommender.kindLabelTable();
  let 窓の行 = 0;
  for (const blk of ics.split("BEGIN:VEVENT").slice(1)) {
    const day = (/DTSTART;VALUE=DATE:(\d{8})/.exec(blk) ?? [])[1] ?? "";
    if (!day) continue;
    const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    /* md の窓は生成日の翌日から數へる（md の 1 行目は生成日そのものだから、
     * 同じ日に締まる行は md にもカレンダーにも出る – 其れは両方で數へる）。 */
    if (iso > 終) continue;
    窓の行++;
    const 語 = ((/種別: ([^\\]*)/.exec(blk) ?? [])[1] ?? "")
      .replace(/（[^（）]*）\s*$/u, "")
      .trim();
    const key = Object.entries(表の種別).find(([, label]) => String(label) === 語)?.[0] ?? `?${語}`;
    暦.set(key, (暦.get(key) ?? 0) + 1);
  }
  expect(窓の行, "カレンダーの窓の行が 100 件未満（前提が崩れた）").toBeGreaterThan(100);
  /* md の側は「生成日以降」を數へる（カレンダーの窓は生成日から始まる）。 */
  expect(Object.fromEntries([...暦].sort())).toEqual(Object.fromEntries([...表].sort()));
});
