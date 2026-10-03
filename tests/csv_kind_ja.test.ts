/**
 * 生の CSV（`data.csv`）の種別欄の検査（SPEC §7・第 270 回）。
 *
 * 2026-08-09 生成ビルドで実測した形：
 *   - `data.csv` は 3,253 行・25 欄。種別は `kind`（上流の英語キー 10 種）と
 *     `label`（上流の自由文）だけで、**日本語の種別欄は 0 本**だった。
 *     同じ内容を出す `upcoming.md`（種別欄あり）と `deadlines.ics`（DESCRIPTION に種別）は
 *     最初から日本語だったので、この表だけ並べ替え・絞り込みが英語に頼る形になっていた。
 *   - `label` はつづりが揺れる（'Paper submission' 1,483 行 / 'Paper Submission' 48 行 /
 *     'Paper submission deadline' 54 行が同じ物）。ここに依存させるのは危ない。
 *   - 直し方は `kind_ja` を**末尾に**足す（列の順序で読む下流を壊さない）。語は画面と同じ
 *     正本 `KIND_LABEL_JA`（`site/recommender.ts`）から引く。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { japaneseStringLiterals, site } from "./built_golden_shared.ts";

/* ------------------------------------------------------------------ 読み出し */

/** 引用符とカンマを守る最小の CSV 読み出し（`data.csv` は BOM 無し・LF）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvRows(): { header: string[]; body: string[][] } {
  const rows = parseCsv(readFileSync(join(site, "data.csv"), "utf8"));
  return { header: rows[0], body: rows.slice(1).filter((r) => r.length > 1) };
}

function column(name: string): { header: string[]; values: string[] } {
  const { header, body } = csvRows();
  const i = header.indexOf(name);
  expect(i, `欄 ${name} が無い`).toBeGreaterThanOrEqual(0);
  return { header, values: body.map((r) => r[i] ?? "") };
}

/**
 * マークダウンの表から、指定の欄だけを取り出す。
 * `|` で始まる行を無条件に拾うと、同じ文書の中の別な表（凡例など）まで拾ってしまう
 * （第 270 回の実発生: 縮約カタログのビルドで、種別の欄に別表の「R1」「R2」が現れた）。
 */
function markdownColumn(text: string, columnJa: string): string[] {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("|")) continue;
    const head = lines[i]
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    const k = head.indexOf(columnJa);
    if (k < 0) continue;
    const out: string[] = [];
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j += 1) {
      const cells = lines[j]
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      if (cells[k]) out.push(cells[k]);
    }
    expect(out.length, `マークダウンの ${columnJa} 欄に行が無い`).toBeGreaterThan(0);
    return out;
  }
  throw new Error(`マークダウンに ${columnJa} 欄を持つ表が無い`);
}

/**
 * ビルド成果物に並ぶ日本語の語をそのまま拾う（検査側に語を書き写さない）。
 * ビルドでは関数名が付け替わることがあるので、関数を抜き出すのではなく、成果物に実際に
 * 含まれる日本語の文字列その物を正しく使う（第 270 回の実測で `kindLabelTable` が
 * その名で見つからなかった）。
 */
function builtJapaneseWords(): Set<string> {
  const rec = readFileSync(join(site, "recommender.js"), "utf8");
  return new Set(japaneseStringLiterals(rec));
}

/** `llms.txt` の「data.csv の列」から、指定の欄の説明だけを取り出す。 */
function csvColumnNote(name: string): string {
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  const line = text.split("\n").find((l) => l.startsWith(`- ${name}：`));
  expect(line, `列の辞書に ${name} が無い`).toBeDefined();
  return (line ?? "").slice(`- ${name}：`.length);
}

/* ---------------------------------------------------------------------- 検査 */

describe("生の CSV の日本語の種別欄（第 270 回）", () => {
  it("欄が末尾に有り、既存の列順を変えていない", () => {
    const { header } = csvRows();
    // 日付の意味と複数会期を末尾へ追加。従来の列は相対順序を維持。
    expect(header[header.length - 3], "日本語の種別欄の位置が変わった").toBe("kind_ja");
    expect(header.at(-1)).toBe("event_segments");
    expect(header.at(-2)).toBe("date_field");
    expect(header.indexOf("kind"), "英語のキーの欄が消えた").toBeGreaterThanOrEqual(0);
    expect(header.filter((h) => h === "kind_ja").length, "同じ欄が 2 本有る").toBe(1);
    // 末尾に足したので、従来いちばん後ろだった欄はそのまま残る。
    expect(header[header.length - 4], "列の並びが変わっている").toBe("link");
  });

  it("全行の欄数が揃っており、日本語の種別が空欄の行が無い", () => {
    const { header, body } = csvRows();
    const wrong = body.filter((r) => r.length !== header.length);
    expect(wrong.length, `欄数が合わない行が ${wrong.length} 本有る`).toBe(0);
    const { values } = column("kind_ja");
    const blank = values.filter((v) => !v.trim());
    expect(blank.length, `種別が空欄の行が ${blank.length} 本有る`).toBe(0);
    // 行数は生成時刻とカタログで動く（共有ハーネスは縮約カタログで 510 行、実カタログの
    // 2026-08-09 生成で 3,253 行を実測）。ここは「全行」を見ることが目的なので下限は緩くする。
    expect(values.length, "行数が読めない").toBeGreaterThan(100);
  });

  it("日付の列が締切を指すかその他の日かを分ける欄が有る（第 302 回）", async () => {
    /* 実測（2026-09-24・2026-08-09 生成ビルド）: 3,253 行のうち **311 行**が締切ではない日
       （採否通知 242・反論期間開始 37・査読結果公開 32）で、そのうち **307 行**が「締切の瞬間」と
       説明した `deadline_utc` に値を持っていた。この欄が無い表で日付から絞り込む人は、通知日を
       締切として数える（カレンダーと `data.json` は第 299 回から呼ぶ語を出していた – 表計算に
       渡す表だけ持たなかった）。 */
    const { header, values } = column("date_field");
    expect(values.length, "行数が読めない").toBeGreaterThan(100);
    const blank = values.filter((v) => !v.trim());
    expect(blank.length, `呼びが空欄の行が ${blank.length} 本有る`).toBe(0);
    /* 値は語の正本（ビルド成果の `kindDateFieldJa`）が英語のキーから決める物と一致する。
       表の中で独自の言い回しを増やしていないことの検査でもある。 */
    const Recommender = (await import(pathToFileURL(join(site, "recommender.js")).href))
      .default as unknown as { kindDateFieldJa: (kind: unknown) => string };
    const ki = header.indexOf("kind");
    const bad: string[] = [];
    csvRows().body.forEach((r) => {
      const want = Recommender.kindDateFieldJa(r[ki]);
      if ((r[header.indexOf("date_field")] ?? "") !== want) bad.push(`${r[ki]} -> ${want}`);
    });
    expect(bad.slice(0, 4), `語の正本と違う呼びが ${bad.length} 本有る`).toEqual([]);
    // 締切ではない日が実際に在る（無ければこの検査は空振りなので張る）。
    const notDeadline = values.filter((v) => v !== "締切");
    expect(notDeadline.length, "締切ではない日の行が 1 本も無い").toBeGreaterThan(0);
    expect(new Set(notDeadline).size, "締切ではない日の呼びが 1 種類しか無い").toBeGreaterThan(1);
    expect(values.filter((v) => v === "締切").length, "締切の行が無い").toBeGreaterThan(0);
  });

  it("締切の列が締切ではない日を含むことを、列の辞書がそれぞれの欄に書いている（第 302 回）", () => {
    /* Excel で列名だけ見て使う人は、列の辞書を llms.txt から読む – 日付の 3 本それぞれの説明が
       `date_field` を指していなければ、「採否通知の行の deadline_utc」に気づけない。 */
    const { values } = column("date_field");
    expect(
      values.some((v) => v !== "締切"),
      "締切ではない日の行が無い（検査が空振り）",
    ).toBe(true);
    for (const name of ["deadline_local_date", "deadline_utc", "deadline_aoe"]) {
      const note = csvColumnNote(name);
      expect(note.length, `${name} の説明が空欄`).toBeGreaterThan(0);
      expect(note, `${name} の説明が date_field に触れていない`).toContain("date_field");
    }
    // 欄自身の説明も、締切として扱って良い日を決める欄だと書いている。
    const own = csvColumnNote("date_field");
    expect(own.length, "date_field の説明が空欄").toBeGreaterThan(0);
    expect(own).toContain("締切");
    expect(own).toContain("data.json");
  });

  it("値は種別の語だけで、その他を継いでいない（第 301 回）", async () => {
    /* 実測（2026-08-09 生成ビルド・2026-09-24）: `kind_ja` の 3,253 行のうち **55 行**が
       「論文締切: Paper submission」のような値で、語の種類は 10 の筈が **41** に割れていた。
       列の辞書は第一文で「`kind`（英語のキー）と 1 対 1」と約束しているので、種別で
       フィルタ・ピボットを作る人はその 55 行を静かに取りこぼす。画面がダウンロードさせる
       CSV（`deadlinesToCsv`）は最初から語だけだった – 生データだけが違う形だった。 */
    const { values } = column("kind_ja");
    const suffixed = values.filter((v) => v.includes(": "));
    expect(suffixed.slice(0, 3), `種別の語にその他を継いだ値が ${suffixed.length} 本有る`).toEqual(
      [],
    );
    // 語彙は品選びの正本に在る物だけ（新しい語を足したときも通る）。
    const Recommender = (await import(pathToFileURL(join(site, "recommender.js")).href))
      .default as unknown as { kindLabelTable: () => Record<string, string> };
    const words = new Set(Object.values(Recommender.kindLabelTable()));
    const unknown = [...new Set(values)].filter((v) => !words.has(v));
    expect(unknown, `正本に無い種別が出ている: ${unknown.join(", ")}`).toEqual([]);
    /* 接尾辞を落とす直し方が、行の区別を奪っていないこと – 同じ版に同じ種別が重なる行は
       上流のラベルを持つので、`label` と `round` で区別できる。重なる行が 1 本も無いなら
       この検査は空振りなので張る。 */
    const { header, body } = csvRows();
    const at = (name: string) => header.indexOf(name);
    const rows = body.map((r) => ({
      ed: r[at("edition_id")] ?? "",
      kind: r[at("kind")] ?? "",
      label: (r[at("label")] ?? "").trim(),
    }));
    const seen = new Map<string, number>();
    rows.forEach((r) => {
      const key = `${r.ed}|${r.kind}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    });
    const doubled = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
    expect(doubled.size, "同じ版に同じ種別が重なる行が 1 本も無い（検査が空振り）").toBeGreaterThan(
      0,
    );
    const lost = rows.filter((r) => doubled.has(`${r.ed}|${r.kind}`) && !r.label);
    expect(lost.length, `重なる行で上流のラベルが空欄: ${lost.length} 本`).toBe(0);
  });

  it("値はサイト自身が持つ語だけで、英語のキーとの対応も割れていない", () => {
    const words = builtJapaneseWords();
    expect(words.size, "ビルド成果物から日本語の語が読めない").toBeGreaterThan(50);
    const { header, body } = csvRows();
    const ki = header.indexOf("kind");
    const ji = header.indexOf("kind_ja");
    const bad: string[] = [];
    body.forEach((r) => {
      const ja = r[ji] ?? "";
      // 第 301 回から語だけを書くので、そのまま正本の語彙と比べる。
      if (!words.has(ja)) bad.push(`${r[ki]} -> ${ja}`);
    });
    expect(bad.slice(0, 4), `サイトの語彙に無い種別が出ている: ${bad.length} 件`).toEqual([]);
    // 英語のキーと同じ行に乗り、キーごとに日本語が 1 語に決まっている（対応が 2 通りに割れない）。
    const byKind = new Map<string, Set<string>>();
    body.forEach((r) => {
      const key = r[ki] ?? "";
      const set = byKind.get(key) ?? new Set<string>();
      set.add(r[ji] ?? "");
      byKind.set(key, set);
    });
    expect(byKind.size, "英語のキーが読めない").toBeGreaterThanOrEqual(8);
    const doubled = [...byKind].filter(([, set]) => set.size !== 1).map(([k]) => k);
    expect(
      doubled,
      `1 つのキーに日本語が 2 つ以上割り当てられている: ${doubled.join(", ")}`,
    ).toEqual([]);
  });

  it("マークダウンは、区別の要る行の接尾辞を残している（第 301 回 – 直し過ぎの防止）", () => {
    /* 画面の表と `upcoming.md` は、同じ版に同じ種別が重なる行を語の後ろに上流のラベルを
       継いで区別する – 人が読む表ではそれが要るので、落としてはいけない（落とした側は
       表計算で語を選ぶ人向け）。 */
    const words = markdownColumn(readFileSync(join(site, "upcoming.md"), "utf8"), "種別");
    const kept = words.filter((v) => v.includes(": "));
    expect(kept.length, "接尾辞が消えて行を区別できなくなっている").toBeGreaterThan(0);
  });

  it("マークダウンとカレンダーが出す種別と同じ語を指している（成果物間で語彙が割れない）", () => {
    const { values } = column("kind_ja");
    // 同じ年に同じ種別が複数ある行だけは ': ' + 上流のラベルを続けるので、語だけ揃えて比べる。
    const inCsv = new Set(values.map((v) => v.split(": ")[0].trim()));
    const md = readFileSync(join(site, "upcoming.md"), "utf8");
    const mdWords = new Set(
      markdownColumn(md, "種別")
        .map((v) => v.split(":")[0].trim())
        .filter((w) => w && w !== "種別"),
    );
    expect(mdWords.size, "マークダウンの種別が読めない").toBeGreaterThanOrEqual(2);
    // 「開催」行は 1 行 1 締切のこの表には入らない（`type` が deadline の行だけ書く）ので外す。
    // マークダウンは 180 日の窓しか出さないので、語の数はこちらの方が多い側になる。
    const missing = [...mdWords].filter((w) => w !== "開催" && !inCsv.has(w));
    expect(missing, `マークダウンに出る種別が CSV の日本語欄に無い: ${missing.join(", ")}`).toEqual(
      [],
    );

    /* カレンダーも同じ語。75 オクテットで折られた行は戻して読み、語だけ取り出す。第 303 回から、
       区別の為の上流ラベルは語の後ろに全角の括弧で括るので、それを落としてから比べる。 */
    const ics = readFileSync(join(site, "deadlines.ics"), "utf8").replace(/\r\n /g, "");
    const icsWords = new Set(
      [...ics.matchAll(/種別:([^|\\]+)/g)]
        .map((m) =>
          m[1]
            .trim()
            .replace(/（[^（）]*）$/u, "")
            .split(": ")[0]
            .trim(),
        )
        .filter((w) => w !== ""),
    );
    expect(icsWords.size, "カレンダーから種別が読めない").toBeGreaterThanOrEqual(2);
    const missing2 = [...icsWords].filter((w) => w !== "開催" && !inCsv.has(w));
    expect(missing2, `カレンダーに出る種別が CSV の日本語欄に無い: ${missing2.join(", ")}`).toEqual(
      [],
    );
  });

  it("索引は CSV の全欄の意味を持っている（欄を足して説明を忘れない）", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const from = txt.indexOf("## data.csv の列");
    expect(from, "欄の説明の節が無い").toBeGreaterThan(-1);
    const next = txt.indexOf("\n## ", from + 10);
    const section = txt.slice(from, next < 0 ? txt.length : next);
    const { header } = csvRows();
    /* 名前が並んでいるだけ検査だと、説明が空欄の欄（`- kind_ja：` だけ）を通してしまう
     * （第 270 回の改ざんで実発生: 説明側をリネームしても落ちなかった）。
     * 「名前の後ろに何か書いてある」まで見る。 */
    const undocumented = header.filter((name) => !new RegExp(`^- ${name}：\\S`, "m").test(section));
    expect(undocumented, `説明の無い欄がある: ${undocumented.join(", ")}`).toEqual([]);
    expect(header.length, "欄の数が読めない").toBeGreaterThanOrEqual(25);
  });

  it("索引は「日本語の値を書かない」という契約を例外込みで正直に書いている", () => {
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const from = txt.indexOf("## data.csv の列");
    expect(from, "欄の説明の節が無い").toBeGreaterThan(-1);
    const next = txt.indexOf("\n## ", from + 10);
    const section = txt.slice(from, next < 0 ? txt.length : next);
    const contract = /日本語は書かない/.exec(section);
    expect(contract, "契約の文が消えた（実物が決まったときに気づけなくなる）").toBeTruthy();
    expect(
      section.slice(contract!.index, contract!.index + 500),
      "日本語を書く例外を宣言していない（索引が噓をついている）",
    ).toContain("kind_ja");
  });

  it("案内が、生の CSVに日本語の欄が有ると正直に言っている（てびきと JavaScript 無効の案内）", () => {
    const page = readFileSync(join(site, "index.html"), "utf8");
    const ns = /<noscript>([\s\S]*?)<\/noscript>/.exec(page);
    expect(ns, "JavaScript 無効の案内が無い").toBeTruthy();
    const nsText = ns![1].replace(/\s+/g, "");
    expect(nsText, "生の CSV の案内が種別を言わない").toContain("種別");
    expect(nsText, "生の CSV の案内が日本語の欄があることを隠している").toContain("2欄");
    const guide = [...page.matchAll(/<details[\s\S]*?<\/details>/g)]
      .map((m) => m[0])
      .sort((a, b) => b.length - a.length)[0];
    expect(guide, "てびきが data.csv の日本語の欄を置いていない").toContain("kind_ja");
    const txt = readFileSync(join(site, "llms.txt"), "utf8");
    const line = txt.split("\n").find((l) => l.startsWith("- data.csv："));
    expect(line, "索引の CSV の説明が種別欄を言わない").toContain("kind_ja");
  });
});
