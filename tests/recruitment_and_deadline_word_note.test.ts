/**
 * 募集・応募の言い方と、締切を指す `期限`（第 685 回）。
 *
 * 実測（2026-10-06 – 収録の全体 5,069 行・速く開く品書 870 行・固定時刻 2026-10-06T00:00:00Z。
 * 検査が使う固定入力 – 品書 3,250 行・2026-08-09T00:00:00Z でも同じ）で、下の語は**0 行で
 * 案内も無し**だった – `募集` `募集中` `応募` `公募` `発表募集` `参加募集` `参加者募集`
 * `論文募集中` `応募受付` `登録受付` `参加受付` `申込受付` `発表申込受付` `参加申込受付`
 * `公募情報` `募集開始` `受付開始` `応募開始` と `期限` `締切期限`。
 * 同じ意味の `論文募集`（3,156 行）・`受付中`（既に群が受ける）・`提出期限`（第 331 回）は
 * 通っていたので、語尾が一語に続いただけの形が壁になっていた（第 684 回と同じ形）。
 *
 * 直しかた – 募集の群を一つ置き（`site/recommender.ts` の `UI_WORD_GROUPS_JA`）、締切らしい
 * 語尾の印を立てて `応募締切` `募集期限` `募集の締切` `募集まで` も同じ群で受ける。`期限` の家族
 * （`期限` `締切期限` `応募期限` `募集期限` `投稿期限` `申込期限`）も同じ群へ入れる –
 * **表その物を指す語の表（`WHOLE_TABLE_QUERY_JA`）へは入れない**。此方へ入れると語尾の割り
 * （第 514 回）が働き、`システム期限` が `システム` の行（104 行）を出す – 第 362 回が
 * 「割ると廣がる語は割らん」と決めて第 517 回が語尾の表に `期限` を載せなんだのは此の理由で、
 * 其の見張り（`tests/glued_kind_deadline_tail_query.test.ts`）は其の侭通す。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";

const 基準 = Date.parse("2026-08-09T00:00:00Z");

/** 速く開く品書（畫面が既定で讀む行）– 案内は此の行に對して出る。 */
function 品書(): Array<{ hay: string }> {
  const catalog = JSON.parse(
    readFileSync(join(builtSite(), "catalog.json"), "utf8"),
  ) as unknown as never;
  return Recommender.candidateRows(catalog) as unknown as Array<{ hay: string }>;
}

/** 收錄の全體（「收錄の全體を讀み込む」で讀む行）。 */
function 全體(): Array<{ hay: string }> {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(new URL("../data/snapshot.json", import.meta.url), "utf8")),
  ) as unknown as Array<{ hay: string }>;
}

function 行列表(語: string, 行々: Array<{ hay: string }> = 品書()): Array<{ hay: string }> {
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(語, 基準), 基準);
  return 行々.filter((行) => 照合(String(行.hay)) === true);
}

const 件 = (語: string, 行々?: Array<{ hay: string }>): number => 行列表(語, 行々).length;
const 案内 = (語: string): string => String(Recommender.uiWordNoteJa(語, false) || "");
const 讀み上げ = (語: string): string => String(Recommender.uiWordLiveNoteJa(語) || "");
const 全行の案内 = (語: string): string => String(Recommender.wholeTableQueryNoteJa(語) || "");

/** 群の語（正本から讀む – 書き寫すと正本とズレる）。 */
const 募集の群の語 = [
  "募集",
  "募集中",
  "応募",
  "公募",
  "発表募集",
  "参加募集",
  "参加者募集",
  "論文募集中",
  "応募受付",
  "登録受付",
  "参加受付",
  "申込受付",
  "発表申込受付",
  "参加申込受付",
  "公募情報",
  "募集開始",
  "受付開始",
  "応募開始",
  /* 締切その物を指す語（第 685 回）。全行の語（`WHOLE_TABLE_QUERY_JA`）へは入れない –
   * 入れると語尾の割り（第 514 回）が働いて `システム期限` が `システム` の行を出す。 */
  "期限",
  "締切期限",
  "応募期限",
  "募集期限",
  "投稿期限",
  "申込期限",
];

describe("募集と応募の言い方（第 685 回）", () => {
  it("品書と收錄の全體の兩方で 0 行（案内の出る打ち方である事を先に確かめる）", () => {
    const 品 = 品書();
    const 全 = 全體();
    for (const 語 of 募集の群の語) {
      expect(件(語, 品), `品書で行が出た: ${語}`).toBe(0);
      expect(件(語, 全), `收錄の全體で行が出た: ${語}`).toBe(0);
    }
  });

  it("默らず、種別の語と一覽の見方を言う", () => {
    for (const 語 of 募集の群の語) {
      const 文 = 案内(語);
      expect(文, `默つた: ${語}`).not.toBe("");
      expect(文, `打たれた語を書き返す: ${語}`).toContain(`「${語}」`);
      expect(文, `見方の列を名指す: ${語}`).toContain("締切まで");
      expect(文, `過ぎた物の切替を名指す: ${語}`).toContain("過去の締切も表示");
      expect(文, `檢索語を消す道を書く: ${語}`).toContain("検索語を消す");
      for (const 種 of ["論文締切", "概要締切", "発表申込締切"]) {
        expect(文, `種別の語が書かれて居ん: ${語} → ${種}`).toContain(種);
      }
      /* 測つて居ない數を書かない（第 535 回）。 */
      expect(/[0-9０-９]/.test(文), `數を發して居る: ${語} → ${文}`).toBe(false);
    }
  });

  it("案内が名指す種別の語は、其の方で行が出る（通らん語へ送らん – 第 337 回）", () => {
    for (const 種 of ["論文締切", "概要締切", "発表申込締切"]) {
      expect(件(種), `名指した語が 0 行: ${種}`).toBeGreaterThan(0);
    }
  });

  it("締切らしい語尾を續けた形も同じ群で受ける", () => {
    const 本 = 案内("募集");
    for (const 文 of ["応募締切", "募集の締切", "応募の締切", "募集まで"]) {
      expect(件(文), `行が出た: ${文}`).toBe(0);
      expect(案内(文), `同じ群で受けて居ん: ${文}`).toContain(
        "この表が並べているのは催し物の募集の締切",
      );
      expect(案内(文).replace(/「[^」]*」/, "「…」"), `斷りが群の物と違ふ: ${文}`).toBe(
        本.replace(/「[^」]*」/, "「…」"),
      );
    }
  });

  it("讀み上げは短く、斷りは其れより長い（聲だけ惡くならん – 第 651 回）", () => {
    for (const 語 of 募集の群の語) {
      const 聲 = 讀み上げ(語);
      expect(聲, `讀み上げが無い: ${語}`).not.toBe("");
      expect([...聲].length, `讀み上げが六十を越える: ${語}`).toBeLessThanOrEqual(60);
      expect([...案内(語)].length, `斷りが讀み上げより短い: ${語}`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("行が出る語に斷りを付けない（其の方で絞れる – 第 337 回）", () => {
    for (const 語 of ["論文募集", "ポスター募集", "投稿締切", "申込締切"]) {
      expect(件(語), `前提が崩れた（0 行）: ${語}`).toBeGreaterThan(0);
      expect(案内(語), `行が出る語に斷りを付けた: ${語}`).toBe("");
    }
    /* `受付中` は第 629 回の群が受ける – 此の群が先取りせん（一語一羣）。 */
    expect(案内("受付中"), "受付中の斷りを奪つた").toContain("常時受付");
  });
});

describe("締切を指す `期限`（第 685 回）", () => {
  it("群の案内で受ける – 語尾の割りで行を廣げない（第 362 回の見張りを崩さん）", () => {
    for (const 語 of ["期限", "締切期限", "応募期限", "募集期限", "投稿期限", "申込期限"]) {
      expect(案内(語), `默つた: ${語}`).toContain("この表が並べているのは催し物の募集の締切");
      expect(全行の案内(語), `全行の語の案内が立つた（割りが働く）: ${語}`).toBe("");
    }
    /* 割ると行が廣がる形は 0 行の侭（第 362 回の見張り – `システム期限` 0 行 → `システム` の行に
     * 成つてはならん。第 517 回が語尾の表に `期限` を載せなんだ理由が此れ）。此の群の斷りも
     * 立たん（`チュートリアル期限` は第 517 回の群が受ける – 一語一羣）。 */
    for (const 語 of ["システム期限", "チュートリアル期限", "学生期限"]) {
      expect(件(語), `割つて行を出した: ${語}`).toBe(0);
      expect(案内(語), `此の群の斷りが立つた: ${語}`).not.toContain(
        "この表が並べているのは催し物の募集の締切",
      );
    }
  });

  it("同じ意味の書き方（`提出期限` `締切日`）の扱ひを變へて居ない", () => {
    for (const 語 of ["提出期限", "締切日", "〆切日", "しめきり"]) {
      expect(件(語), `行が出る樣に成つた: ${語}`).toBe(0);
      expect(全行の案内(語), `案内が消えた: ${語}`).toContain("この表の全行にあてはまる語");
    }
  });
});

describe("語列表その物の棚卸し（第 685 回）", () => {
  it("募集の群の語は、正本の群に一度ずつ載つて居る（一語一羣 – 第 512 回）", () => {
    const 物 = readFileSync(join(builtSite(), "recommender.js"), "utf8");
    const 始 = 物.indexOf("const UI_WORD_GROUPS_JA = [");
    expect(始, "群の一覧が見つからない").toBeGreaterThan(0);
    const 後 = 物.slice(始);
    const 終 = 後.match(/\n\s*\];/);
    const 本 = 後.slice(0, 終 ? 終.index : 後.length);
    for (const 語 of 募集の群の語) {
      const 數 = 本.split(`"${語}",`).length - 1;
      expect(數, `群の語列表に ${數} 回（一度だけ載せる）: ${語}`).toBe(1);
    }
    /* 群の斷りが成果物に入つて居る（語だけ載せて斷りを忘れる形を防ぐ）。 */
    expect(本, "募集の群の斷りが無い").toContain("この表が並べているのは催し物の募集の締切その物");
    /* `期限` は全行の語の列表へは**入れない**（入れると第 514 回の割りが働く – 上の見張り）。 */
    const 全行 = 物.match(/const WHOLE_TABLE_QUERY_JA[\s\S]*?\];/)?.[0] ?? "";
    expect(全行, "`期限` を全行の語に入れた（割りが働く）").not.toContain('"期限",');
    expect(全行, "`締切期限` を全行の語に入れた").not.toContain('"締切期限",');
  });
});
