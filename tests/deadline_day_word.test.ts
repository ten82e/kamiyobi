/**
 * 画面に出る語に「日」が付きただけの形・和語の言い方の検査（SPEC §4・§7・第 331 回）。
 * 実測（2026-09-28 – 2026-08-09 生成の実ビルドの品書 872 行・固定時刻 2026-08-09T00:00:00Z）:
 * `提出日` **0 行** / `提出` 461 行、`投稿日` **0 行** / `投稿` 461 行、
 * `通知日` **0 行** / `通知` 129 行、`採択日` **0 行** / `採択` 129 行、
 * `登録日` **0 行** / `登録` 7 行、`会期日` **0 行** / `会期` 185 行、
 * `参加登録` **0 行**・`早期登録` **0 行**・`リアルタイムシステム` **0 行** / real-time 3 行。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

function 行集合(語: string): Set<string> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  const rows = Recommender.candidateRows(catalog) as unknown as Array<{
    key?: string;
    hay: string;
  }>;
  const matches = Recommender.searchMatcher(語, 基準);
  return new Set(
    rows
      .filter((row) => matches(String(row.hay)) === true)
      .map((row) => String(row.key ?? row.hay)),
  );
}

function 差分(a: Set<string>, b: Set<string>): number {
  return [...a].filter((k) => !b.has(k)).length + [...b].filter((k) => !a.has(k)).length;
}

describe("「日」付き・和語の打ち方", () => {
  it("画面に出る語に「日」が付きただけの形は、素の語と同じ行に出会う（品書）", () => {
    [
      ["提出日", "提出"],
      ["投稿日", "投稿"],
      ["通知日", "通知"],
      ["採択日", "採択"],
      ["登録日", "登録"],
      ["会期日", "会期"],
    ].forEach(([打ち方, 素の語]) => {
      const 基準の行 = 行集合(素の語);
      expect(基準の行.size, `"${素の語}" が 0 行の前提が崩れた`).toBeGreaterThan(0);
      expect(差分(行集合(打ち方), 基準の行), `"${打ち方}" が違う行を出した`).toBe(0);
    });
  });

  it("登録の言い分け（参加登録・早期登録）は収録の語に届く", () => {
    const 参加 = 行集合("参加登録");
    expect(参加.size).toBeGreaterThan(0);
    expect(差分(参加, 行集合("registration")), "`参加登録` が原文の語に届いていない").toBe(0);
    const 早期 = 行集合("早期登録");
    expect(差分(早期, 行集合("登録締切")), "`早期登録` の幅が違う").toBe(0);
    /* 寄せ先に原文の "early registration" は足さない – 実ビルドの品書 872 行では其の語を
     * 持つ行が 1 行あり、其れは `登録締切`（7 行）に既に含まれて行数が変わらなかった
     * （第 331 回の実測）。行を増えない語を表に置かない。此処の検査は検査用の品書（435 行）
     * で幅の一致だけを見る – 実ビルドの品書とは行数の基準が違うので、混めない。 */
  });

  it("原文にしか語の無い和語も当たる（長音の違いも受ける）", () => {
    expect(差分(行集合("リアルタイムシステム"), 行集合("real-time"))).toBe(0);
    expect(行集合("リアルタイムシステム").size).toBeGreaterThan(0);
    ["プロシーディング", "プロシーディングス", "プロシーディングズ"].forEach((語) => {
      expect(差分(行集合(語), 行集合("proceedings")), `"${語}" が proceedings に届かない`).toBe(0);
    });
  });

  it("件数欄は寄せた先を一通だけ書く（表その物の語と並んだ時も二つ並べない）", () => {
    [
      ["提出日", "種別「論文締切」"],
      ["投稿日", "種別「論文締切」"],
      ["通知日", "種別「採否通知」"],
      ["採択日", "種別「採否通知」"],
      ["登録日", "種別「登録締切」"],
      ["会期日", "列「会期」"],
      ["参加登録", "種別「登録締切」"],
      ["リアルタイムシステム", "原文の real-time という語"],
    ].forEach(([語, 寄せ先]) => {
      const 案内 = Recommender.querySynonymNotes(語);
      expect(案内.length, `"${語}" の案内が二つ並んだ`).toBe(1);
      expect(案内[0], `"${語}" の案内に寄せ先が無い`).toContain(寄せ先);
    });
    /* `WHOLE_TABLE_QUERY_JA` の語（第 245 回）と同じ案内を二重に立てない。 */
    const 複合 = Recommender.querySynonymNotes("セキュリティ 締切日");
    expect(複合.length, "「締切日」について二つの文が並んだ").toBe(1);
    expect(複合[0]).toContain("全行にあてはまる語");
    expect(複合.join(""), "同じ語について二通り言った").not.toContain("で探しています\n");
  });

  it("表その物を指す語は寄せない – 「絞り込めない」と言う案内に任せる（第 245 回）", () => {
    ["締切日", "〆切日", "締め切り日", "提出期限", "しめきり"].forEach((語) => {
      expect(Recommender.querySynonymNotes(語).join(""), `"${語}" を寄せてしまった`).toBe("");
      expect(Recommender.wholeTableQueryWordJa(語), `"${語}" を表その物の語から外した`).not.toBe(
        "",
      );
      expect(行集合(語).size, `"${語}" が行を絞った`).toBe(0);
    });
  });

  it("収録に語その物が無い言い方は寄せない（0 件の案内に任せる）", () => {
    ["オンサイト", "対面", "招待講演", "光通信", "サーバレス", "会議日"].forEach((語) => {
      expect(行集合(語).size, `"${語}" が行を絞った`).toBe(0);
      expect(Recommender.querySynonymNotes(語).join(""), `"${語}" の案内を立てた`).toBe("");
    });
    /* 分野の英語名へ広げる表は、今年の収録に語が無くても置いて良い（来年の会議で届く）が、
     * その行が 0 件である事は調べておく（第 331 回の実測: `バイオインフォマティクス`
     * `推薦システム` は案内が立つのに品書では 0 行だった）。 */
    ["バイオインフォマティクス", "推薦システム"].forEach((語) => {
      expect(行集合(語).size, `"${語}" が今年の品書で行を絞った`).toBe(0);
    });
  });

  it("表その物を指す語と言い換え表が噛み合わない（同じ語に二つの文を並べない）", () => {
    /* 第 331 回で `セキュリティ 締切日` の案内が二つ並んだ（「絞り込めません」と「探しています」）。
     * 直しかたは二通り有ったが、ガード節を足すと表が噛み合っていない限り検査されず、
     * 改ざんでも落ちないことを実測で確かめた（実際に検出出来なかった）。そこでガードは置かず、
     * 二本の表が噛み合わない事をここで守る。 */
    [
      "締め切り",
      "締切り",
      "しめきり",
      "締切日",
      "〆切日",
      "締め切り日",
      "提出期限",
      "会議",
      "大会",
      "カンファレンス",
      "一覧",
      "一覧表",
      "締切一覧",
      "かいぎ",
      "たいかい",
    ].forEach((語) => {
      expect(
        Recommender.wholeTableQueryWordJa(語),
        `"${語}" が表その物の語では無くなった`,
      ).not.toBe("");
      expect(Recommender.querySynonymNotes(語).join(""), `"${語}" が言い換え表にも入った`).toBe("");
    });
  });

  it("組み立てた画面に条目と重複防止が残っている（ハーネスは名指し – 第 329 回）", () => {
    const rec = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    ['"提出日"', '"早期登録"', '"会期日"', '"プロシーディングス"', "WHOLE_TABLE_QUERY_JA"].forEach(
      (断片) => {
        expect(rec.includes(断片), `組み立てた画面から ${断片} が消えた`).toBe(true);
      },
    );
  });
});
