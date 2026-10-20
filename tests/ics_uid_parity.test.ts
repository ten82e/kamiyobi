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
  it("同じ締切には購読カレンダーと同じ UID を付ける", () => {
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
    /* 印が SHA-1 の 8 桁（`[0-9a-f]{8}`）でない物は、**ASCII の語がそのまま入っている** –
     * 上流のラベルを続けた行の一部である（實測 2026-10-17: 938 行のうち 12 行）。
     * 印に上流の語が混じる行は、此の形の 12 行と、SHA-1 の中に混じる 97 行を合わせて
     * 109 行ある（SPEC の UID の項に例外として書いてある）。回次で代用すると 250 行が
     * 入れ替わり、同じ回次の重なりは解けない（實測）ので、今の形を張る。
     * **頭の 1 字が英字の SHA-1 を數へない**ように、8 桁の十六進できっちり見る
     * （`[A-Za-z]` で始まる物を數へて 431 件と誤つた。十六進の頭が英字に成るのは 6/16）。 */
    const 上流が可見 = uids.filter((u) => !/-[0-9a-f]{8}(-[0-9]+)?@kamiyobi$/.test(u));
    expect(上流が可見.length, "ASCII の種別を持つ UID が消えた（形が変わった）").toBeGreaterThan(0);
    expect(
      上流が可見.length,
      `印が ASCII のままの UID が ${上流が可見.length} 件に増えた（安定な印の設計を見直す合図）`,
    ).toBeLessThan(40);
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

  it("配付の ICS と `upcoming.md` も、畫面と同じ確認の狀態を書く", () => {
    /* 記録（`recordsOf`）の締切が持つ `verification` は入力と台帳が付けた物だけで、
     * `data.json` は其れに加へて證據から狀態を足す。記録だけを讀んで居た頃は、
     * **同じ行が出口ごとに違ふ**事に成つて居た（2026-10-17 實測: 配付の ICS は 938 行の
     * うち 350 行・`upcoming.md` は 1,128 行のうち 348 行にしか狀態を書いて居なかつた。
     * 確認済みは札を出さない決まりなので、數へるのは其れ以外の狀態を持つ行）。 */
    const out = builtSite();
    const data = JSON.parse(readFileSync(join(out, "data.json"), "utf8")) as {
      conferences?: Array<Record<string, unknown>>;
    };
    /* UID → その行に出すべき狀態（`verified` は札を出さないので空）。 */
    const 期待 = new Map<string, string>();
    for (const c of data.conferences ?? [])
      for (const e of (c.editions ?? []) as Array<Record<string, unknown>>)
        for (const dl of (e.deadlines ?? []) as Array<Record<string, unknown>>) {
          const uid = typeof dl.ics_uid === "string" ? dl.ics_uid : "";
          const v = dl.verification as Record<string, unknown> | undefined;
          if (!uid || !v) continue;
          const status = String(v.status ?? "");
          期待.set(uid, status === "verified" || !status ? "" : status);
        }
    expect(期待.size, "正典が UID を持つ行が少なすぎる").toBeGreaterThan(100);
    const ics = readFileSync(join(out, "deadlines.ics"), "utf8").replace(/\r\n[ \t]/g, "");
    const 足りない: string[] = [];
    for (const blk of ics.split("BEGIN:VEVENT").slice(1)) {
      const uid = (/UID:([^\r\n]+)/.exec(blk) ?? [])[1] ?? "";
      const 望 = 期待.get(uid);
      if (!望) continue;
      const 本文 = (/DESCRIPTION:([\s\S]*?)\r?\n[A-Z-]+[:;]/.exec(blk) ?? [])[1] ?? "";
      if (!本文.includes("状態: ")) 足りない.push(`${uid}（${望} の行に狀態が無い）`);
    }
    expect(足りない, `配付の ICS に狀態が無い行: \n${足りない.slice(0, 5).join("\n")}`).toEqual([]);
    /* `upcoming.md` も同じ表から作る。狀態の欄を持つ行が、闇の數より極端に少なくない事。 */
    const md = readFileSync(join(out, "upcoming.md"), "utf8").split("\n");
    const md行 = md.filter((l) => /^\| /.test(l) && !/^\| 日付/.test(l) && !/^\|---/.test(l));
    const md状態 = md行.filter((l) =>
      (l.split("|").map((x) => x.trim())[9] ?? "").length ? 1 : 0,
    );
    expect(md行.length, "upcoming.md を讀めない").toBeGreaterThan(100);
    expect(
      md状態.length,
      `upcoming.md に狀態の欄がある行が ${md状態.length} 行しか無い`,
    ).toBeGreaterThan(md行.length * 0.3);
  });

  it("てびきも、書き出しの説明欄と同じ事を言う（片方だけ古くならない）", () => {
    /* 説明欄（カレンダーの情報欄）とてびき（画面の読み物）は、同じ事を言う。
     * 2026-10-17 實測: 正典にも UID を載せて全履歴の締切が購読と同じ UID に成つた後も、
     * てびきだけが「購読の対象より先の締切は別の識別子になる」と古い事を言つて居た
     * （説明欄は直して居た）。 */
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    const てびき = html.slice(html.indexOf('id="helpPanel"'));
    expect(てびき, "てびきが同じ識別子を使う事を言っていない").toContain(
      "同じ識別子（UID）を付けます",
    );
    expect(てびき, "購読に入っていない締切の扱いを言っていない").toContain(
      "購読に入っていない締切",
    );
    expect(てびき, "古い但し書きが残っている").not.toContain("購読の対象より先の締切");
    const 説明 = icsViewDescriptionJa(
      [{ day: "20261017", at: 1, deadline: true, body: [] }],
      new Date("2026-08-09T00:00:00Z"),
    );
    /* 同じ事を言つて居るか（語その物は違つて良い – 讀む場所が違ふ）。 */
    for (const 語 of ["同じ識別子", "購読に入っていない締切"]) {
      expect(てびき.includes(語), `てびきに「${語}」が無い`).toBe(true);
      expect(説明.includes(語), `説明欄に「${語}」が無い`).toBe(true);
    }
  });

  it("書き出しの説明欄が、購読と同じ識別子を使う事と、例外を言う", () => {
    const 文 = icsViewDescriptionJa(
      [{ day: "20261017", at: 1, deadline: true, body: [] }],
      new Date("2026-08-09T00:00:00Z"),
    );
    expect(文, "同じ識別子を使う事を言っていない").toContain("同じ識別子");
    expect(文, "購読に入っていない締切の扱いを言っていない").toContain("購読に入っていない締切");
    /* 前の版の但し書き（先の締切は別の識別子・二度並ぶ）は、揃えたので消す
     * （全履歴の締切も購読と同じ UID になった – 2026-10-17）。 */
    expect(文, "古い但し書きが残っている").not.toContain("購読の対象より先の締切");
  });
});

it("配付の ICS と畫面の書き出しが、ランクも本文に書く（購読した人はカレンダーしか見ない）", () => {
  /* 分野と狀態を本文に載せたのと同じ理由（2026-10-17 までランクだけが抜けて居た）。
   * 等級が無い會議には行を立てない – 每回「未確認」を書くと本文が空語で埋まる。 */
  const out = builtSite();
  const ics = readFileSync(join(out, "deadlines.ics"), "utf8").replace(/\r\n[ \t]/g, "");
  const 行 = ics.split("BEGIN:VEVENT").slice(1);
  const 有 = 行.filter((b) => /ランク: /.test(b));
  /* 検査用のビルドは収録が小さいので、割合ではなく「有る事」と「全部ではない事」を見る
   * （全部に付いていたら、等級が無い會議にも行を立てて居る）。 */
  expect(有.length, "配付の ICS にランクの行が無い").toBeGreaterThan(0);
  expect(有.length, "配付の ICS の全行にランクの行が付いている").toBeLessThan(行.length);
  for (const b of 有.slice(0, 5)) {
    const m = /ランク: ([^\\]*)/.exec(b);
    expect(m?.[1] ?? "", `ランクの語が畫面の形と違う: ${m?.[1]}`).toMatch(/^(CCF|CORE|THCPL) /);
  }
  /* 畫面の書き出しも同じ行を出す（材料は `ScreenDeadlineInput.rank`）。 */
  const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
  expect(app, "畫面がランクを材料へ渡していない").toContain("rank: (r.rankPairs || [])");
  const icsTs = readFileSync(join(REPO_ROOT, "site", "ics.ts"), "utf8");
  expect(icsTs, "書き出しがランクの行を組んでいない").toContain("ランク: ${String(item.rank)");
});
