/**
 * 「打ちたい語」と「表に出る語」が噛み合わない検査（SPEC §7）。
 * ビルド済みサイトは tests/built_site.ts 経由で共有する（1 ファイルに全検査を並べると
 * biome の既定の上限にぶつかる – tests/lint_budget.test.ts）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string; kind: string };

function rows(): Row[] {
  const parsed = JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown;
  return Recommender.candidateRows(parsed as { conferences: unknown }) as Row[];
}

it("「〆切」で引いた人が「締切」で引いた人と同じ行に出会える（略字は照合の内側で折る）", () => {
  /* 「〆」は「締」の略字で、収録元が原表記のまま入る行がある（2026-08-09 生成の実測:
   * 情報処理学会研究会の「発表申込〆切(延長後)」）。NFKC は漢字の略字を折込まないので、
   * `〆切` は 4 行に当たり、同じ意味の `締切`（700 行）で引いた人と同じ画面に
   * 出会えなかった。 */
  const all = rows();
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay))).length;
  };
  const shime = hits("締切");
  expect(shime, "締切で引ける行が無い（検査が空振り）").toBeGreaterThan(0);
  expect(hits("〆切"), "略字が折込まれていない（`〆切` が単独の語のまま残った）").toBe(shime);

  /* 折込みは両側に効いていること（実データに両方の表記が揃うとは限らないので、
   * 合成した行で確かめる）。 */
  expect(
    Recommender.searchMatcher("発表申込締切")("研究会 発表申込〆切(延長後)"),
    "検索語が「締」で原表記が「〆」の行に当たらない",
  ).toBe(true);
  expect(
    Recommender.searchMatcher("発表申込〆切")("研究会 発表申込締切"),
    "検索語が「〆」で原表記が「締」の行に当たらない",
  ).toBe(true);
  /* 照合に使う文字列（hay）に略字が残っていないこと – ここが残ると「締切」で引いた人が
   * その行をまだ逃がす。 */
  expect(
    all.filter((row) => String(row.hay).includes("〆")).length,
    "検索に使う文字列に略字が残っている（照合側が折れていない）",
  ).toBe(0);
  /* 無関係な語は変わらないこと（折込みを広げ過ぎていないことの確認）。 */
  expect(Recommender.searchMatcher("論文締切")("論文締切 2026年10月"), "語のかけ算が壊れた").toBe(
    true,
  );
  /* 画面に出す文字は書き換えていない – 収録の原表記は略字のまま残っている
   * （2026-08-09 生成の実測: ビルド後の data.json にも「〆」が 7 箇所残る）。 */
  expect(
    readFileSync(join(REPO_ROOT, "data", "manual.yaml"), "utf8"),
    "収録の原表記から略字が消えた（表示を書き換えた可能性がある）",
  ).toContain("〆");
  /* てびき: built の index.html に直接当てる（app.js を継いだ文字列だと、コードの中の
   * 日本語が混ざって空振りする – 第 239 回の実測）。 */
  expect(
    readFileSync(join(builtSite(), "index.html"), "utf8"),
    "てびきに折込む語の組を書いていない",
  ).toContain("<code>〆</code> → <code>締</code>");
});

it("「投稿締切」「論文提出」で引いた人が種別「論文締切」の行に出会える", () => {
  /* 日本の研究者がいちばん書く言い方なのに、表の語は「論文締切」なので噛み合わなかった
   * （2026-08-09 生成の実測: `投稿締切` 2 行 / `論文投稿` 1 行 / `論文提出` 0 行 /
   * `原稿提出` 0 行、同じ意味の `論文締切` は 454 行）。 */
  const all = rows();
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay)));
  };
  const paper = hits("論文締切").length;
  expect(paper, "論文締切の行が無い（検査が空振り）").toBeGreaterThan(0);
  for (const query of ["投稿締切", "論文投稿", "論文提出", "原稿提出", "投稿", "提出"]) {
    expect(hits(query).length, `「${query}」で種別「論文締切」の行に出会えない`).toBe(paper);
  }
  /* 寄せ先が誤っていないこと – 原文の "paper" に寄せると採否通知の行が混ざる
   * （`論文募集` で実測した失敗）。出る行は投稿締切の種類だけにする。 */
  const kinds = [...new Set(hits("投稿締切").map((row) => String(row.kind)))];
  expect(kinds, "寄せた行に投稿締切以外の種別が混ざった").toEqual(["paper"]);
  /* 寄せたことは件数欄に出す（寄せるだけだと、なぜ出たか分からない）。 */
  expect(Recommender.querySynonymNotes("投稿締切").join("")).toContain(
    "種別「論文締切」で探しています",
  );
  /* 絞り込みは壊れていない – 語のかけ算はそのまま効く。 */
  const both = hits("セキュリティ 提出").length;
  expect(both, "語のかけ算で 0 件になった").toBeGreaterThan(0);
  expect(both, "語のかけ算が絞れていない").toBeLessThan(paper);
});

it("「オンライン開催」「hybrid」で引いた人が参加形式「オンライン参加可」の行に出会える", () => {
  /* 画面に出る参加形式の語は「オンライン参加可」だけなので、いちばん自然な言い方を打つ人が
   * 0 行に当たっていた（2026-08-09 生成の実測: `オンライン開催` 0 行 / `ハイブリッド開催` 0 行 /
   * `リモート` 0 行 / `遠隔` 0 行 / `ウェブ開催` 0 行、英語も `hybrid` 4 行・`online` 3 行で、
   * 同じ意味の `オンライン参加可` は 24 行）。 */
  const all = rows();
  const matched = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay)));
  };
  const online = matched("オンライン参加可");
  expect(online.length, "参加形式の印が付いた行が無い（検査が空振り）").toBeGreaterThan(0);
  for (const query of [
    "オンライン開催",
    "ハイブリッド開催",
    "リモート",
    "遠隔",
    "ウェブ開催",
    "web開催",
    "hybrid",
    "remote",
    "online",
  ]) {
    const found = matched(query);
    expect(found.length, `「${query}」で参加形式の行に出会えない`).toBeGreaterThanOrEqual(
      online.length,
    );
    /* 印の付いた行は必ず含まれる（寄せた先を見ていることの確認）。 */
    for (const row of online) {
      expect(found.includes(row), `「${query}」で寄せ先の行が落ちた`).toBe(true);
    }
    expect(
      Recommender.querySynonymNotes(query).join(""),
      `「${query}」を寄せたことを出していない`,
    ).toContain("参加形式「オンライン参加可」で探しています");
  }
  /* 寄せない語も検査にする – 逆の言い方（対面・in-person）は収録に語が無く、寄せると
   * 逆の意味の行を出すことになる。`virtual` は会議名の "Virtual Reality" に当たるので
   * 寄せない（実測: 寄せると 24 行のところ 34 行になり、余分は会議名の行だった）。 */
  for (const query of ["対面", "in-person", "onsite", "現地参加", "virtual"]) {
    expect(
      Recommender.querySynonymNotes(query).join(""),
      `「${query}」を寄せている（逆の意味や会議名を引く語）`,
    ).toBe("");
  }
  /* 語のかけ算は絞ったまま効く。 */
  const andQuery = matched("オンライン参加可 オンライン");
  expect(andQuery.length, "語のかけ算で寄せ先の行が消えた").toBe(online.length);
});

it("欄の名前（分野・種別・参加形式）を打った人に、値の例を出す", () => {
  /* 軸の名前を打つ人は 1 行も減らないのに、画面は「その語は収録に無い」と言っていた
   * （2026-08-09 生成の実測: `分野` 0 行 / 値の `セキュリティ` 152 行、`種別` 0 行 /
   * `論文締切` 461 行、`参加形式` 0 行 / `オンライン参加可` 24 行）。
   * 「カテゴリ」「カテゴリー」も 0 行だが、打たれた語を案内に書き返すため、この画面で
   * 使ってはいけない語を並べる検査（開発用語を残さない検査）に当たるので載せない。 */
  const all = rows();
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay))).length;
  };
  for (const word of [
    "分野",
    "テーマ",
    "分類",
    "種別",
    "種類",
    "ステータス",
    "参加形式",
    "会場",
    "地域",
    "都道府県",
  ]) {
    expect(hits(word), `「${word}」が当たりを持ってしまった（注記を出す前提が崩れた）`).toBe(0);
    const note = Recommender.columnQueryNoteJa(word);
    expect(note, `「${word}」に対する打ち直し方を出していない`).toContain("値で打ってください");
    /* 例に挙げる語は、本当に当たりを持つ語だけにする（無い語を勧められても打てない）。 */
    const examples = note.slice(note.indexOf("例: "));
    const listed = [...examples.matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    expect(listed.length, `「${word}」の例を書いていない`).toBeGreaterThan(0);
    for (const word2 of listed) {
      expect(hits(word2), `「${word}」の例の「${word2}」が 0 行で打ち直せない`).toBeGreaterThan(0);
    }
    /* 読み上げも同じ表から作る（画面と読み上げが別のことを言わないようにする）。 */
    const live = Recommender.columnQueryLiveNoteJa(word);
    expect(live, `「${word}」の読み上げが打ち直し方を言わない`).toContain("欄");
    expect(live, `「${word}」の読み上げが例の語を言わない`).toContain(listed[0]);
  }
  /* 値の語には注記を出さない（当たりがあるので、出すほうが噓になる）。 */
  expect(Recommender.columnQueryNoteJa("セキュリティ"), "値の語に注記を出した").toBe("");
  /* 配線: 0 件案内と読み上げの両方がこの注記を通る（実測で画面を見られないので、
   * ビルド済み app.js の呼び出しと順番を見る – 「収録データにありません」より前）。 */
  const app = readFileSync(join(builtSite(), "app.js"), "utf8");
  expect(app, "0 件案内がこの注記を通っていない").toContain("Recommender.columnQueryNoteJa(");
  const liveCall = app.indexOf("Recommender.columnQueryLiveNoteJa(");
  expect(liveCall, "読み上げがこの注記を通っていない").toBeGreaterThan(-1);
  // コメントの中にも同じ語が現れるので、読み上げの文その物（全角の区切りを付けた形）で測る。
  expect(
    liveCall < app.indexOf("\uff5c 語「"),
    "読み上げが「収録データにありません」を先に言っている",
  ).toBe(true);
  /* てびき: built の index.html に当てる。 */
  const html = readFileSync(join(builtSite(), "index.html"), "utf8");
  expect(html, "てびきに欄の名前の話を書いていない").toContain("<strong>欄の名前</strong>");
  expect(html, "てびきに値の例を書いていない").toContain("<code>オンライン参加可</code>");
});

it("「セキュリティの会議」のように助詞で繋いだ検索語が当たる", () => {
  /* 検索語を空白でしか分けていなかったので、助詞を挟んで打った人が 0 行に当たっていた
   * （2026-08-09 生成ビルドの実測・872 行: `セキュリティの会議` 0 行で `セキュリティ` は
   * 152 行、`9月の締切` 0 行で `9月 締切` は 209 行、`国内の研究会` 0 行で `国内研究会` は
   * 23 行、`採否の通知` 0 行で `採否通知` は 129 行）。 */
  const all = rows();
  const matched = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay)));
  };
  const hits = (query: string) => matched(query).length;
  /* 助詞で切った語は、語を並べて打ったのと同じ行に出会う。 */
  for (const [phrase, words] of [
    ["セキュリティの会議", "セキュリティ"],
    ["9月の締切", "9月 締切"],
    ["国内の研究会", "国内 研究会"],
  ] as const) {
    expect(hits(words), `比べる側の「${words}」が 0 行で検査が空振りしている`).toBeGreaterThan(0);
    expect(hits(phrase), `「${phrase}」が「${words}」と同じ行に出会えない`).toBe(hits(words));
  }
  /* 表の全行にあてはまる語（`会議` `大会`）は、他の語があるとき絞り込みに使わない。
   * 部分集合の語（`ワークショップ`）はそのまま絞れることも同時に検査する。 */
  const security = hits("セキュリティ");
  expect(hits("セキュリティの会議"), "「会議」で絞れてしまった").toBe(security);
  expect(hits("セキュリティのワークショップ"), "部分集合の語まで落とした").toBeLessThan(security);
  expect(hits("セキュリティ 会議"), "語を並べて打った場合と助詞で繋いだ場合がズレた").toBe(
    hits("セキュリティの会議"),
  );
  /* 助詞の字を含むひらがなの地名は壊さない（実測: `ながさき` を `が` で割ると 1 行も
   * 当たらない語になった）。分けた語が短くなる分割は捨てている。 */
  for (const word of ["ながさき", "やまぐち", "おきなわ", "きょうと"]) {
    const matches = Recommender.searchMatcher(word);
    expect(matches(`ふりがな ${word} 開会`), `「${word}」を助詞で割った`).toBe(true);
  }
  /* 分割を採る条件そのものの検査 – 割れた部品を別々に含む行に当たってはならない
   * （`ながさき` を `が` で割ると `な` と `さき` を別々に探す照合になる）。 */
  const 地名 = [
    ["ながさき", "ながれ さきした"],
    ["やまぐち", "まぐち の 会場"],
    ["おきなわ", "おき にな わ かり"],
    ["きょうと", "きょう と する"],
  ] as const;
  for (const [word, hay] of 地名) {
    const matches = Recommender.searchMatcher(word);
    expect(matches(hay), `「${word}」を助詞で割った（別々に含む行に当たっている）`).toBe(false);
  }
  /* 表じゅうの語だけを打った人は、0 行のまま理由を出す（絞れたと読ませない）。 */
  for (const word of ["会議", "大会", "かいぎ"]) {
    expect(hits(word), `「${word}」だけ打ったときに何かが出てしまった`).toBe(0);
    expect(
      Recommender.wholeTableQueryNoteJa(word),
      `「${word}」に対する説明を出していない`,
    ).toContain("検索では絞り込めません");
  }
  const note = Recommender.querySynonymNotes("セキュリティの会議").join("");
  expect(note, "どう探したかを出していない").toContain(
    "この表の全行にあてはまる語なので絞り込みに使い",
  );
  expect(note, "代わりに使った語を書いていない").toContain("「セキュリティ」");
  /* てびき: built の index.html に当てる。 */
  const html = readFileSync(join(builtSite(), "index.html"), "utf8");
  expect(html, "てびきに助詞の読み方を書いていない").toContain("助詞で繋いだ文のままでも引けます");
  expect(html, "てびきに表じゅうの語の話を書いていない").toContain(
    "表の全行にあてはまる語なので、他の語を一緒に打ったときは絞り込みに使いません",
  );
});
