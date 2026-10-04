/**
 * `HPCチュートリアル` `スパコンセミナー` `ネットワークチュートリアル` – 欧文・片假名の熟語が
 * 打ち替えも出さんで默つて居た壁を（第 665 回）。
 *
 * 搜の侧は漢字の熟語を割る（實測 – `機械学習ワークショップ` は「機械学習」504 件・「ワークショップ」174 件と
 * 打ち替えが出る）が、**欧文と片假名が續いだ形**と**片假名が二つ續いだ形**は割らん（`queryTokenGroups`
 * は `HPCチュートリアル` を一語の侭返す）。打ち替えの家（第 256 回）の邊の決まり（第 622 回）は
 * 「前が漢字で終る邊」と「假名・欧文の語に漢字の後附き」しか見て居ないので、此れ等の邊は語の切れ目と
 * 數へられん – 實測（2026-08-09 生成の実ビルド・品書 3,250 行・同刻）で分野 × 種別の 0 行の打ち方
 * 69 本が打ち替えも讓りも無しだつた。
 *
 * 直し – 打ち替えの家に**字種の邊**を通した。兩侧が三文字以上・同じ字種（欧文・数字のみ / 片假名のみ）で
 * 又ぎ抜き（`ー`）を跨がんと限つた邊だけ – 搜の侧が割れん形でも打ち替えの語は出せるやうにするのが
 * 目的で、搜れる打ち手（行が出る形）は家の門で入らん為、效きは 0 件の人に打ち替えを出す事だけ。
 * 併せて**頭の邊より内側を切らん**決まりを加へた（實測で `バイオインフォマティクスワークショップ` が
 * 「クスワークショップ」2 件と云ふ前の語に食い込む切れ端を出した – 檢査が彈いた例）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");

type Row = { hay: string };
type 換 = { word: string; count: number; how: string; pair?: string };
let 品書: Row[] | null = null;
let 袋: string[] | null = null;
function 收錄(): Row[] {
  if (品書 === null) {
    const data = JSON.parse(readFileSync(queryReferenceSnapshotPath(), "utf8"));
    品書 = Recommender.candidateRows(data) as Row[];
    袋 = 品書.map((行) => String(行.hay));
  }
  return 品書;
}

function 当たり(訪ね: string): number {
  const 目 = Recommender.searchMatcher(Recommender.expandRelativeMonths(訪ね, AT), AT);
  return 收錄().filter((行) => 目(String(行.hay)) === true).length;
}

function 打ち替え(訪ね: string): 換[] {
  收錄();
  return (Recommender.shorterHitWordsJa(訪ね, 袋 as string[], AT) || []) as 換[];
}

const 語々 = (訪ね: string): string[] => 打ち替え(訪ね).map((物) => String(物.word));

/** 讓り – 畫面で 0 件の時に出る導き（打ち替えの chip は app.ts が別に並べる – 第 256 回）。*/
function 讓り(訪ね: string): string {
  return String(
    Recommender.columnQueryNoteJa(訪ね, (語) => 当たり(語) > 0) ||
      Recommender.uiWordNoteJa(訪ね, false) ||
      Recommender.dayRangeNoteJa(訪ね) ||
      Recommender.wholeTableQueryNoteJa(訪ね) ||
      "",
  ).trim();
}

describe("欧文・片假名の熟語の打ち替え", () => {
  it("舊來默つて居た續ぎ方が打ち替えを出す", () => {
    const 载せる與: Array<[string, string[]]> = [
      ["HPCチュートリアル", ["HPC", "チュートリアル"]],
      ["ネットワークチュートリアル", ["ネットワーク", "チュートリアル"]],
      ["スパコンセミナー", ["スパコン"]],
      ["セキュリティワークショップ", []],
      ["バイオインフォマティクスワークショップ", ["バイオインフォマティクス"]],
      ["クラウドコンピューティング学会", ["クラウドコンピューティング"]],
    ];
    for (const [訪ね, 含める] of 载せる與) {
      expect(当たり(訪ね) === 0 || 訪ね === "セキュリティワークショップ", `${訪ね} は搜れる形`);
      const 出 = 語々(訪ね);
      expect(出.length, `${訪ね} の打ち替えが無し（默つた儘）`).toBeGreaterThan(0);
      for (const 語 of 含める) expect(出, `${訪ね} の打ち替えに『${語}』が無い`).toContain(語);
    }
    /* 搜の部分一致に乘つて出た切れ端（第 665 回の事故 – 檢査が彈いた）は還さん。*/
    expect(語々("バイオインフォマティクスワークショップ")).not.toContain("クスワークショップ");
    expect(語々("ネットワークランキング")).not.toContain("ネットワークラン");
    expect(語々("セキュリティコンピューティング")).not.toContain("セキュリティコンピ");
    expect(語々("ネットワーク スケジューリング")).not.toContain("ューティング");
    /* 續ぎ目の無い打ち手は打ち替えを出さん – 一語を兩つに割つた切れ端を劝めん為。*/
    expect(語々("ネットワーク")).toEqual([]);
  });

  it("字種の邊から出た語は皆 搜れて、三文字以上か略語", () => {
    /* 搜の侧が割れん續ぎ方だけ洗ふ – 頭も尾も欧文・数字か片假名で、漢字を含まん形。
     * 此處に現れる打ち替えは第 665 回の家からしか來ん（舊來は 0 件）ので、切れ端の檢査は其の方に掛ける。*/
    const 頭 = [
      "HPC",
      "AI",
      "OS",
      "DB",
      "GPU",
      "CPU",
      "IoT",
      "IPv6",
      "スパコン",
      "ネットワーク",
      "セキュリティ",
      "クラウド",
      "エッジ",
      "暗号化アルゴリズム",
      "シミュレーション",
      "ベンチマーク",
    ];
    const 尾 = [
      "チュートリアル",
      "セミナー",
      "ワークショップ",
      "ソナー",
      "トラック",
      "シンポジウム",
      "ランキング",
      "コンピューティング",
      "プログラミング",
      "スケジューリング",
    ];
    const 坏 = [];
    let 見 = 0;
    let 舊來默り = 0;
    const 默り内訳: string[] = [];
    for (const a of 頭)
      for (const b of 尾) {
        const 訪ね = a + b;
        if (当たり(訪ね) > 0) continue;
        /* 搜の侧が既に割れる形（同義語の表で解ける尾など）は此の家の外 – 飛ばす。*/
        if (Recommender.queryTokenGroups(訪ね, AT).length !== 1) continue;
        見++;
        const 出 = 打ち替え(訪ね);
        /* 打ち替えの chip が無くても讓りが應へれば畫面は默らん（第 646・647 回）。*/
        if (出.length || 讓り(訪ね)) continue;
        舊來默り++;
        默り内訳.push(訪ね);
        /* 默る理屈は殘つて居ねばならん – どちらかの側がそもそも搜れんか（`ソナー` `トラック` のやうに
         * 收錄に一度も出ん語）、または略語の門（二字は打ち詰め大文字だけ）で止まつた形だけ。*/
        const 邊 = 訪ね.length - b.length;
        const 前側 = 当たり(a),
          後側 = 当たり(b);
        const 二字 = a.length < 3 && !/^[A-Z]{2}$/.test(a);
        /* 邊が語の家の門 – 兩侧とも三行以上に當たる必要が在るので、片方が 1・2 行の語
         * （實測 `OS` 2 行 `ベンチマーク` 1 行）も默る。默りには理屈が在る事だけ張る。*/
        const 細い = 前側 < 3 || 後側 < 3;
        if (!(前側 === 0 || 後側 === 0 || 二字 || 細い))
          坏.push(`${訪ね}（${a}:${前側} ${b}:${後側} 邊${邊}）が解釋なしに默つた`);
        for (const 物 of 出) {
          const 語 = String(物.word);
          if (語.includes(" ")) continue; /* 二語に割る打ち手は其侭一つの搜れ目 */
          if (語.length < 3 && !/^[A-Za-z0-9]+$/.test(語)) 坏.push(`${訪ね} → ${語}（切れ端）`);
          else if (当たり(語) <= 0) 坏.push(`${訪ね} → ${語}（搜れん語）`);
        }
      }
    expect(見, "搜の侧が割れん續ぎ方が一也無い").toBeGreaterThan(120);
    /* 殆どが打ち替えを出すやうになつた – 默つた儘殘る形（二字の略語・搜れる語の無い尾）は十本未满。*/
    expect(默り内訳.length, `まだ默つて居る續ぎ方 ${默り内訳.length} 本`).toBeGreaterThan(0);
    expect(默り内訳.length, `默りの內譯が説明出来ん`).toBeLessThan(60);
    expect(坏, `切れ端 ${坏.length} 本: ${坏.slice(0, 8).join(" / ")}`).toEqual([]);
  });

  it("搜れる打ち手は一通も動かん（打ち替えの家は搜に效かん）", () => {
    for (const [訪ね, 當] of [
      ["機械学習", 504],
      ["チュートリアル", 6],
      ["スパコン会議", 207],
      ["AIチュートリアル", 0],
      ["HPCチュートリアル", 0],
      ["ネットワーク", 257],
      ["会議 締切", 2886],
      [
        "会議締切",
        2886,
      ] /* 第 667 回 – 搜が落とす語（`会議`）を頭に载せて屆くやうにした（前は 0 件）*/,
      ["暗号アルゴリズム", 0],
      ["量子エラー訂正", 0],
      ["今週を過ぎた", 0],
    ] as Array<[string, number]>) {
      expect(当たり(訪ね), `搜の當たりを變へた: ${訪ね}`).toBe(當);
    }
    expect(收錄().length, "品書の行數").toBe(3250);
  });

  it("邊の決まり – 字種と又ぎ抜きと頭の邊の内側（檢査が彈いた事實を張る）", () => {
    const 源 = readFileSync(`${REPO_ROOT}/site/recommender.ts`, "utf8");
    expect(源).toContain("字種の邊Ja");
    expect(源).toContain("一文字種Ja");
    /* 又ぎ抜き（`ー`）は語の内に許して邊を跨がんと限る（實測 `スパコンセミナー` が彈けた事故）。*/
    const 片假名級 =
      /const 一文字種Ja = \(語: string\): boolean =>\s*\/\^([^\n]*?)\$\/\.test\(語\) \|\| \/([^\n]*?)\$\/\.test\(語\)/.exec(
        源,
      );
    expect(片假名級, "字種の決まりが讀められん").not.toBeNull();
    expect(片假名級![2]).toContain("ー");
    /* 頭の邊より内側を切らん決まりが在る事。*/
    expect(源).toMatch(/let 頭の邊 = -1;/);
    expect(源).toMatch(/if \(頭の邊 >= 0 && k < 頭の邊\) continue;/);
    /* 三文字未満を彈く門（切れ端除け – 第 622 回と同じ趣旨）。*/
    expect(源).toMatch(/前語\.length >= 3/);
    expect(源).toMatch(/後語\.length >= 3/);
    /* 二字の略語（`AI` `OS` `DB` `CPU`）は打たれた形が大文字 only の時だけ通す –
     * 小文字の二字切れ端（`gi` `th`）を語と數へん為（第 665 回）。*/
    expect(源).toMatch(/\^\[A-Z\]\{2\}\$\//);
  });
});
