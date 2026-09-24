/**
 * カレンダー（`deadlines.ics`）の各行が開催地を持つかの検査（SPEC §7・第 288 回）。
 *
 * 実測（2026-09-24・2026-08-09 生成ビルド）: 928 個の `VEVENT` に `LOCATION` は **1 個も無く**、
 * `DESCRIPTION` も 会議・種別・締切・詳細・収録 だけで開催地を書かなかった。出張の段取りは
 * カレンダーの側で読むので、国内か海外かを確かめにサイトを再び開くしかなかった。
 * ここでは (a) 場所が判っている行に `LOCATION` が有り、判らない行には無いこと、
 * (b) RFC 5545 の転義・折り返しを元に戻すと `upcoming.md` の開催地欄と同じ語になること、
 * (c) 行の並び（締切の瞬間順）が変わっていないことを見る。
 *
 * `deadlines.ics` は CRLF（RFC 5545 §3.1）。JavaScript の `.` は `\r` にも効くので、
 * プロパティの値を拾うときは `\r` を落としてから比べる（第 288 回に自分で踏んだ）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";

function raw(): string {
  return readFileSync(join(site, "deadlines.ics"), "utf8");
}

/** RFC 5545 の折り返しを戻す（続け頭の空白 1 文字を落とす）。 */
function unfold(text: string): string {
  return text.replace(/\r\n[ \t]/g, "");
}

/** 折り返しを戻し、行末の `\r` も落としてから読む形にする。 */
function logical(text: string): string {
  return unfold(text).replace(/\r/g, "");
}

/** TEXT 値の転義を元に戻す（`\,` `\;` `\\` `\n`）。 */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,n])/g, (_all, ch: string) => (ch === "n" ? "\n" : ch));
}

function events(): string[] {
  return [...logical(raw()).matchAll(/BEGIN:VEVENT\n([\s\S]*?)END:VEVENT/g)].map((m) => m[1]);
}

function prop(event: string, name: string): string {
  const m = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "m").exec(event);
  return m ? m[1] : "";
}

function locations(): string[] {
  return [...logical(raw()).matchAll(/^LOCATION:(.*)$/gm)].map((m) => m[1]);
}

function mdRows(): string[][] {
  const md = readFileSync(join(site, "upcoming.md"), "utf8");
  return md
    .split("\n")
    .filter((l) => l.startsWith("| "))
    .slice(1)
    .map((l) =>
      l
        .replace(/^\|\s*/, "")
        .replace(/\s*\|$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
}

describe("カレンダーの各行に開催地（第 288 回）", () => {
  it("場所が判っている行には `LOCATION` が有り、無い行には無い", () => {
    const evs = events();
    // 実測: 検査用ビルドで 430 件、`repo/.cache` 付きの生成で 928 件。
    expect(evs.length, "VEVENT が数え上げられていない").toBeGreaterThan(250);
    const withPlace = evs.filter((e) => prop(e, "LOCATION") !== "");
    // 実測: 検査用ビルドで 3 割強、`repo/.cache` 付きで 686 / 928 件。
    expect(withPlace.length, "LOCATION が 1 個も無い（かつての実測そのもの）").toBeGreaterThan(150);
    const ratio = withPlace.length / evs.length;
    expect(ratio, "LOCATION の付き方が異常に少ない（収録の偏り疑い）").toBeGreaterThan(0.5);
    // 無い行は噓のない形で「判らない」を持っている（場所欄に語を置かない代わりに説明へ書く）。
    const without = evs.filter((e) => prop(e, "LOCATION") === "");
    const unlabeled = without.filter(
      (e) => !unescapeText(prop(e, "DESCRIPTION")).includes("開催地: "),
    );
    expect(unlabeled.slice(0, 2), "場所が無い行なのに何も書いていない").toEqual([]);
    if (without.length > 0) {
      // 無い行の書き方は 1 通りに揃える（ばらばらだと grep で探せない）。
      const labels = new Set(
        without.map(
          (e) => /開催地: ([^\n]*)/.exec(unescapeText(prop(e, "DESCRIPTION")))?.[1] ?? "",
        ),
      );
      expect(labels.size, "場所が無い行の書き方が揃っていない").toBe(1);
      expect([...labels][0], "場所が無い行の書き方が『未確認』になっていない").toContain("未確認");
    }
    // 中身の無い LOCATION（空・「-」など）を混ぜない。
    const weak = withPlace.filter((e) =>
      ["", "-", "未確認"].includes(unescapeText(prop(e, "LOCATION")).trim()),
    );
    expect(weak.slice(0, 2), "場所として筋の悪い値を LOCATION に載せている").toEqual([]);
  });

  it("転義と折り返しを戻すと、`upcoming.md` の開催地欄と同じ語になる", () => {
    /* 鍵は会議名ではなく `URL` にする。表示名だけで引くと、別々の会議が同じ表示名に
     * 見えたとき（実測 16 件）よその会場と比べて噓の不一致を出す。 */
    const placesByLink = new Map<string, Set<string>>();
    for (const r of mdRows()) {
      const link = /\]\((https?:\/\/[^)]+)\)$/.exec(r[2] ?? "")?.[1] ?? "";
      if (link === "") continue;
      const place = (r[6] ?? "").replace(/\\\|/g, "|");
      const set = placesByLink.get(link) ?? new Set<string>();
      set.add(place);
      placesByLink.set(link, set);
    }
    expect(placesByLink.size, "マークダウン版から会場が引けない").toBeGreaterThan(100);
    let checked = 0;
    let noLinkRow = 0;
    const wrong: string[] = [];
    for (const e of events()) {
      const location = unescapeText(prop(e, "LOCATION"));
      if (location === "") continue;
      const places = placesByLink.get(prop(e, "URL"));
      if (places === undefined) {
        noLinkRow += 1;
        continue;
      }
      checked += 1;
      if (!places.has(location))
        wrong.push(`${prop(e, "URL")}: md「${[...places][0]}」/ ics「${location}」`);
    }
    expect(checked, "照合できた行が 1 行も無い（組み立て方が変わった疑い）").toBeGreaterThan(150);
    expect(
      noLinkRow / (checked + noLinkRow),
      "照合できない行が多すぎる（検査が空振りしている疑い）",
    ).toBeLessThan(0.1);
    expect(wrong.slice(0, 3), `語がズレた行: ${wrong.length} 件`).toEqual([]);
  });

  it("TEXT の転義が効いている（カンマ・セミコロン・バックスラッシュ）", () => {
    const values = locations();
    expect(values.length).toBeGreaterThan(100);
    // 素のカンマは「値の区切り」として読まれるので護る。
    const rawComma = values.filter((v) => /(?<!\\),/.test(v));
    expect(rawComma.slice(0, 2), "護っていないカンマを含む値").toEqual([]);
    const rawSemi = values.filter((v) => /(?<!\\);/.test(v));
    expect(rawSemi.slice(0, 2), "護っていないセミコロンを含む値").toEqual([]);
    const lone = values.filter((v) => /\\(?![\\;,n])/.test(v));
    expect(lone.slice(0, 2), "意味の無い転義が残っている").toEqual([]);
    // 護る対象が実際に有る（無ければ上の転義検査は空振り）。
    expect(
      values.filter((v) => v.includes("\\,")),
      "カンマを含む開催地が 1 件も無い（転義の検査が空振りになる）",
    ).not.toHaveLength(0);
    // 二重に護していない（`\,` が `\\,` に見えない）。
    const double = values.filter((v) => v.includes("\\\\,"));
    expect(double.slice(0, 2), "カンマが二重に護されている").toEqual([]);
  });

  it("1 行 75 オクテットを守り、折り返しで転義を割っていない", () => {
    const text = raw();
    const lines = text.split("\r\n");
    const over = lines.filter((l) => Buffer.byteLength(l, "utf8") > 75);
    expect(over.slice(0, 2), `${over.length} 行が上限を越えている`).toEqual([]);
    // 前の行がバックスラッシュで終わっていると、続きの行で転義が解けない（§3.1 の禁令）。
    const split = lines.filter((l, i) => i + 1 < lines.length && /(?:^|[^\\])\\$/.test(l));
    expect(split.slice(0, 2), `${split.length} 行が転義の途中で折れている`).toEqual([]);
    // 折り返しを戻すと語が復元する（上限のせいで語が落ちていない）。
    const restored = locations().map((v) => unescapeText(v));
    const brokenShape = restored.filter(
      (v) => v.trim() === "" || v !== v.trim() || /\n|\r/.test(v) || / {2}/.test(v),
    );
    expect(brokenShape.slice(0, 2), `${brokenShape.length} 件の値が折り返しで壊れている`).toEqual(
      [],
    );
    // カンマを護った値は、戻すと必ず「カンマ + 空白」の形に戻る（海外の会場表記）。
    const commaBad = restored.filter((v) => v.includes(",") && !v.includes(", "));
    expect(commaBad.slice(0, 2), "カンマの後ろが詰まっている値がある").toEqual([]);
    // 国名まで日本語に揃った行が並んでいる（上流の生表記が混ざっていないことの示し）。
    expect(
      restored.filter((v) => /, [^\x20-\x7e]+$/.test(v)).length,
      "国名まで日本語に揃った開催地が並ばない",
    ).toBeGreaterThan(20);
  });

  it("行の並びは締切の瞬間順のまま（`LOCATION` を足した位置の副作用を見る）", () => {
    // 並びは本文の 6 行目（`SUMMARY`）を鍵にしているので、挿れる位置で意味が変わる。
    // 締切の瞬間順なら JST の暦日は戻らない（戻れば並びの鍵がずれた合図）。
    const days = events().map((e) => prop(e, "DTSTART"));
    expect(days.length).toBeGreaterThan(250);
    const bad: number[] = [];
    for (let i = 1; i < days.length; i += 1) if (days[i] < days[i - 1]) bad.push(i);
    expect(bad.slice(0, 3), `DTSTART が戻っている行: ${bad.length} 件`).toEqual([]);
  });
});
