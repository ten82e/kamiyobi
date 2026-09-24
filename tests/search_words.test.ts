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

it("「採択通知」「最終原稿」で引いた人が種別の行に出会える", () => {
  /* 種別の欄に出る語（採否通知・カメラレディ締切・登録締切・査読結果公開）の言い方を打つ人が
   * 0 行に当たっていた（2026-08-09 生成ビルドの実測・872 行: `採択通知` `採択` `採択結果`
   * `結果通知` `合否通知` `受理通知` `合否` は 0 行で、`採否通知` は 129 行。`最終原稿` `最終稿`
   * `カメラレディ原稿` 0 行 / `カメラレディ締切` 70 行、`登録期限` `事前登録` `登録開始` 0 行 /
   * `登録締切` 7 行、`レビュー結果` `審査結果` `査読公開` 0 行 / `査読結果公開` 13 行）。 */
  const all = rows();
  const matched = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return all.filter((row) => matches(String(row.hay)));
  };
  const groups = [
    [
      "採否通知",
      "notification",
      ["採択通知", "採択", "採択結果", "結果通知", "合否通知", "受理通知", "合否"],
    ],
    ["カメラレディ締切", "camera_ready", ["最終原稿", "最終稿", "カメラレディ原稿"]],
    ["登録締切", "registration", ["登録期限", "事前登録", "登録開始"]],
    ["査読結果公開", "review_release", ["レビュー結果", "審査結果", "査読公開"]],
  ] as const;
  let 行で確かめた組 = 0;
  for (const [label, kind, words] of groups) {
    for (const word of words) {
      /* 語の寄せそのものは行の収録に依存しないので、作って置いた文字列で確かめる
       * （行の検査は下の「収録のある種別だけ」の節でやる）。 */
      const matches = Recommender.searchMatcher(word);
      expect(matches(`締切 表記 ${label}`), `「${word}」が「${label}」に寄せられていない`).toBe(
        true,
      );
      expect(matches("締切 別の表記"), `「${word}」が寄せ先以外の語にも当たった`).toBe(false);
      expect(
        Recommender.querySynonymNotes(word).join(""),
        `「${word}」を寄せたことを出していない`,
      ).toContain(`種別「${label}」で探しています`);
    }
    /* 検査のビルド（固定時計 + 収録の一部）に行が有る種別は、行レベルでも確かめる –
     * 寄せた先の種別以外の行を交えないことを見る（第 243 回の教訓: 意味の違う語を寄せない）。 */
    const labelRows = matched(label);
    if (!labelRows.length) continue;
    for (const word of words) {
      const found = matched(word);
      expect(found.length, `「${word}」で寄せ先の行に出会えない`).toBe(labelRows.length);
      const kinds = [...new Set(found.map((row) => String(row.kind)))];
      expect(kinds.join(","), `「${word}」で違う種別を交えた`).toBe(kind);
    }
    行で確かめた組 += 1;
  }
  expect(行で確かめた組, "行レベルの検査が 1 組も走らなかった（検査が空洞）").toBeGreaterThan(0);
  /* 寄せない語も実測で決めている（意味が広がる語を寄せると嘘になる）。
   * `最終版` `最終提出` は提出その物の話で論文締切と混じる。 */
  for (const word of ["最終版", "最終提出", "リバットル", "採択通知日"]) {
    expect(
      Recommender.querySynonymNotes(word).join(""),
      `「${word}」を寄せている（意味が広がる語）`,
    ).toBe("");
  }
  /* 語のかけ算は絞ったまま効く。 */
  expect(matched("採択通知 2027").length, "語のかけ算で寄せ先の行が消えた").toBeLessThanOrEqual(
    matched("採択通知").length,
  );
});

it("表に出さない種別を名指す案内は、打たれた語から筋道が通った語だけを出す", () => {
  /* 案内は「検索語は『X』の種別に当たります（表に出さない種別です）」を出す。その X が
   * 的外れだと、目の前の 0 件の説明が噓になる（2026-08-09 生成ビルドの実測）。
   *  - HEAD: `〆切` と `締切 福岡` が 補足資料締切・カメラレディ締切・登録締切・締切 の四つに
   *    当たっていた（正規化で `〆切` -> `締切` となり、種別 `other` の表示語「締切」が他の種別の
   *    語にすっぽり含まれるため）。
   *  - HEAD: 第 246 回で言い換え表に載せた `登録期限` `レビュー結果` は、検索は寄せているのに
   *    この案内は別名の表しか見ていなかったので、種別を名指さなかった。 */
  const labels = Object.keys(Recommender.kindLabelTable())
    .filter((kind) => ["abstract", "paper", "journal"].indexOf(kind) < 0)
    .map((kind) => String(Recommender.kindLabelTable()[kind] || ""));
  const named = (query: string) => Recommender.queryHiddenKindMatches(query, labels);
  /* 打たれた語がそのまま種別の語のとき。 */
  expect(named("カメラレディ").join(",")).toBe("カメラレディ締切");
  expect(named("camera ready").join(",")).toBe("カメラレディ締切");
  expect(named("補足資料").join(",")).toBe("補足資料締切");
  /* 言い換えの正本（`QUERY_SYNONYMS_JA`）を通した語も同じ案内を出す（第 246 回で載せた言い換えと同じ正本を通す）。 */
  for (const [word, label] of [
    ["採択", "採否通知"],
    ["登録期限", "登録締切"],
    ["事前登録", "登録締切"],
    ["レビュー結果", "査読結果公開"],
    ["査読公開", "査読結果公開"],
  ] as const) {
    expect(named(word).join(","), `「${word}」が種別「${label}」を名指さない`).toContain(label);
  }
  /* 語の途中での一致は、複数の種別に同時に当たった瞬間に区別ではなくなるので名指さない。
   * 一方で 1 つの種別にしか当たらない語は、語の途中の一致でも名指してよい（従来どおり）。 */
  for (const word of ["〆切", "締切 福岡", "締め切り", "セキュリティ", "機械学習", "反論"]) {
    expect(named(word).join(","), `「${word}」で筋の違う種別を名指した`).toBe("");
  }
  /* 反論は 反論期間開始・反論期間終了 の二つにまたがるので名指さない。別名（語がその物）なら
   * 二つとも名指してよい（第 246 回で `リバットル` を言い換え表に載せなかったのと同じ理由）。 */
  expect(named("リバットル").join(",")).toBe("反論期間開始,反論期間終了");
  expect(named("通知").join(","), "1 つの種別にしか当たらない語を落とした").toBe("採否通知");
  expect(named("査読").join(","), "1 つの種別にしか当たらない語を落とした").toBe("査読結果公開");
  /* 部分一致で寄せた語の途中で別の種別に当たらない（`最終原稿` -> カメラレディ締切 の中に
   * 種別「締切」が含まれる事故を実測で防いでいる）。 */
  expect(named("最終原稿").join(",")).toBe("カメラレディ締切");
  /* 言い換えを二箇所に書かない（`HIDDEN_KIND_ALIASES_JA` の語が `QUERY_SYNONYMS_JA` の語と
   * 重なったら、片方だけ直してズレる – 第 246 回に実際に起きた。検査機のビルドではなく
   * ソースを見るのは、正本の重複を防ぐ検査だから）。 */
  const src = readFileSync(join(process.cwd(), "site", "recommender.ts"), "utf8");
  // 型注釈を持つ宣言なので `= ` を挟むとは限らない（実測で抜けないことが分かった）。
  const synonyms = src.match(/const QUERY_SYNONYMS_JA[\s\S]*?\n {2}\];/)?.[0] ?? "";
  const aliases = src.match(/const HIDDEN_KIND_ALIASES_JA[\s\S]*?\n {2}\};/)?.[0] ?? "";
  expect(synonyms, "言い換えの表を抜き出せない（検査が空洞）").not.toBe("");
  expect(aliases, "別名の表を抜き出せない（検査が空洞）").not.toBe("");
  const synonymWords = new Set([...synonyms.matchAll(/^\s{4}\["([^"]+)"/gm)].map((m) => m[1]));
  // 別名の表では列の名（`カメラレディ締切:`）は引用符で囲まず、値だけを下げて書くので、
  // 引用符の中身が別名である。
  const aliasWords = [...aliases.matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((w) => w.length > 1);
  expect(aliasWords.length, "別名を 1 つも抜き出せない（検査が空洞）").toBeGreaterThan(0);
  for (const word of aliasWords) {
    expect(synonymWords.has(word), `「${word}」を言い換えの表と別名の表の二箇所に書いている`).toBe(
      false,
    );
  }
});

it("画面自身の語（使い方・並び替え・出典・カテゴリなど）を打った人に行き先を言う", () => {
  /* 2026-08-09 生成ビルドの実測: `使い方` `ヘルプ` `てびき` `つかいかた` `みかた` `確定`
   * `並び替え` `並び順` `絞り込み` `フィルタ` `条件` `出典` `一次情報` `データ源`
   * `カテゴリ` `カテゴリー` `ラベル` `フィールド` はいずれも 0 行で、案内も空だった。
   * 表の値ではない語なので、語を短くしても増えない – 場所を言う（第 248 回）。 */
  const hays = rows().map((row) => String(row.hay));
  const groups: Array<[string[], string]> = [
    [["使い方", "ヘルプ", "てびき", "つかいかた", "みかた", "確定"], "見方のてびき"],
    [["並び替え", "並び順", "絞り込み", "フィルタ", "条件"], "上にある欄"],
    [["出典", "一次情報", "データ源"], "データ源"],
    [["カテゴリ", "カテゴリー", "ラベル", "フィールド"], "分野"],
  ];
  let checked = 0;
  for (const [words, destination] of groups) {
    for (const word of words) {
      const hits = hays.filter((hay) => Recommender.searchMatcher(word)(hay)).length;
      expect(hits, `「${word}」は表に当たりがあるので案内の前提が崩れている`).toBe(0);
      const note = Recommender.uiWordNoteJa(word);
      const live = Recommender.uiWordLiveNoteJa(word);
      expect(note, `「${word}」の案内が出ていない`).toContain(destination);
      expect(live, `「${word}」の読み上げが出ていない`).toContain(destination);
      checked += 1;
    }
  }
  expect(checked, "案内を検査した語が 0 件（検査が空洞）").toBeGreaterThan(10);
  /* 画面に実在しない場所へ送らない（案内が名指す画面の語はビルド済み HTML に実在する）。 */
  const html = readFileSync(join(builtSite(), "index.html"), "utf8");
  for (const word of ["見方のてびき", "データ源", "並び順", "条件クリア", "参加形式", "ランク"]) {
    expect(html, `案内が名指す「${word}」が画面に無い`).toContain(word);
  }
  /* 実装側の語を案内に書き返さない（別名として受け入れるだけの語 – 開発用語の検査が
   * 「打たれた語としてだけ受け入れる」に分けているので、ここでは案内文で確かめる）。 */
  for (const word of ["カテゴリ", "カテゴリー", "フィルタ", "トピック", "シグナル"]) {
    for (const [words] of groups) {
      for (const query of words) {
        expect(Recommender.uiWordNoteJa(query), `案内に「${word}」を書き返した`).not.toContain(
          word,
        );
        expect(
          Recommender.uiWordLiveNoteJa(query),
          `読み上げに「${word}」を書き返した`,
        ).not.toContain(word);
      }
    }
  }
  /* 表その物を指す語（`一覧` `締切一覧`）は、絞り込みに使わない（第 245 回の `会議` と同じ）。
   * 実測: HEAD のビルドでは `一覧` `一覧表` `締切一覧` が 0 行だった。 */
  for (const word of ["一覧", "一覧表", "締切一覧"]) {
    expect(
      Recommender.wholeTableQueryWordJa(word),
      `「${word}」が表の全行の語になっていない`,
    ).not.toBe("");
    expect(Recommender.uiWordNoteJa(word), `「${word}」を二つの案内で重複して説明している`).toBe(
      "",
    );
  }
  /* 値の語には何も言わない（`セキュリティ` に場所を言ってはいけない）。 */
  expect(Recommender.uiWordNoteJa("セキュリティ")).toBe("");
  expect(Recommender.uiWordNoteJa("")).toBe("");
});

it("参加形式の「対面」側を打った人に、収録していないことを正直に言う", () => {
  /* 2026-08-09 生成ビルドの実測: `対面` `対面開催` `オフライン` `オンサイト` `現地` `現地開催`
   * `リアル` `リアル開催` はいずれも 0 行で、案内も読み上げも空だった。オンライン側
   * （`ハイブリッド` `リモート` `遠隔`）は『オンライン参加可』に寄せて行が出るので、
   * 対面側だけ行き先が無い。 */
  const hays = rows().map((row) => String(row.hay));
  /* 噓を書かない根拠: ビルド後の行に「対面」の表記が 1 つも無いことを実データで見る。
   * 収録するようになればこの検査が落ちて、案内の文を見直させる。 */
  expect(
    hays.filter((hay) => hay.includes("対面")).length,
    "行に『対面』が出るようになった（案内の文直しが要る）",
  ).toBe(0);
  let checked = 0;
  for (const word of [
    "対面",
    "対面開催",
    "オフライン",
    "オンサイト",
    "現地",
    "現地開催",
    "リアル",
    "リアル開催",
  ]) {
    const hits = hays.filter((hay) => Recommender.searchMatcher(word)(hay)).length;
    expect(hits, `「${word}」は当たりが出るようになった（前提が変わった）`).toBe(0);
    const note = Recommender.uiWordNoteJa(word);
    expect(note, `「${word}」の案内が出ていない`).toContain("オンライン参加可");
    expect(note, "収録していないことを言っていない").toContain("収録していません");
    const live = Recommender.uiWordLiveNoteJa(word);
    expect(live, `「${word}」の読み上げが出ていない`).toContain("オンライン参加可");
    expect(
      ` ｜ ${live}。下に外せる条件も書いてあります`.length,
      `「${word}」の読み上げが長い`,
    ).toBeLessThanOrEqual(60);
    checked += 1;
  }
  expect(checked, "案内を検査した語が 0 件（検査が空洞）").toBe(8);
  /* `仮想` は寄せない – 「仮想マシン」等の会議名に当たって行をよけいに出す（第 246 回の
   * `virtual` と同じ理由）。案内も出さない（0 行のままなので場所を言えない）。 */
  expect(Recommender.uiWordNoteJa("仮想")).toBe("");
});

it("「国内開催」で打った人を国内研究会・国内シンポジウムの行に出会わせる", () => {
  /* 実測: HEAD のビルドでは `国内開催` `国内会議` `日本開催` `国内向け` が 0 行で、
   * `国内` は 46 行に当たっていた（行は「国内研究会」等の表記を持つ）。 */
  const hays = rows().map((row) => String(row.hay));
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(query);
    return hays.filter((hay) => matches(String(hay))).length;
  };
  const domestic = hits("国内");
  expect(domestic, "国内の行が 0 件（検査の前提が変わった）").toBeGreaterThan(20);
  for (const word of ["国内開催", "国内会議", "日本開催", "国内向け"]) {
    expect(hits(word), `「${word}」で国内の行に出会えない`).toBe(domestic);
    const note = String(Recommender.querySynonymNotes(word));
    expect(note, `「${word}」の寄せ先を件数欄が言っていない`).toContain("国内研究会");
  }
  /* `米国開催` は第 249 回では寄せられなかった（`米国` は 787 行に当たるが、行のなかに
   * 「米国」の表記は 1 つも無く、地域まとめの展開が効いて初めてあたる語で、hop 合成が
   * 見出しで止まっていた）。第 250 回で hop を直し、**言い換えた語と同じ行数に出会える**
   * ことをここで見る（違えば噓の案内になる – `米国` に寄せただけで 0 行だった頃に戻る）。 */
  const usa = hits("米国");
  expect(usa, "米国の行が 0 件（検査の前提が変わった）").toBeGreaterThan(100);
  for (const word of ["米国開催", "アメリカ開催", "米国向け"]) {
    expect(hits(word), `「${word}」で米国の行に出会えない`).toBe(usa);
    expect(
      String(Recommender.querySynonymNotes(word)),
      `「${word}」の寄せ先を言っていない`,
    ).toContain("米国");
  }
  /* `海外` には寄せ先が無い（行に「海外」の表記が無く、対応する欄もない）ので載せない。
   * 載せると「探しています」の噓になる – 実測で 0 行。 */
  expect(Recommender.querySynonymNotes("海外開催")).toEqual([]);
});

it("言い換えの先が地域まとめの見出しでも行に届く（打ち込まれた見出しは今までどおり）", () => {
  /* 第 250 回: hop 合成は地域まとめの見出しで止めていた（`アジア` → `中国` → 都道府県と
   * 連鎖して組が膨らむのを防ぐため – SPEC §7 の既定の約束）。そのせいで、言い換えの先が
   * `米国` のような見出しのときだけ 0 行のままだった。見出しを越えるのは**打ち込まれた語が
   * 見出しでないときだけ**にしているので、両方をここで見る。 */
  const hays = rows().map((row) => String(row.hay));
  const matches = (query: string) => {
    const test = Recommender.searchMatcher(query);
    return hays.filter((hay) => test(String(hay)));
  };
  /* 言い換えの先（`米国開催` → `米国`）は見出しを越えて届く。 */
  expect(matches("米国開催").length, "言い換えが地域まとめの見出しで止まっている").toBe(
    matches("米国").length,
  );
  /* 打ち込まれた見出し（`アジア`）は越えない – 国内研究会の行が混ざらないこと
   * （「『アジア』に国内の行は入らない」という既定の約束）。 */
  const asia = matches("アジア");
  expect(asia.length, "アジアの行が 0 件（検査の前提が変わった）").toBeGreaterThan(10);
  expect(
    asia.filter((hay) => String(hay).includes("国内研究会")).length,
    "アジアの展開が国内の行まで広かった",
  ).toBe(0);
  /* 地方の見出しも同じ – `九州` の行に他の地方の行が混ざらない。 */
  const kyushu = matches("九州");
  expect(kyushu.length, "九州の行が 0 件（検査の前提が変わった）").toBeGreaterThan(0);
  expect(
    kyushu.filter((hay) => String(hay).includes("北海道")).length,
    "九州の展開が他の地方の行まで広かった",
  ).toBe(0);
});

it("助詞で繋がれた相対月（来月の締切）でも同じ行に出会える", () => {
  /* 研究計画の立て方でいちばん言う形（2026-08-09 生成ビルド・固定時刻で実測）。
   * 相対月は `expandRelativeMonths` が `YYYY年M月` に展開するが、空白で区切られた語しか
   * 見ていなかった。日本語は助詞のまわりに空白を書かないので `来月の締切` は 1 語のまま
   * 展開を通り越し、助詞で割られた `来月` が語として残って行に当たらない。
   * 実測: `来月` 343 行 / `来月 セキュリティ` 41 行 / `来月の締切` **0 行**。 */
  const all = rows();
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const hits = (query: string) => {
    // 画面と同じ経路（展開 → 照合）で数える。
    const matches = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, NOW), NOW);
    return all.filter((row) => matches(String(row.hay))).length;
  };
  /* 助詞で繋いだ形と、空白で区いた形が同じ行数になること（違いがあれば画面側の噓）。 */
  for (const [joined, spaced] of [
    ["来月の締切", "来月 締切"],
    ["来月の論文締切", "来月 論文締切"],
    ["今月の会議", "今月 会議"],
    ["再来月の国内研究会", "再来月 国内研究会"],
    ["先月の締切", "先月 締切"],
    ["来月中の締切", "来月 締切"],
  ]) {
    const expected = hits(spaced);
    expect(expected, `基準の「${spaced}」が行に出会えない（前提が変わった）`).toBeGreaterThan(0);
    expect(hits(joined), `「${joined}」で同じ行に出会えない`).toBe(expected);
  }
  /* 件数欄が展開結果を出す根拠: 助詞で繋がれた形でも暦月に解決されていること
   * （「来月と打てば 2026年9月 へ化けたことがその場で読める」という画面の約束）。 */
  const expanded = String(Recommender.expandRelativeMonths("来月の締切", NOW));
  expect(expanded, "相対月が暦月に解決されていない").toContain("2026年9月");
  expect(expanded, "一緒に打った語が消えた").toContain("締切");
  /* 展開を呼ばずに検索語の組を作る経路（件数点検・照合の内部）でも同じ解決をすること。
   * ここが違っていると、画面の場所によって当たり方が変わる。 */
  const groups = Recommender.queryTokenGroups("来月の締切", NOW) as string[][];
  expect(
    groups.some((group) => group.indexOf("2026年9月") >= 0),
    `検索語の組に暦月が出てこない: ${JSON.stringify(groups)}`,
  ).toBe(true);
});

it("月の範囲の言い方（9月以降・9月から11月）で、計画の期間そのままの行に出会える", () => {
  /* 研究計画・出張の相談では期間で言う（2026-08-09 生成ビルド・固定時刻で実測）。
   * `9月` は 687 行に当たるのに、**`9月以降` 0 行・`9月から` 0 行・`9月から11月` 0 行**で
   * 案内も無かった（2026年9〜12月に当たる行は 957 行ある）。 */
  const all = rows();
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, NOW), NOW);
    return all.filter((row) => matches(String(row.hay)));
  };
  /* 期待値は実装の範囲計算を写さず、行が持つ暦月語から独立に作る。 */
  const expected = (specs: number[][]) => {
    const terms = specs.map(([year, month]) => `${year}年${month}月`);
    return all.filter((row) => terms.some((term) => String(row.hay).includes(term)));
  };
  const same = (query: string, want: number[][]) => {
    const set = new Set(expected(want).map((row) => String(row.hay)));
    expect(
      set.size,
      `基準の「${query}」の期待値が行に出会えない（前提が変わった）`,
    ).toBeGreaterThan(0);
    const got = hits(query);
    expect(got.length, `「${query}」の行数が期待値と違う`).toBe(set.size);
    expect(
      got.every((row) => set.has(String(row.hay))),
      `「${query}」で期待していない行が出た`,
    ).toBe(true);
  };

  same("9月以降", [
    [2026, 9],
    [2026, 10],
    [2026, 11],
    [2026, 12],
  ]);
  same("9月から", [
    [2026, 9],
    [2026, 10],
    [2026, 11],
    [2026, 12],
  ]);
  same("9月から11月", [
    [2026, 9],
    [2026, 10],
    [2026, 11],
  ]);
  // 年跨ぎ（11月から2月）は翌年まで出す。
  same("11月から2月", [
    [2026, 11],
    [2026, 12],
    [2027, 1],
    [2027, 2],
  ]);
  // 相対月にも同じ形が効く（来月 = 固定時刻の翌月）。
  const nextMonth = new Date(Date.UTC(2026, 8, 1));
  same("来月以降", [
    [nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1],
    [2026, 10],
    [2026, 11],
    [2026, 12],
  ]);
  // 基準月より前の月を打たれたら翌年として受ける（過ぎた月は計画の対象ではない）。
  const wholeNextYear: number[][] = [];
  for (let month = 1; month <= 12; month += 1) wholeNextYear.push([2027, month]);
  same("1月以降", wholeNextYear);

  // 他の語とのかけ算は絞込みとして効く。
  const rangeAndTopic = hits("9月以降 セキュリティ");
  const security = hits("セキュリティ");
  expect(security.length, "前提: セキュリティの行が無い").toBeGreaterThan(0);
  expect(rangeAndTopic.length, "月の範囲と他の語のかけ算が効いていない").toBeLessThan(
    security.length,
  );
  expect(rangeAndTopic.length, "月の範囲と他の語のかけ算が行に当たらない").toBeGreaterThan(0);
  // 範囲は単月の上位互換になる（9月を含む範囲は 9月 単体より狭くならない）。
  expect(hits("9月以降").length).toBeGreaterThanOrEqual(hits("9月").length);

  // 件数欄が範囲を言う（伏せた範囲指定は誤信を生む – 同じ画面の約束）。
  const notes = Recommender.monthRangePairs("9月以降", NOW) as Array<[string, string]>;
  expect(notes.length, "範囲の案内が出ていない").toBe(1);
  expect(String(notes[0]), "案内が出す範囲がちがう").toContain("2026年9月から2026年12月");
  const builtApp = readFileSync(join(builtSite(), "app.js"), "utf8");
  expect(
    builtApp.includes("monthRangePairs"),
    "件数欄が月の範囲の案内を出していない（ビルド済み app.js に部品が無い）",
  ).toBe(true);
});

it("季節の語（秋・春・来年の秋）で、計画の立て方そのままの行に出会える", () => {
  /* 「秋の学会に出したい」は分野をまたいだ計画の言い方（2026-08-09 生成ビルド・固定時刻
   * 2026-08-09T00:00:00Z で実測）。**`秋` 0 行・`春` 0 行・`夏` 0 行・`冬` 0 行・
   * `秋の会議` 0 行**で案内も無かった（2026年9〜11月に当たる行は 802 行ある）。 */
  const all = rows();
  const NOW = Date.parse("2026-08-09T00:00:00Z");
  const hits = (query: string) => {
    const matches = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, NOW), NOW);
    return all.filter((row) => matches(String(row.hay)));
  };
  const expected = (specs: number[][]) => {
    const terms = specs.map(([year, month]) => `${year}年${month}月`);
    return all.filter((row) => terms.some((term) => String(row.hay).includes(term)));
  };
  const same = (query: string, want: number[][]) => {
    const set = new Set(expected(want).map((row) => String(row.hay)));
    expect(set.size, `期待値が行に出会えない（前提が変わった）: ${query}`).toBeGreaterThan(0);
    const got = hits(query);
    expect(got.length, `「${query}」の行数が期待値と違う`).toBe(set.size);
    expect(
      got.every((row) => set.has(String(row.hay))),
      `「${query}」で期待していない行が出た`,
    ).toBe(true);
  };
  const AUTUMN_2026 = [
    [2026, 9],
    [2026, 10],
    [2026, 11],
  ];

  same("秋", AUTUMN_2026);
  // 助詞で繋がれた形も同じ行に出会う（第 251 回の相対月と同じ話）。
  same("秋の会議", AUTUMN_2026);
  same("春", [
    [2027, 3],
    [2027, 4],
    [2027, 5],
  ]);
  // 季節の途中では、これから来る月だけ出す（8 月に `夏` と打って 7 月の締切を出さない）。
  same("夏", [[2026, 8]]);
  same("冬", [
    [2026, 12],
    [2027, 1],
    [2027, 2],
  ]);
  // 年を冠で書いたときは繰り上げない（`来年9月以降` と同じ判断）。
  same("来年の秋", [
    [2027, 9],
    [2027, 10],
    [2027, 11],
  ]);
  // `去年の秋` は行セットに 2025 年の締切が無いと期待値が作れない（単位の検査で形を見る）。
  same("今年の夏", [
    [2026, 6],
    [2026, 7],
    [2026, 8],
  ]);

  // 他の語とのかけ算も壊れていない（助詞で繋いだ形と空白で並べた形が同じ行に出会う）。
  expect(hits("秋の国内").length, "季節と場所のかけ算が落ちた").toBeGreaterThan(0);
  expect(hits("秋の国内").length).toBe(hits("秋 国内").length);
  expect(hits("秋のセキュリティ").length).toBe(hits("秋 セキュリティ").length);
  // 単月の語より広いことは無い（`秋` は 9〜11 月の和集合なので）。
  expect(hits("秋").length).toBeGreaterThanOrEqual(hits("9月").length);

  // 季節の語でないものを割らない（地名を守る検査 – 第 251 回と同じ危険）。
  expect(hits("ながさき").length, "ひらがなの地名が割れて落ちた").toBe(hits("ながさき").length);
  expect(Recommender.queryTokenGroups("ながさき", NOW)[0], "地名が割れた").toContain("長崎");
  expect(Recommender.queryTokenGroups("秋田", NOW), "地名の語を季節に寄せるな").toEqual([["秋田"]]);

  // 件数欄に出した範囲（伏せた範囲指定は誤信を生む – 同じ画面の約束）。
  expect(Recommender.seasonPairs("秋", NOW)).toEqual([["秋", "2026年9月から2026年11月"]]);
  expect(Recommender.seasonPairs("来年の秋", NOW)).toEqual([
    ["来年の秋", "2027年9月から2027年11月"],
  ]);
  expect(Recommender.seasonPairs("9月", NOW)).toEqual([]);

  // ビルド済み画面が同じ部品を使う（正本をapp側が呼んでいない検査は空振りになる）。
  const app = readFileSync(join(builtSite(), "app.js"), "utf8");
  expect(app, "ビルド済み app.js が季節の展開を件数欄に出していない").toContain("seasonPairs");
});
