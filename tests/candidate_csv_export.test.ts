import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { jsFunction, siteRuntime, vmSafeSource } from "./runtime_extract.ts";

const NOW = Date.parse("2026-10-08T12:00:00Z");

/** 推薦の候補の 1 行（画面が `venueRecommendations` の結果へ足す印をそのまま持つ）。 */
function 候補(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: Date.UTC(2027, 1, 12, 11, 59),
    kind: "paper",
    est: false,
    conf: {
      key: "sigcomm",
      title: "SIGCOMM",
      categories: ["nw"],
      rank: { ccf: "A", core: "A*" },
      link: "https://example.org/",
    },
    ed: { id: "sigcomm2027", year: 2027, place: "Osaka, 日本" },
    dl: { kind: "paper" },
    _fitLabel: "候補",
    _matchScore: 58,
    _vocabScore: 31,
    _semScore: 0.812,
    ...over,
  };
}

/** CSV を欄へ割る（引用の中のコンマを欄の区切りと読まない）。 */
function 欄(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `candidateScopeOnScreen` を、最小の DOM で使える形で組み立てる（画面の正本をそのまま使う）。 */
function 候補の別(document: unknown, mode: string): () => boolean {
  const src = jsFunction(siteRuntime(), "candidateScopeOnScreen");
  return new Function("state", "document", vmSafeSource(`${src}\nreturn candidateScopeOnScreen;`))(
    { mode },
    document,
  ) as () => boolean;
}

function 行々(csv: string): { 見出し: string[]; 行: string[][] } {
  const lines = csv.split("\r\n").filter((l) => l.length > 0);
  return { 見出し: 欄(lines[0]), 行: lines.slice(1).map(欄) };
}

describe("推薦の候補を CSV で持ち出す（第 870 回）", () => {
  it("先頭の 4 列が一致の欄で、残りは一覧の CSV と同じ並び", () => {
    const csv = Recommender.candidateRowsToCsv([候補()], NOW);
    const { 見出し, 行 } = 行々(csv);
    expect(見出し.slice(0, 4), "先頭の 4 列が違う").toEqual([
      "一致評価",
      "一致の点",
      "言葉の一致",
      "意味の近さ",
    ]);
    /* 5 列目から後ろは一覧の CSV と同じ見出し（同じ語を 2 つの書き方に割らない）。 */
    const 一覧 = 行々(Recommender.deadlinesToCsv([候補()], NOW));
    expect(見出し.slice(4), "締切の欄の見出しが一覧と違う").toEqual(一覧.見出し);
    /* 行も同じ – 締切の欄は同じ関数から作る（値の写し間違いをここで止める）。 */
    expect(行.length, "1 行になっていない").toBe(1);
    expect(行[0].slice(4), "締切の欄の値が一覧と違う").toEqual(一覧.行[0]);
    /* 見出しと行の数が合う（欄を足して見出しを忘れる、を止める）。 */
    expect(行[0].length, "見出しと行の欄数が違う").toBe(見出し.length);
  });

  it("一致の 4 列は、画面の札と行の詳細が出す値をそのまま書く", () => {
    const { 行 } = 行々(Recommender.candidateRowsToCsv([候補()], NOW));
    const [評価, 点, 言葉, 意味] = 行[0];
    expect(評価, "一致評価の語が違う").toBe("候補");
    expect(点, "一致の点が違う").toBe("58");
    expect(言葉, "言葉の一致が違う").toBe("31");
    expect(意味, "意味の近さが違う").toBe("0.812");
    /* 札の語は `fitLabel` の 3 語（画面のカードと同じ正本）。 */
    expect([Recommender.fitLabel("sufficient"), Recommender.fitLabel("ambiguous")]).toEqual([
      "十分な一致",
      "候補",
    ]);
  });

  it("実際の候補（収録の品書から推薦を回す）でも、4 列が fit の値と一致する", () => {
    /* 手で作った行ではなく、**本物の推薦の出力**で見る（欄の名前と `fit` の対応がずれても、
     * 見本の行なら気付かない）。品書はテスト用のビルドが作る `catalog.json` を使う。 */
    const catalog = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8"));
    const rows = Recommender.candidateRows(catalog) as unknown as Record<string, unknown>[];
    expect(rows.length, "品書の行が読めていない").toBeGreaterThan(100);
    const pLines = Recommender.parsePaperLines(
      "高速な分散ストレージの合意形成とフォールトトレランス\nキーワード: consensus, replication, fault tolerance",
    );
    const 推薦 = Recommender.venueRecommendations(rows, pLines, null, NOW, {
      venueCats: [],
      fieldedLexical: true,
    }).filter((r) => r.fit.score >= 10);
    expect(推薦.length, "候補が 1 件も出ない（検査の前提が崩れた）").toBeGreaterThan(0);
    /* 画面が候補の行へ足す印と同じ物を付ける（`site/app.ts` の写し – 写しである事は下の
     * 検査が張る）。 */
    const 候補行 = 推薦.map((r) => ({
      ...r.row,
      _matchScore: r.fit.score,
      _fitLabel: r.fit.label,
      _vocabScore: r.fit.lexicalScore,
      _semScore: r.fit.semanticScore,
    })) as unknown as Record<string, unknown>[];
    const { 見出し, 行 } = 行々(Recommender.candidateRowsToCsv(候補行, NOW));
    expect(行.length, "候補の数と CSV の行数が違う").toBe(推薦.length);
    const 評価の欄 = 見出し.indexOf("一致評価");
    const 点の欄 = 見出し.indexOf("一致の点");
    const 語の欄 = 見出し.indexOf("言葉の一致");
    for (const [i, r] of 推薦.entries()) {
      expect(行[i][評価の欄], `${r.fit.label} の札が違う`).toBe(r.fit.label);
      expect(行[i][点の欄], "一致の点が fit.score と違う").toBe(String(r.fit.score));
      expect(行[i][語の欄], "言葉の一致が fit.lexicalScore と違う").toBe(
        String(r.fit.lexicalScore),
      );
    }
    /* 画面が付ける印の対応（`site/app.ts`）が変わっていない – 変わったらこの寫しも直す。 */
    const app = siteRuntime();
    for (const [印, 元] of [
      ["_matchScore", "score"],
      ["_fitLabel", "label"],
      ["_vocabScore", "lexicalScore"],
      ["_semScore", "semanticScore"],
    ]) {
      expect(app, `画面が ${印} を fit.${元} から取っていない`).toMatch(
        new RegExp(`${印}: recommendation\\.fit\\.${元}\\b`),
      );
    }
  });

  it("意味の近さは 0 を書かない（測って居ないのと、測って 0 を同じ数字にしない）", () => {
    /* 画面も「意味の近さ 0点」とは出さない（札の内訳は 0 より大きいときだけ並ぶ）。意味検索を
     * 使えない環境では全行が 0 になるので、それを「近さ 0」と書くと表計算の人が別の意味に読む。 */
    const 意味無し = 行々(
      Recommender.candidateRowsToCsv([候補({ _semScore: 0 }), 候補({ _semScore: undefined })], NOW),
    );
    expect(意味無し.行[0][3], "意味の近さ 0 を書いた").toBe("");
    expect(意味無し.行[1][3], "値のない行に何か書いた").toBe("");
    /* 言葉の一致は逆に 0 も書く（行の詳細が「言葉の一致スコア 0点」と出す値）。 */
    const 語彙ゼロ = 行々(Recommender.candidateRowsToCsv([候補({ _vocabScore: 0 })], NOW));
    expect(語彙ゼロ.行[0][2], "言葉の一致の 0 を落とした").toBe("0");
  });

  it("値がない候補でも欄は崩れない（印のない行・空の入力）", () => {
    /* 印は推薦の経路だけが付ける。素の締切の行を渡しても欄の数は変わらない（呼び出し側の
     * 取り違えで CSV の欄がずれると、表計算の列が全部ひとつずつずれる）。 */
    const 印無し = 行々(Recommender.candidateRowsToCsv([{ t: NOW, kind: "paper", dl: {} }], NOW));
    expect(印無し.行.length, "行が出ていない").toBe(1);
    expect(印無し.行[0].slice(0, 4), "印のない行に何か書いた").toEqual(["", "", "", ""]);
    expect(印無し.行[0].length, "欄の数が変わった").toBe(印無し.見出し.length);
    /* 空の入力でも見出しだけは出る（表計算に貼る先が無くなるのを防ぐ）。 */
    expect(Recommender.candidateRowsToCsv([], NOW).split("\r\n").filter(Boolean).length).toBe(1);
    expect(Recommender.candidateRowsToCsv(null, NOW)).toBe(Recommender.candidateRowsToCsv([], NOW));
  });

  it("コンマや引用符を含む値も、欄として壊れない", () => {
    const csv = Recommender.candidateRowsToCsv(
      [候補({ conf: { key: "x", title: 'A,B "C"', categories: [] } })],
      NOW,
    );
    const { 見出し, 行 } = 行々(csv);
    expect(行[0].length, "引用した値で欄が割れた").toBe(見出し.length);
    /* 欄の番号は見出しから引く（前に 4 列を足したときに番号を書き写さない）。 */
    expect(行[0][見出し.indexOf("会議")], "会議名が壊れた").toContain('A,B "C"');
  });

  it("画面の繋ぎがある（押せる物・押したときの動き・ラベル・ファイル名）", () => {
    const dir = builtSite();
    const html = readFileSync(join(dir, "index.html"), "utf8");
    expect(html, "押せる物がない").toContain('id="exportCsv"');
    const app = siteRuntime();
    /* 推薦の候補の時は候補の欄で書く（画面の別を渡している）。 */
    expect(app, "推薦の別を渡していない").toContain("Recommender.candidateRowsToCsv(");
    expect(app, "押したときの繋ぎがない").toContain('addEventListener("click", exportShownCsv)');
    /* 候補が空なら出さない（隠す条件から推薦の別を外した）。 */
    expect(app, "推薦では出さないままになっている").not.toContain(
      "exportBtn.hidden = recMode || !shown.length;",
    );
    /* 推薦の画面でも、論文情報が空なら候補は 1 件も出ていない – その時に候補の名で書き出すと、
     * 画面に出ていない締切の一覧を候補として渡すことになる（隠す条件で止める）。 */
    expect(app, "候補が出ていない時に候補の名で出している").toContain(
      "exportBtn.hidden = !shown.length || (recMode && !候補を書き出す);",
    );
    /* 候補と一覧でファイル名を分ける（同じ日に両方落とした人が見分けられる）。 */
    expect(app, "ファイル名を分けていない").toContain(
      `anchor.download = \`kamiyobi-\${recMode ? "candidates" : "deadlines"}-\${stamp}.csv\`;`,
    );
    /* 押す前に、欄の意味と「一致評価とは別の計算」を言う（点を札の点と読ませない）。 */
    const 説明 = jsFunction(app, "render");
    expect(説明, "一致の点と札の違いを言っていない").toContain("「一致評価」の札は別の計算");
    expect(説明, "意味の近さの空欄の意味を言っていない").toContain("意味の近さ」は空になります");
    /* ラベルは一覧と候補で言い分ける（同じ物を指す語を画面ごとに変えない）。 */
    const 文言 = new Function(
      "countJa",
      vmSafeSource(`${jsFunction(app, "exportCsvLabelJa")}\nreturn exportCsvLabelJa;`),
    )((n: number) => String(n)) as (n: number, recMode?: boolean) => string;
    expect(文言(12), "一覧の文言が違う").toBe("この一覧の 12 件を CSV でダウンロード");
    expect(文言(12, true), "候補の文言が違う").toBe("この候補 12 件を CSV でダウンロード");
  });

  it("候補の別は、推薦の画面で論文情報がある時だけ（画面に出ていない行を候補と呼ばない）", () => {
    const src = jsFunction(siteRuntime(), "candidateScopeOnScreen");
    const 見る = (mode: string, paper: string): boolean =>
      (
        new Function("state", "document", vmSafeSource(`${src}\nreturn candidateScopeOnScreen;`))(
          { mode },
          { getElementById: () => ({ value: paper }) },
        ) as () => boolean
      )();
    expect(見る("recommend", "合意形成とフォールトトレランス"), "候補が出ている時に false").toBe(
      true,
    );
    /* 空白だけの入力は「空」と同じ（画面のカードも出ない）。 */
    expect(見る("recommend", "   \n "), "空白だけの入力で候補にした").toBe(false);
    expect(見る("recommend", ""), "論文情報が空なのに候補にした").toBe(false);
    expect(見る("deadlines", "合意形成"), "締切の一覧を候補にした").toBe(false);
    /* 欄その物が無い差し込みでも落ちない（書き出しの別で例外を投げない）。 */
    const 欄無し = new Function(
      "state",
      "document",
      vmSafeSource(`${src}\nreturn candidateScopeOnScreen;`),
    )({ mode: "recommend" }, { getElementById: () => null }) as () => boolean;
    expect(欄無し(), "欄がない時に落ちるか、候補にした").toBe(false);
  });

  it("押すと、候補の 1 本が落ちて来る（DOM を真似する）", () => {
    /* 抜き出した関数を、最小の DOM で走らせる（落ちて来る物の名前と中身の先頭を見る）。 */
    const src = jsFunction(siteRuntime(), "exportShownCsv");
    const 落ちた: string[] = [];
    let 本文 = "";
    const anchor = {
      href: "",
      download: "",
      click: () => 落ちた.push(anchor.download),
    };
    const document = {
      createElement: () => anchor,
      body: { appendChild: () => {}, removeChild: () => {} },
      /* 候補の別は `candidateScopeOnScreen()` が論文の欄を読んで決める（推薦の画面で論文情報が
       * ある時だけ候補 – 下の検査がその規則を持つ）。 */
      getElementById: () => ({ value: "合意形成とフォールトトレランス" }),
    };
    class Blob {
      constructor(parts: unknown[]) {
        本文 = String(parts[0]);
      }
    }
    const URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
    const 走らせる = new Function(
      "shown",
      "state",
      "Recommender",
      "Blob",
      "URL",
      "document",
      "candidateScopeOnScreen",
      vmSafeSource(`${src}\nreturn exportShownCsv;`),
    )(
      [候補()],
      { mode: "recommend" },
      Recommender,
      Blob,
      URL,
      document,
      候補の別(document, "recommend"),
    ) as () => void;
    走らせる();
    expect(落ちた.length, "1 本も落ちて来ない").toBe(1);
    expect(落ちた[0], "名前が違う").toMatch(/^kamiyobi-candidates-\d{8}\.csv$/);
    /* BOM 付きで、先頭の見出しが候補の物（Excel が日本語として読める形）。 */
    expect(本文.startsWith("\ufeff"), "BOM がない").toBe(true);
    expect(本文, "候補の見出しでない").toContain("一致評価,一致の点,言葉の一致,意味の近さ");
    /* 一覧の時は一覧の名前と欄（同じ関数が画面の別で書き分ける）。 */
    落ちた.length = 0;
    本文 = "";
    const 一覧で走らせる = new Function(
      "shown",
      "state",
      "Recommender",
      "Blob",
      "URL",
      "document",
      "candidateScopeOnScreen",
      vmSafeSource(`${src}\nreturn exportShownCsv;`),
    )(
      [候補()],
      { mode: "deadlines" },
      Recommender,
      Blob,
      URL,
      document,
      候補の別(document, "deadlines"),
    ) as () => void;
    一覧で走らせる();
    expect(落ちた[0], "一覧の名前が違う").toMatch(/^kamiyobi-deadlines-\d{8}\.csv$/);
    expect(本文, "一覧の見出しでない").not.toContain("一致の点");
  });

  it("索引（llms.txt）が、候補の欄の意味を書いている", () => {
    const llms = readFileSync(join(builtSite(), "llms.txt"), "utf8");
    expect(llms, "候補の書き出しを書いていない").toContain("投稿先を探す");
    expect(llms, "候補の欄を書いていない").toContain("一致評価・一致の点・言葉の一致・意味の近さ");
    expect(llms, "一致の点と札の違いを書いていない").toContain(
      "一致評価は証拠の強さを表す区分で、点とは別",
    );
  });

  it("てびきが、候補の CSV を画面と同じ語で書いている", () => {
    const html = readFileSync(join(builtSite(), "index.html"), "utf8");
    expect(html, "てびきが候補の CSV を書いていない").toContain(
      "この候補 N 件を CSV でダウンロード",
    );
    expect(html, "てびきがファイル名を書いていない").toContain("kamiyobi-candidates-");
    /* 直す前の斷りが残っていない（候補の CSV は出す – てびきと画面が食い違わない）。 */
    expect(html, "候補では CSV を出さないと書いたまま").not.toContain(
      "投稿先を探す画面では CSV は出しません",
    );
  });
});

it("候補の CSV は順位表と同じ行を書く（第 1095 回）", () => {
  const src = jsFunction(siteRuntime(), "exportShownCsv");
  const 落ちた: string[] = [];
  let 本文 = "";
  const anchor = { href: "", download: "", click: () => 落ちた.push(anchor.download) };
  const document = {
    createElement: () => anchor,
    body: { appendChild: () => {}, removeChild: () => {} },
    getElementById: () => ({ value: "合意形成とフォールトトレランス" }),
  };
  class Blob {
    constructor(parts: unknown[]) {
      本文 = String(parts[0]);
    }
  }
  const URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
  /* 走らせる。`shown` は**順位表その物**を渡す（CSV は `shown` を書く）。 */
  const 走らせる = new Function(
    "shown",
    "state",
    "Recommender",
    "Blob",
    "URL",
    "document",
    "candidateScopeOnScreen",
    vmSafeSource(`${src}\nreturn exportShownCsv;`),
  )([候補()], { mode: "recommend" }, Recommender, Blob, URL, document, () => true) as () => void;
  走らせる();
  expect(落ちた.length, "1 本も落ちて來ない").toBe(1);
  expect(落ちた[0], "候補の名前が違う").toMatch(/^kamiyobi-candidates-\d{8}\.csv$/);
  /* **順位表の行数だけ**書く – 雜音を足さない。
   * 見出し 1 行 + 渡した行 1 行。 */
  const 行 = 本文.split("\n").filter((l) => l.length > 0);
  expect(行.length, "順位表の行数と違う（餘計な行を書いた）").toBe(2);
  expect(行[0], "候補の見出しでない").toContain("一致評価");
  /* BOM 付きで、Excel が日本語として読める形。 */
  expect(本文.startsWith("\ufeff"), "BOM がない").toBe(true);
});
