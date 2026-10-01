/**
 * 持ち出し・購読の語を**検索欄に打った人**の検査（SPEC §4・§7・第 321 回）。
 * 画面の一覧の下には『カレンダーに追加（.ics）』『この一覧の N 件を CSV でダウンロード』
 * 『購読 URL をコピー』の三つの操作が有るが、その名前の語を検索欄に打つ人は 0 行で案内も無かった
 * （2026-08-09 生成ビルド・固定時刻 2026-08-09T00:00:00Z で実測: `書き出し` `エクスポート`
 * `ダウンロード` `保存` `csv` `表計算` `スプレッドシート` `excel` `予定表` `カレンダー`
 * `カレンダーに追加` `購読` `サブスクライブ` はいずれも品書 872 行でも収録でも 0 行・案内も無し）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

type Row = { hay: string };

const AT = Date.parse("2026-08-09T00:00:00Z");
const 対象の語 = [
  "書き出し",
  "エクスポート",
  "ダウンロード",
  "保存",
  "csv",
  "表計算",
  "スプレッドシート",
  "予定表",
  "カレンダー",
  "カレンダーに追加",
  "購読",
  "サブスクライブ",
];

function 品書(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  ) as Row[];
}

function 収録(): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  ) as Row[];
}

function 当たり(rows: Row[], query: string): Row[] {
  const match = Recommender.searchMatcher(query, AT);
  return rows.filter((row) => match(row.hay) === true);
}

describe("持ち出し・購読の語を打った人", () => {
  it("0 行のまま放さず、一覧の下の操作を名前で言う", () => {
    const 品書行 = 品書();
    const 収録行 = 収録();
    対象の語.forEach((語) => {
      expect(当たり(品書行, 語).length, `"${語}" が品書で当たった（前提が変わった）`).toBe(0);
      expect(当たり(収録行, 語).length, `"${語}" が収録で当たった（前提が変わった）`).toBe(0);
      const 文 = Recommender.uiWordNoteJa(語);
      expect(文, `"${語}" を打った人に何も案内していない`).not.toBe("");
      expect(
        文.includes("絞り込めません") || 文.includes("当たりません"),
        `"${語}": 検索で引けないとはっきり言っていない`,
      ).toBe(true);
      expect(文.includes("一覧の下"), `"${語}": 操作の場所を言っていない`).toBe(true);
    });
  });

  it("案内が書く操作の名前は、画面の正本と一致する", () => {
    const html = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
    const カレンダー = /<a id="icsLink"[^>]*>([\s\S]*?)<\/a\s*>/.exec(html)?.[1].trim();
    const コピー = /<button id="icsCopy"[^>]*>([^<]+)<\/button>/.exec(html)?.[1].trim();
    const app = readFileSync(join(REPO_ROOT, "site", "app.ts"), "utf8");
    expect(カレンダー, "カレンダーへのリンクの語が見つからない").toContain("カレンダーに追加");
    expect(コピー, "購読 URL のボタンの語が見つからない").toBe("購読 URL をコピー");
    expect(app, "CSV ボタンの語が変わっている").toContain("CSV でダウンロード");
    対象の語.forEach((語) => {
      const 文 = Recommender.uiWordNoteJa(語);
      expect(
        文.includes(カレンダー || "?"),
        `"${語}": カレンダーへの語を画面と違う書き方で出す`,
      ).toBe(true);
      expect(文.includes(コピー || "?"), `"${語}": 購読 URL の語を画面と違う書き方で出す`).toBe(
        true,
      );
      expect(文.includes("CSV でダウンロード"), `"${語}": CSV の語を画面と違う書き方で出す`).toBe(
        true,
      );
      const 音声 = Recommender.uiWordLiveNoteJa(語);
      expect(音声.includes("CSV"), `"${語}": 読み上げが CSV に触れていない`).toBe(true);
    });
  });

  it("案内が .ics の落とし穴を隠さない", () => {
    /* .ics は収録全体の購読で、画面の絞り込みは引き継がない – 隠すと「絞ったまま出力できる」
     * 誤解になる（てびき・リンクの注記と同じ事実を書く）。 */
    対象の語.forEach((語) => {
      const 文 = Recommender.uiWordNoteJa(語);
      expect(文.includes("引き継がれません"), `"${語}": 絞り込みが引き継がれないことを隠した`).toBe(
        true,
      );
      expect(文.includes("収録全体"), `"${語}": .ics の範囲を曖昧に書いた`).toBe(true);
      /* CSV 側は絞り込み後の全行を出すので、その違いを曖昧にしない。 */
      expect(文.includes("絞り込み後の全行"), `"${語}": CSV の範囲を言っていない`).toBe(true);
    });
  });

  it("`ics` は案内の筋ではなく、貼り付きの当たりが残っている", () => {
    /* 語を足していない理由の実測（2026-08-09 生成の実ビルドの品書 872 行）: `ics` は 14 行に当たり、
     * その 10 行は会議名の一部分に貼り付いた物（"ICSOC" `@icsa20`）、`ical` は 2 行で同じ貼り付き。
     * 当たりが行にあるので 0 件案内の筋ではない。貼り付き自体は別の欠陥として §7 第 321 回に書いた
     * – ビルドハーネスの品書（試験用データ）でも同じ形が残っていることを見る。 */
    const 品書行 = 品書();
    ["ics"].forEach((語) => {
      const 当たる = 当たり(品書行, 語);
      expect(当たる.length, `"${語}" が 0 行になった（貼り付きが無くなった？）`).toBeGreaterThan(0);
      const 貼り付き = 当たる.filter(
        (row) => !new RegExp(`(^|[^a-z0-9])${語}([^a-z0-9]|$)`).test(String(row.hay).toLowerCase()),
      ).length;
      expect(貼り付き, `"${語}": 貼り付きの当たりが消えた（§7 の記述を見直す）`).toBeGreaterThan(0);
      /* `ics` は第 323 回で「当たりが行に在る語」のまま件数欄に出す案内を付けた
       * （0 件案内の入口ではない – `tests/ics_query_note.test.ts`）。ここでは
       * 持ち出し・購読の語の組に入れていないことだけ見る。 */
      expect(
        Recommender.uiWordNoteJa(語).includes("一覧の下の操作"),
        `"${語}" を語の組に寄せた`,
      ).toBe(false);
    });
    /* `excel` は収録の 1 行（ICRA 2023 の文中の語）に本当に当たる – 語としての検索が優先で、
     * 案内に奪わない。案内の語表に入れていないことをここで見る（入れても 1 行の人が
     * 案内だけを受けて行に会えなくなる）。 */
    const 収録行 = 収録();
    expect(
      当たり(収録行, "excel").length,
      "`excel` が 0 行になった（語表に入れてよいか前提が変わった）",
    ).toBeGreaterThan(0);
    expect(
      Recommender.uiWordNoteJa("excel"),
      "`excel` を案内に寄せた（実データで行が当たる）",
    ).toBe("");
    /* 複合打ちには案内が立たない（打ち切り一致）。 */
    ["csv 関西", "購読 2026", "ICSOC"].forEach((語) => {
      expect(Recommender.uiWordNoteJa(語), `"${語}" に案内が立ってしまった`).toBe("");
    });
  });

  /* 持ち出しの**形**を名指す打ち方（第 618 回）。羣は `csv` を見て居て JSON の語を見て居らず、
     又 訪ねが動詞で終る形は語尾の白一覧（第 505 回）が切れて默つて居た。實測（2026-08-09 生成の
     実ビルド）– `json` は品書 0 / 収録 0、`この一覧をJSONでもらえる` も 0 件・無言。*/
  it("JSON など形を名指す打ち方も同じ案内を受け、data.json の在りかを言う", () => {
    const 品書行 = 品書();
    const 収録行 = 収録();
    for (const 語 of ["json", "生データ", "機械可読", "フィード"]) {
      expect(当たり(品書行, 語).length, `"${語}" が品書で当たった（前提が変わった）`).toBe(0);
      expect(当たり(収録行, 語).length, `"${語}" が収録で当たった（前提が変わった）`).toBe(0);
      const 文 = String(Recommender.uiWordNoteJa(語) || "");
      expect(文, `"${語}" を打った人に何も案内していない`).not.toBe("");
      expect(文.includes("一覧の下"), `"${語}": 操作の場所を言っていない`).toBe(true);
      /* 画面上のボタンには JSON の物が無いので、**同じ場所の文件**を名前で言う（噓を書かんと為）。*/
      expect(文.includes("data.json"), `"${語}": JSON の在りかを隠した`).toBe(true);
    }
    /* 助詞・用言で繋がれた形は連体の道（第 608 回）で受ける。*/
    for (const 文 of [
      "この一覧をJSONでもらえる",
      "JSONでもらえますか",
      "csvでもらえる",
      "生データがほしい",
    ]) {
      expect(当たり(品書行, 文).length, `"${文}" が品書で当たった`).toBe(0);
      const 注 = String(Recommender.uiWordNoteJa(文) || "");
      expect(注.includes("data.json"), `"${文}": 案内が JSON に屆いていない`).toBe(true);
      const 聲 = String(Recommender.uiWordLiveNoteJa(文) || "");
      expect(聲, `"${文}": 読み上げが默つている`).not.toBe("");
      expect(聲.includes("CSV"), `"${文}": 読み上げが持ち出しを言っていない`).toBe(true);
    }
  });

  it("`データ` と `feed` は載せん – その語で絞れる行が實在する（門・第 337 回）", () => {
    /* 實測（2026-08-09 生成の実ビルド）– `データ` は収録 477 行・品書 128 行、`feed` は収録 4 行が
       通る。行が出る打ち方に「この表に無い」を被せん決まりなので、源に載せて居ない事を張る。*/
    expect(当たり(収録(), "データ").length).toBeGreaterThan(0);
    expect(当たり(収録(), "feed").length).toBeGreaterThan(0);
    const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
    for (const 語 of ["データ", "feed"]) {
      expect(源.includes(`"${語}",`), `"${語}" を羣に载せた`).toBe(false);
    }
  });

  /* 畫面の出口に JSON が在る事が正（第 619 回）。第 618 回の斷りは文件の名を言つたが、押せる物は
     README と llms.txt の側にだけ在つた（出口の在りかを言う場所が噓だった過ち – 第 267 回）。
     實測（2026-08-09 生成の実ビルド）– `data.json` は 6.0 MB・会議 700 件・開催回 1,677 件、
     畫面の一覧が読む `catalog.json` は 1.9 MB・品書 868 行。*/
  it("一覧の下の出口に『全データ（JSON）』が在り、案内が同じ語を名指す", () => {
    const ページ = readFileSync(join(builtSite(), "index.html"), "utf8");
    const 当たり = /<a id="jsonLink"[^>]*href="data\.json"[^>]*>([\s\S]*?)<\/a\s*>/.exec(ページ);
    expect(当たり, "JSON の出口が畫面に無い").toBeTruthy();
    const 語 = 当たり![1].trim();
    expect(語, "出口の名前が変わった").toBe("全データ（JSON）");
    /* 案内は畫面に在る語を名指す（ボタン名を勝手に書き換へん – 第 321 回と同じ決まり）。*/
    for (const 文 of ["json", "この一覧をJSONでもらえる"]) {
      const 注 = String(Recommender.uiWordNoteJa(文) || "");
      expect(注.includes(語), `"${文}": 案内が畫面の語を名指していない`).toBe(true);
    }
    /* 押す前に範囲と重さを知る（第 289 回）。*/
    const 説明 = /<a id="jsonLink"[^>]*title="([^"]*)"/.exec(ページ);
    expect(説明, "出口の説明が無い").toBeTruthy();
    expect(説明![1]).toContain("大きめ");
    expect(説明![1]).toContain("CSV");
    /* 紙に押せない導線を刷らん（印刷の目 – 第 354 回と同じ決まり）。*/
    const i = ページ.indexOf("@media print");
    expect(ページ.slice(i, i + 2400), "印刷時に #jsonLink を消さない").toContain("#jsonLink,");
    /* 物を足したらてびきも直す（第 267 回 – 「出口の在りかを言う場所が噓だった」の再発防ぎ）。*/
    expect(ページ.includes("「全データ（JSON）」のリンク"), "てびきが出口を書いていない").toBe(
      true,
    );
    expect(ページ.includes("<dt>JSON</dt>"), "てびきに JSON の項目が無い").toBe(true);
    /* JavaScript が動かん人にも同じ口を – noscript の一覧に JSON が在る（第 619 回）。*/
    const 落とし穴 = /<noscript>([\s\S]*?)<\/noscript>/.exec(ページ);
    expect(落とし穴, "案内ブロックが無い").toBeTruthy();
    expect(
      /href="data\.json"/.test(落とし穴![1]),
      "JavaScript を使わない人には JSON の口が無い",
    ).toBe(true);
    /* 繋ぎ先は實在する配付物（README と llms.txt が載せる物と同じ）。*/
    expect(
      readFileSync(join(builtSite(), "data.json"), "utf8").length,
      "data.json が空",
    ).toBeGreaterThan(100_000);
  });
});
