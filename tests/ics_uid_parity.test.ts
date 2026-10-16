import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { icsViewDescriptionJa, icsViewText } from "../site/ics.ts";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

/** 折り返しを戻した UID の一覧（RFC 5545 は 75 オクテットで折る）。 */
function uidsOf(ics: string): string[] {
  return [...ics.replace(/\r\n[ \t]/g, "").matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
}

describe("書き出しの ICS と購読の ICS の識別子", () => {
  it("同じ締切には同じ UID を付ける（両方を同じカレンダーに入れても二重にならない）", () => {
    /* 2026-10-17 實測: 揃える前は配付物が `kamiyobi-dl2ws2026-29b52d20@kamiyobi`（種別の
     * 日本語名の SHA-1 の 8 桁）、畫面が `kamiyobi-dl2ws2026-abstract@kamiyobi`（ASCII の
     * 種別の鍵）で、同じ日が二度並んだ。今は品書の `ics_uid` をそのまま使う。 */
    const out = builtSite();
    const catalog = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8")) as Parameters<
      typeof Recommender.candidateRows
    >[0];
    const 材料 = Recommender.candidateRows(catalog).map((r) => ({
      key: String(r.conf?.key ?? ""),
      editionId: String(r.ed?.id ?? ""),
      year: r.ed?.year ?? null,
      title: String(r.conf?.title ?? ""),
      kind: String(r.kind ?? ""),
      kindWord: String(Recommender.kindLabelJa(r.dl?.kind) ?? ""),
      dateField: String(Recommender.kindDateFieldJa(r.dl?.kind) ?? ""),
      day: r.dateOnly
        ? String(r.localDate ?? "")
            .replace(/-/g, "")
            .slice(0, 8)
        : new Date(Number(r.t) + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ""),
      whenText: "x",
      at: Number(r.t),
      dl: r.dl,
      uid: (r.dl as { ics_uid?: unknown } | undefined)?.ics_uid,
    }));
    /* `icsViewText` は材料を受け取って自分で行を組む（組んだ行を渡すと、材料として
     * 読み直されて別の UID になる – 2026-10-17 に検査を書く途中で踏んだ）。 */
    const 書き出し = uidsOf(icsViewText(材料, new Date("2026-08-09T00:00:00Z")));
    const 購読 = new Set(uidsOf(readFileSync(join(out, "deadlines.ics"), "utf8")));
    const 一致 = 書き出し.filter((u) => 購読.has(u)).length;
    const 品書にUIDあり = 材料.filter((m) => m.uid).length;
    expect(品書にUIDあり, "品書に UID が載っていない（前提が崩れた）").toBeGreaterThan(100);
    expect(一致, "購読と同じ UID の行數が、品書が UID を持つ行數と違う").toBe(品書にUIDあり);
    /* 書き出しの UID は重ならない（RFC 5545 は 1 つの暦の中で一意を要する）。 */
    expect(new Set(書き出し).size, "書き出しの UID が重なっている").toBe(書き出し.length);
  });

  it("購読の側の UID は、種別の語を ASCII に落とした物（変えると購読者の暦が入れ替わる）", () => {
    const uids = uidsOf(readFileSync(join(builtSite(), "deadlines.ics"), "utf8"));
    expect(uids.length, "VEVENT が読めない（前提が崩れた）").toBeGreaterThan(100);
    const 形 = /^kamiyobi-[A-Za-z0-9._-]+(-[0-9a-f]{8})?(-[0-9]+)?@kamiyobi$/;
    const 外れ = uids.filter((u) => !形.test(u));
    expect(外れ, `UID の形が違う: ${外れ.slice(0, 3).join(" / ")}`).toEqual([]);
    expect(new Set(uids).size, "UID が重なっている").toBe(uids.length);
    /* 種別の語が ASCII の物（上流のラベルを続けた行）は、その語がそのまま入る –
     * **上流が言葉を書き換えると UID が変わる**（追いの課題。ここでは今の形を張る）。 */
    const ascii = uids.filter((u) => /-[A-Za-z][A-Za-z0-9._-]*@kamiyobi$/.test(u));
    expect(ascii.length, "ASCII の種別を持つ UID が消えた（形が変わった）").toBeGreaterThan(0);
  });

  it("正典（`data.json`）にも UID が載る（全履歴を讀み込んだ後の書き出しのため）", () => {
    /* 畫面は「収録の全体を読み込む」で `data.json` を讀み、其の後は其の締切で書き出す。
     * 品書にだけ UID を載せて居た頃は、全履歴を讀み込んだ後の書き出し 221 件が
     * **1 つも購読側と一致しなかった**（2026-10-17 に實ブラウザで落として實測）。 */
    const out = builtSite();
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      conferences?: Array<Record<string, unknown>>;
    };
    const 正典 = new Set<string>();
    for (const c of data.conferences ?? [])
      for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
        for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>)
          if (typeof dl.ics_uid === "string" && dl.ics_uid) 正典.add(dl.ics_uid);
    const 購読 = new Set(uidsOf(readFileSync(join(out, "deadlines.ics"), "utf8")));
    expect(正典.size, "正典が持つ UID の數が、配付の予定數と違う").toBe(購読.size);
    const 外れ = [...正典].filter((u) => !購読.has(u));
    expect(外れ, `配付に無い UID が正典に載っている: ${外れ.slice(0, 3).join(" / ")}`).toEqual([]);
  });

  it("畫面が品書の UID を材料へ渡している（配線）", () => {
    /* 品書に載っていても、畫面が読まなければ意味が無い。 */
    const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
    expect(app, "畫面が品書の UID を材料へ渡していない").toContain(
      "(r.dl as { ics_uid?: unknown } | undefined)?.ics_uid",
    );
    const catalog = readFileSync(join(builtSite(), "catalog.json"), "utf8");
    expect(catalog, "品書に UID が載っていない").toContain('"ics_uid"');
  });

  it("書き出しの説明欄が、購読と同じ識別子を使う事と、例外を言う", () => {
    const 文 = icsViewDescriptionJa(
      [{ day: "20261017", at: 1, deadline: true, body: [] }],
      new Date("2026-08-09T00:00:00Z"),
    );
    expect(文, "同じ識別子を使う事を言っていない").toContain("同じ識別子");
    expect(文, "購読の対象より先の締切の例外を言っていない").toContain("収録の全体を読み込む");
    /* 前の版の警告（二度並ぶ・どちらか一方）は、揃えたので消す。 */
    expect(文, "古い警告が残っている").not.toContain("どちらか一方");
  });
});
