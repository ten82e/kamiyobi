import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** 利用者に出る文へ残してはならない、戦前の仮名遣いと旧かな・旧字の書き方。
 * 検索語として受け取る表（`words:` の条目や正規表現）は別物なので、ここには入れない
 * （打つ人の字をそのまま受けるための物で、画面の文ではない）。 */
const 古い書き方 = [
  "やうな",
  "やうに",
  "やうだ",
  "言ふ",
  "言ひ",
  "思ふ",
  "考へ",
  "添へ",
  "答へ",
  "居ります",
  "居ます",
  "居ません",
  "居らん",
  "居り",
  "居る",
  "其の",
  "其れ",
  "此の",
  "此れ",
  "其の方",
  "其の儘",
  "其々",
  "夫々",
];

/** 促音を大書きする形（`載つて` `従つて`）。漢字の直後の `つ` は現代かなでは小書きにする。 */
const 促音の大書き = /[一-龥]つ[てた]/g;

/** 旧字体（`scripts/ja-text-audit.ts` と同じ表）。利用者に出る文には使わない。
 * 打つ人が旧字体で打つ語を受ける表は別物なので、下の許し書きに挙げた物だけ外す。 */
const 旧字体 =
  "亞惡壓圍爲醫壹榮衞驛悅圓緣艷鹽奧應歐毆櫻橫溫價畫會懷繪擴殼學嶽樂渴卷陷勸寬歡罐觀關顏歸" +
  "氣龜僞戲犧舊據擧峽狹鄕曉區驅勳薰羣徑惠揭溪經繼莖螢輕鷄藝擊缺儉劍圈檢權獻硏縣險顯驗嚴廣效" +
  "恆鑛號國黑濟碎齋劑冱雜參慘蠶贊殘絲齒兒辭濕實舍壽收從澁獸縱肅處敍將燒獎條狀乘淨剩疊孃讓" +
  "釀囑觸寢愼盡圖粹醉穗隨髓數樞瀨聲靜齊攝竊專淺戰纖禪曾雙壯爭莊搜巢裝騷增藏臟屬續墮體對帶" +
  "滯臺瀧擇澤單膽團彈斷癡遲蟲鑄廳徵聽懲鎭遞鐵點轉傳燈當黨盜稻鬪德獨讀屆繩惱腦霸廢拜賣麥發" +
  "髮拔蠻祕拂佛變邊辨瓣辯舖步寶豐襃沒飜槇每萬滿默彌藥與搖樣謠來賴亂覽龍兩獵綠淚壘禮勵戾靈" +
  "齡曆歷戀鍊爐勞樓郞錄灣眞稱舉產譯譽閱虛蠟淸昻剝摑盃";

/** 打つ人の字をそのまま受ける条目（`words:` の検索語）。利用者に出る文ではないので外す。
 * 旧字体で打たれた語を現代の字へ寄せる表が別にあり、その表を引くために置いてある。 */
const 打つ人の字の許し書き = ["國際", "略稱", "在學証明", "記錄視聴", "殘る", "殘ります"];

/** 画面と機械向けの索引を作る正本。 */
const 見るファイル = [
  "site/app.ts",
  "site/ics.ts",
  "site/latin-retype.ts",
  "site/place-aliases.ts",
  "site/recommendation.ts",
  "site/recommendation-core.ts",
  "site/recommender.ts",
  "site/submission-identity.ts",
  "site/topic-aliases.ts",
  "src/build.ts",
  "src/mcp.ts",
];

/** 文字列の中身だけを切り出す（註と正規表現には触れない）。
 * 註を外してから探すと、註の中の語を拾ってしまう – 見たいのは利用者に出る文だけ。 */
function 文字列の中身(本文: string): string[] {
  const 中身: string[] = [];
  let i = 0;
  /* 直前の意味のある字。`/` が割り算か正規表現かの見分けにだけ使う。 */
  let 直前 = "";
  while (i < 本文.length) {
    const 字 = 本文[i];
    const 次 = 本文[i + 1];
    if (字 === "/" && 次 === "*") {
      const 終 = 本文.indexOf("*/", i + 2);
      i = 終 === -1 ? 本文.length : 終 + 2;
      continue;
    }
    if (字 === "/" && 次 === "/") {
      const 改行 = 本文.indexOf("\n", i);
      i = 改行 === -1 ? 本文.length : 改行 + 1;
      continue;
    }
    /* 正規表現の中の引用符を文字列の始まりと読み違えない（`/["\n]/` の類）。
     * 割り算との見分けは直前の字で付ける – 式が始まる所にだけ正規表現が立つ。 */
    if (字 === "/" && 次 !== "=" && (直前 === "" || /[([{,;:=!&|?+\-*%<>~^]/.test(直前))) {
      let j = i + 1;
      let 中か = false;
      while (j < 本文.length) {
        const c = 本文[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") 中か = true;
        else if (c === "]") 中か = false;
        else if (c === "/" && !中か) break;
        else if (c === "\n") break;
        j += 1;
      }
      i = j + 1;
      直前 = "/";
      continue;
    }
    if (字 !== '"' && 字 !== "'" && 字 !== "`") {
      if (!/\s/.test(字)) 直前 = 字;
      i += 1;
      continue;
    }
    const 囲み = 字;
    let j = i + 1;
    let 始 = j;
    while (j < 本文.length) {
      const c = 本文[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      /* 型引数の `${}` は式なので、その中は見ない（変数名は文ではない）。 */
      if (囲み === "`" && c === "$" && 本文[j + 1] === "{") {
        中身.push(本文.slice(始, j));
        let 深さ = 1;
        j += 2;
        while (j < 本文.length && 深さ > 0) {
          const k = 本文[j];
          if (k === "\\") {
            j += 2;
            continue;
          }
          if (k === "{") 深さ += 1;
          else if (k === "}") 深さ -= 1;
          else if (k === '"' || k === "'" || k === "`") {
            j += 1;
            while (j < 本文.length && 本文[j] !== k) {
              if (本文[j] === "\\") j += 1;
              j += 1;
            }
          }
          j += 1;
        }
        始 = j;
        continue;
      }
      if (c === 囲み) break;
      if (c === "\n" && 囲み !== "`") break;
      j += 1;
    }
    中身.push(本文.slice(始, j));
    i = j + 1;
    直前 = '"';
  }
  return 中身;
}

describe("利用者に出る文の現代かな遣い", () => {
  it("画面と索引の正本に、戦前の書き方が残っていない", () => {
    const 見つけた: string[] = [];
    for (const 道 of 見るファイル) {
      const 本文 = readFileSync(道, "utf8");
      const 行番号 = (位置: number): number => 本文.slice(0, 位置).split("\n").length;
      for (const 文 of 文字列の中身(本文)) {
        const 在る位置 = 本文.indexOf(文);
        for (const 語 of 古い書き方) {
          if (文.includes(語))
            見つけた.push(`${道}:${行番号(在る位置)} 「${語}」 ${文.trim().slice(0, 60)}`);
        }
        for (const 当たり of 文.matchAll(促音の大書き)) {
          見つけた.push(`${道}:${行番号(在る位置)} 促音「${当たり[0]}」 ${文.trim().slice(0, 60)}`);
        }
        /* 旧字体も戦前の書き方である（2026-10-16 実測: `llms.txt` に出る文へ
         * 「實測」「畫面」と書いてしまい、かな遣いの検査だけでは素通りした）。 */
        if (打つ人の字の許し書き.includes(文.trim())) continue;
        const 旧字 = [...new Set([...文].filter((字) => 旧字体.includes(字)))];
        if (旧字.length)
          見つけた.push(
            `${道}:${行番号(在る位置)} 旧字体「${旧字.join("")}」 ${文.trim().slice(0, 60)}`,
          );
      }
    }
    expect(見つけた, `現代かな遣いへ直す: \n${見つけた.join("\n")}`).toEqual([]);
  });

  it("画面の雛形（`site/template.html`）の文にも残っていない", () => {
    /* 讀む人に見えるのは要素の文と屬性だけ。樣式と手順の塊（`<style>`・`<script>`）と
     * 註（HTML・CSS・JS の三つ）は外してから見る – 中の語は畫面に出ない
     * （2026-10-16 實測: 樣式の註に「收める」「讀めなくなる」があり、出す文ではない）。 */
    const 本文 = readFileSync("site/template.html", "utf8")
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    const 見つけた = [
      ...古い書き方.filter((語) => 本文.includes(語)),
      ...[...new Set([...本文].filter((字) => 旧字体.includes(字)))].map((字) => `旧字体「${字}」`),
    ];
    expect(見つけた, `template.html に残る古い書き方: ${見つけた.join("・")}`).toEqual([]);
  });
});
