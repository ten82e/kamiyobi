import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** RFC 4180 の形（引用符・転義・改行入り）を讀む。 */
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

/** 一行一締切の印（會議・開催回・種別・回次・原表記・狀態・確認元）。 */
function 印(部分: string[]): string {
  return 部分.join("\u0000");
}

describe("data.csv の確認の状態", () => {
  it("`data.json` と同じ値を書く（列の説明がそう言っている）", () => {
    const out = builtSite();
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      conferences?: Array<Record<string, unknown>>;
    };
    const 行々 = 解析(readFileSync(join(out, "data.csv"), "utf8"));
    const 頭 = 行々[0];
    const 列 = (名: string): number => {
      const i = 頭.indexOf(名);
      expect(i, `data.csv に ${名} の列が無い`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const [kKey, kEd, kKind, kRound, kLabel, kStatus, kClass] = [
      "key",
      "edition_id",
      "kind",
      "round",
      "label",
      "verification_status",
      "verification_source_class",
    ].map(列);

    const CSV = 行々
      .slice(1)
      .filter((r) => r.length > 1 || r[0] !== "")
      .map((r) =>
        印([
          r[kKey] ?? "",
          r[kEd] ?? "",
          r[kKind] ?? "",
          r[kRound] ?? "",
          r[kLabel] ?? "",
          (r[kStatus] ?? "").trim(),
          (r[kClass] ?? "").trim(),
        ]),
      )
      .sort();
    const JSON側: string[] = [];
    for (const c of data.conferences ?? [])
      for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
        for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>) {
          const v = dl.verification as Record<string, unknown> | undefined;
          JSON側.push(
            印([
              String(c.key ?? ""),
              String(e.id ?? ""),
              String(dl.kind ?? ""),
              String(dl.round ?? 1),
              String(dl.label ?? ""),
              String(v?.status ?? "").trim(),
              String(v?.source_class ?? "").trim(),
            ]),
          );
        }
    JSON側.sort();
    expect(CSV.length, "CSV の行数が data.json の締切数と違う").toBe(JSON側.length);
    /* 一致しない行だけを出す（全部並べると讀めない）。 */
    const 違い = CSV.map((v, i) => (v === JSON側[i] ? "" : `${v} ≠ ${JSON側[i]}`)).filter(Boolean);
    expect(違い, `CSV と data.json で確認の状態が違う行: \n${違い.slice(0, 5).join("\n")}`).toEqual(
      [],
    );
  });

  it("狀態の語が空の行は、`data.json` にも狀態が無い行だけ", () => {
    const out = builtSite();
    const 行々 = 解析(readFileSync(join(out, "data.csv"), "utf8"));
    const 頭 = 行々[0];
    const i = 頭.indexOf("verification_status");
    const 空 = 行々.slice(1).filter((r) => (r.length > 1 || r[0] !== "") && !(r[i] ?? "").trim());
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      conferences?: Array<Record<string, unknown>>;
    };
    let 記録なし = 0;
    for (const c of data.conferences ?? [])
      for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
        for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>)
          if (!(dl.verification as Record<string, unknown> | undefined)) 記録なし += 1;
    expect(空.length, "空欄の行數が data.json の記録なしと違う").toBe(記録なし);
  });
});
