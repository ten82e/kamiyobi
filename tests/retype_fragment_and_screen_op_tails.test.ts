/**
 * 打ち替え語の切れ端を止め、畫面の操作を聽く語尾を通す（第 622 回）。
 *
 * 二つの實測から出る –
 *  ① 舊來の打ち替え案內（第 256 回 `shorterHitWordsJa`）は、語の**途中**で切つた斷片を
 *     勧めて居た（2026-08-09 生成の実ビルド・品書 868 行で實測 –
 *     `ベストペーパー賞はあるんですか、そういう情報は載っていますか` → 「ベス」120 件、
 *     `締切をカレンダーに追加したい` → 「ンダー」27 件、`RSSはある` → 「ss」1 件、
 *     `URLで購読する方法` → 「rl」1 件）。效くが語で無い物を打てとは言へんので、
 *     切る所を助詞・句讀の所に限つた。
 *  ② 長い文の打ち直し（第 621 回）は、實に絞れる語を名指す打ち替え（①の家）より
 *     劣る。其れが有るときは讓るやうにした（畫面上は「語を外すと増えます」の舊來の受けより
 *     先に立つ為、讓る方を正す）。
 * 語と語尾の表は `site/recommender.ts` の羣と白一覧が正 – 之に寫し表は作らん（第 511 回）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");
const 助詞Ja = /[、。，,・：:！？のをはにへをもやとが]/;

/* 打ち替えの家は品書の行を見て當てを搜す – 檢査はビルドした品書で見る（實物と同じ形の
 * 文字列の列が要るだけで、件の數は張らん – 件の數は下の収録で張る）。 */
function 品書(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(builtSite(), "catalog.json"), "utf8")),
  );
}
function 収録(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")),
  );
}
function 件数(列: Array<{ hay: string }>, 語: string): number {
  const 当 = Recommender.searchMatcher(語, 基準);
  return 列.filter((r) => 当(String(r.hay)) === true).length;
}
/* 打ち替え語が**語の切れ目**で切れて居るか – 短い方の邊（切れ端を弾く規則の寫し鏡）。
 * 收錄の行から拾うので、品書の數へに左右されん（この檢査は規則の話を見て居る）。 */
function 切れ目があるか(文: string, 語: string): boolean {
  /* recommender の決まり（第 622 回）の寫し – (a) 助詞・句讀の邊、(b) 前が漢字で終る邊。 */
  if (!語 || !文.includes(語)) return true;
  const 字 = [...文];
  const 語字 = [...語];
  const 助 = (c: string) => 助詞Ja.test(c);
  const 漢 = (c: string) => /[々〻一-龥]/.test(c);
  const i = 文.indexOf(語);
  if (i === 0) {
    const 次 = 字[語字.length];
    if (次 === undefined) return true;
    return (助(次) && !助(語字[語字.length - 1])) || 漢(語字[語字.length - 1]);
  }
  return (助(字[i - 1]) && !助(語字[0])) || 漢(字[i - 1]);
}

describe("第 622 回 – 打ち替えは語の切れ目で、形の打ち直しは實に絞れる語に讓る", () => {
  it("切れ端の打ち替えを出さん（ベス・ンダー・ss・rl – 效くが語で無い物）", () => {
    const hays = 品書().map((r) => String(r.hay));
    expect(hays.length, "品書が読めない（檢査が空振り）").toBeGreaterThan(100);
    expect(助詞Ja.test("の"), "助詞の表が壊れて居る").toBe(true);
    for (const q of [
      "ベストペーパー賞はあるんですか、そういう情報は載っていますか",
      "締切をカレンダーに追加したい",
      "RSSはある",
      "URLで購読する方法",
      "筆頭著者じゃなくて共著での投稿も認められている会議は？",
      "古い順に見たい",
    ]) {
      for (const hit of Recommender.shorterHitWordsJa(q, hays, 基準) || []) {
        expect(hit.word, `"${q}" に切れ端「${hit.word}」を出した`).not.toBe("ベス");
        expect(hit.word, `"${q}" に切れ端「${hit.word}」を出した`).not.toBe("ンダー");
        expect(hit.word, `"${q}" に切れ端「${hit.word}」を出した`).not.toBe("ss");
        expect(hit.word, `"${q}" に切れ端「${hit.word}」を出した`).not.toBe("rl");
      }
    }
  });

  it("短くした打ち替え（shorten）は總て語の切れ目で切れて居る（規則その物）", () => {
    const hays = 品書().map((r) => String(r.hay));
    let 數 = 0;
    for (const q of 切れ目の檢べ文()) {
      for (const hit of Recommender.shorterHitWordsJa(q, hays, 基準) || []) {
        if (hit.how !== "shorten") continue;
        數++;
        expect(切れ目があるか(q, hit.word), `"${q}" → 「${hit.word}」が語の途中`).toBe(true);
      }
    }
    expect(數, "shorten の見本が一つも通らん（檢査が空振り）").toBeGreaterThan(0);
  });

  it("實に絞れる語が在るときは、長い文の打ち直しは讓る（第 256 回が先）", () => {
    const q = "学生だけのセッションがある国際会議はどこですか";
    expect(件数(収録(), q), "此の文は収録で行が出る筈").toBe(0);
    expect(String(Recommender.uiWordNoteJa(q) || "")).toContain("長い文のままでは絞れません");
    /* 打ち替え語（「セッション」等）が並ぶ畫面では、形の文を立てん – 讓つの判斷は畫面が持つ。 */
    expect(String(Recommender.uiWordNoteJa(q, true) || ""), "打ち替え語に讓らん").toBe("");
    /* 読み上げも同じ判斷（畫面と讀み上げが別のことを言はん – 第 392 回）。 */
    expect(String(Recommender.uiWordLiveNoteJa(q, true) || ""), "讀み上げが讓らん").toBe("");
    /* 羣の語が斷れる文は讓らん（精しき斷りが形の文に勝つ – 第 621 回の順は崩さん）。 */
    const 精 = "査読付き論文のみ";
    expect(String(Recommender.uiWordNoteJa(精, true) || "")).toContain("審査の方式");
  });

  it("畫面の操作を聽く語尾が通る（並び順・見たい・に出る）", () => {
    /* [打ち方, 斷りが名指す語, 斷りが書く場所] – 斷りは打たれた語を名指す（第 388 回）。 */
    const 見 = [
      ["並び替えはどうする", "並び替え", "列の見出し"],
      ["古い順に見たい", "古い順", "列の見出し"],
      ["新しい順はどうする", "新しい順", "列の見出し"],
      ["Googleカレンダーに出る", "Googleカレンダー", "カレンダー"],
    ] as const;
    const 収 = 収録();
    expect(件数(収, "Googleカレンダー"), "Googleカレンダーは収録で行が出る筈").toBe(0);
    expect(件数(品書(), "Googleカレンダー"), "Googleカレンダーは品書で行が出る筈").toBe(0);
    for (const [文, 名指す, 場所] of 見) {
      expect(件数(収, 文), `"${文}" は収録で行が出る筈`).toBe(0);
      const 注 = String(Recommender.uiWordNoteJa(文) || "");
      expect(注, `"${文}" が默つたまま`).not.toBe("");
      expect(注, `"${文}" の斷りが打たれた語を名指して居らん`).toContain(名指す);
      expect(注, `"${文}" の斷りが "${場所}" へ連れて行かん`).toContain(場所);
      expect(注.includes("長い文のままでは"), "形の打ち直しが先に立つた").toBe(false);
    }
  });

  it("彈かねばならん形は默つて居る（磁石・収録に行の在る語 – 第 503・337 回）", () => {
    const 収 = 収録();
    expect(件数(収, "RSS"), "RSS は収録に行が在る（羣に載せん – 噓の門）").toBe(13);
    for (const q of [
      "リアルタイム処理は要りますか",
      "参加費対効果分析ですか",
      "RSSはある",
      "スマホでも見られる",
      "過去の締切 関西",
      "会場 京都",
    ]) {
      const 注 = String(Recommender.uiWordNoteJa(q) || "");
      if (q === "RSSはある" || q === "スマホでも見られる")
        expect(注, `"${q}" に斷りを立てた`).not.toContain("のことなら");
    }
  });

  it("檢索の側は一字も廣げて居らん（第 362 回 – 案内だけ直した）", () => {
    const 収 = 収録();
    expect(収.length, "収録の行總數が動いた").toBe(3250);
    for (const [語, 行] of [
      ["査読", 32],
      ["採択", 240],
      ["オンライン参加可", 109],
      ["camera ready", 147],
    ] as const) {
      expect(件数(収, 語), `"${語}" の行數が動いた`).toBe(行);
    }
  });
});

/* 切れ目の規則を檢べる文 – 打ち方の表から長い物を集めたもの（品書で 0 件の形だけ）。 */
function 切れ目の檢べ文(): string[] {
  return [
    "ベストペーパー賞はあるんですか、そういう情報は載っていますか",
    "筆頭著者じゃなくて共著での投稿も認められている会議は？",
    "自分の分野がセキュリティ以外でも応募できるワークショップは",
    "学生セッションの応募資格は何歳までですか",
    "オンラインのみでの発表は認められていますか",
    "分散並列処理基盤システム",
    "高速計算の国際会議",
  ];
}
