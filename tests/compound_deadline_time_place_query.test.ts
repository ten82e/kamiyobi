/* 第 479 回 – 締切の名と其の時・処所の名を繋げて打つ形（`締切時刻` `会議時刻` `提出時刻`）
 *
 * 実測（2026-11-08 – 実ビルドの品書 868 行・固定時刻 2026-08-09T00:00:00Z）で、繋げた側は 0 件、
 * 同じ二語を空格で打つと行が出た – `締切時刻` **0 件** / `締切 時刻` 180 件・`会議時刻` **0 件** /
 * 184 件・`提出時刻` **0 件** / 148 件・`論文時刻` **0 件** / 148 件・`投稿時刻` **0 件** / 148 件・
 * `発表時刻` **0 件** / 11 件・`申込時刻` **0 件** / 11 件・`ワークショップ時刻` 4 件 → 21 件・
 * `締切料` **0 件** / 2 件・`会議料` **0 件** / 2 件。空格の位置だけで 0 件に別れる打ち方を
 * 残さない（第 468 回） – 其の方が既に二語で解ける形に割るだけで、新しい語の決まりは作らない
 * （第 453 回）。
 * 同じ目を広げると此のサイトの別決まりと衝突する事を、実測で確かめて列を絞つた – 『日』『〆』『金』
 * を後に载せた版では `締切日` 443 件・`会議日` 435 件（検査用ビルド）になつて九本の検査が落ちた
 * （『表その物を指す語は寄せず、0 件の訳と打ち直し方を件数欄に書く』決まり – 第 245 回・第 362 回）。
 * 同じく『締切』『発表』を後に载せた版では `延長締切`・`早期締切`・`ポスター発表`・`審査結果` を割つて
 * 十本が落ちた（締切種別と種別の語を其の語として受ける決まり – 第 366 回・第 470 回・第 471 回）。
 * 其の訳を代码の注に書き、其れ等を割らぬ事を下の検査で張る。*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
function 品書(): string[] {
  return (
    Recommender.candidateRows(
      JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")) as unknown as never,
    ) as unknown as Array<{ hay: string }>
  ).map((行) => String(行.hay));
}
const 全 = 品書();
function 列(文: string) {
  return new Set(全.filter((行) => Recommender.searchMatcher(文, 基準)(行) === true));
}
function 案内(文: string) {
  return Recommender.relativeDayNotes(文, 基準).join("|");
}

describe("其の時・処所の名を繋げて打つ形が空格で打つ人と同じ行に出る（第 479 回）", () => {
  it("八の対が空格で打つ形と一字も違わない行に出る（実測 – 前は繋げた側が 0 件だつた）", () => {
    for (const [繋, 離] of [
      ["締切時刻", "締切 時刻"],
      ["会議時刻", "会議 時刻"],
      ["提出時刻", "提出 時刻"],
      ["論文時刻", "論文 時刻"],
      ["投稿時刻", "投稿 時刻"],
      ["発表時刻", "発表 時刻"],
      ["申込時刻", "申込 時刻"],
      ["ワークショップ時刻", "ワークショップ 時刻"],
    ] as Array<[string, string]>) {
      expect([繋, 列(繋).size]).toEqual([繋, 列(離).size]);
      expect([繋, 列(繋).size > 0]).toEqual([繋, true]);
    }
  });
  it("行数の実測（固定ハーネスの品書 435 行）", () => {
    expect(列("締切時刻").size).toBe(181);
    expect(列("会議時刻").size).toBe(185);
    expect(列("提出時刻").size).toBe(148);
    expect(列("論文時刻").size).toBe(148);
    expect(列("発表時刻").size).toBe(11);
    expect(列("申込時刻").size).toBe(11);
    expect(列("通知時刻").size).toBe(4);
    expect(列("ワークショップ時刻").size).toBe(21);
  });
  it("その他の語を継いだ形も同じに割れる", () => {
    expect(列("ml 締切時刻 締切").size).toBe(9);
    expect(列("締切時刻 の 論文").size).toBe(148);
  });
  it("割つた形に件の数欄が余計な事を書かない（其の方の案内は増へない）", () => {
    for (const 文 of ["締切時刻", "会議時刻", "提出時刻", "発表時刻"]) {
      expect(案内(文), `「${文}」に案内が並んだ`).toBe("");
    }
    /* 表その物を指す語の打ち直し方の案内は、其の形が 0 件の侭な時に其の一文だけ出る（第 245 回 –
     * 此の回で目を広げた版では其の文と「分けて探しています」の文が二つ並んだ – 第 331 回）。*/
    const 導き = Recommender.querySynonymNotes("セキュリティ 締切日");
    expect(導き.length, "「セキュリティ 締切日」の案内が二つ並んだ（第 331 回）").toBe(1);
    expect(導き.join("")).toContain("締切日");
  });
});

describe("其の方の決まりで既に扱はれて居る語は割らない（第 245 回・第 366 回・第 470 回）", () => {
  it("種別・締切の種類・表その物の語は詰め形の侭で行を出す", () => {
    for (const [語, 件] of [
      ["ポスター発表", 5],
      ["参加登録", 26],
      ["全文締切", 289],
      ["延長締切", 16],
      ["早期締切", 1],
      ["結果発表", 59],
      ["最終原稿", 36],
      ["デモ発表", 1],
      ["登録期限", 1],
    ] as Array<[string, number]>) {
      expect([語, 列(語).size]).toEqual([語, 件]);
    }
    /* 表その物を指す語は割らずに案内で打ち直し方を教える決まり（0 件の侭）。*/
    expect(列("締切日").size).toBe(0);
    expect(列("会議日").size).toBe(0);
    expect(列("査読結果").size).toBe(0);
  });
  it("群 6 284 語で減つた物が 0 語（実測 – 139 語が 0 件以外になつた）", () => {
    /* 頭 29 種 × 後 12 種 × 詰め ⇔ 離し × 後続語 + 対照の群を前回のビルドと較べた実測の内訳は
     * SPEC §7 第 479 回に書いた。此處では其の群から抜いた語の行数を張り、目を広げ直した時に
     * 減りが現れたら落るやうにする。*/
    for (const [語, 件] of [
      ["査読結果", 0],
      ["審査結果", 0],
      ["締切料", 0],
      ["会議料", 0],
      ["締切時間", 0],
      ["締切場所", 0],
      ["登録場所", 0],
      ["査読場所", 0],
      ["会議", 0],
    ] as Array<[string, number]>) {
      expect([語, 列(語).size]).toEqual([語, 件]);
    }
    expect(列("締切").size).toBe(375);
  });
  it("第 470 回〜第 478 回の実測は此の回で変へて居ない", () => {
    expect(列("週 末").size).toBe(146);
    expect(列("明日以降").size).toBe(423);
    expect(列("来月 終わり").size).toBe(178);
    expect(列("1 年後から").size).toBe(1);
    expect(列("来 上旬").size).toBe(68);
    expect(案内("来 上旬")).toContain("来月 上旬 = 2026年9月1日(火)");
    expect(列("ml から").size).toBe(0);
    expect(列("来週 から").size).toBe(423);
    expect(列("来月 下旬 まで").size).toBe(276);
  });
});

describe("ビルド成果物に目が在る事（第 466 回 – 成果物だけの検査でも捕まへる）", () => {
  const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
  it("語の連なりを割る目が其の時・処所の列で現れる", () => {
    expect(物.match(/語の連なりJa/g)?.length).toBe(2);
    expect(物).toContain("(?:時刻|時間|場所|料)");
    /* 後の列に『日』『〆』『金』『締切』『発表』を载せて居ない事（其の方の決まりと衝突する為）。*/
    expect(物).not.toContain("|金|〆)/g");
  });
  it("前の七回の目の字面を壊して居ない", () => {
    expect(物.match(/複合語の切れ目/g)?.length).toBe(2);
    expect(物.match(/離した幅の区切りJa/g)?.length).toBe(2);
    expect(物.match(/繋がれた幅の尾Ja/g)?.length).toBe(2);
    expect(物.match(/単位に付いた助字/g)?.length).toBe(2);
    expect(物.match(/月の付いた塊/g)?.length).toBe(3);
  });
});
