import { readFileSync } from "node:fs";

/** 中国語の語（日本語では別の語を使う）。 */
const 中国語の語 = ["文件", "快照", "檔案", "值", "增"];

const 旧字体の字 =
  "亞惡壓圍爲醫壹榮衞驛悅圓緣艷鹽奧應歐毆櫻橫溫價畫會懷繪擴殼學嶽樂渴卷陷勸寬歡罐觀關顏歸" +
  "氣龜僞戲犧舊據擧峽狹鄕曉區驅勳薰羣徑惠揭溪經繼莖螢輕鷄藝擊缺儉劍圈檢權獻硏縣險顯驗嚴廣效" +
  "恆鑛號國黑濟碎齋劑冱雜參慘蠶贊殘絲齒兒辭濕實舍壽收從澁獸縱肅處敍將燒獎條狀乘淨剩疊孃讓" +
  "釀囑觸寢愼盡圖粹醉穗隨髓數樞瀨聲靜齊攝竊專淺戰纖禪曾雙壯爭莊搜巢裝騷增藏臟屬續墮體對帶" +
  "滯臺瀧擇澤單膽團彈斷癡遲蟲鑄廳徵聽懲鎭遞鐵點轉傳燈當黨盜稻鬪德獨讀屆繩惱腦霸廢拜賣麥發" +
  "髮拔蠻祕拂佛變邊辨瓣辯舖步寶豐襃沒飜槇每萬滿默彌藥與搖樣謠來賴亂覽龍兩獵綠淚壘禮勵戾靈" +
  "齡曆歷戀鍊爐勞樓郞錄灣眞稱舉產譯譽閱虛蠟淸昻剝摑盃";

const 簡体字 = "载云侧并个单后忆进错记选测";
/* この定義の行は自分のファイル – 自分が鳴ると mechanics が止まる。 */
/** この表の行は**表その物**なので、この検査で鳴らせない。 */

/** 計画の内側の名前（変数名・関数名）に使っている字。利用者に出ないので報告から外す。
 * 実測 2026-10-06: 既定の五ファイルで 75 件のうち大半が `声`（読み上げの関数名）だつた。 */
const 計畫の內側の名 = ["聲"];

/** この行は中国語をわざと受ける物か（中国語の打鍵の正規表現・打鍵表）。
 * 内容で決める – 行番号は注を外す前の数え方であり、外すとすぐずれる。 */
function 中國語を受ける行か(行: string): boolean {
  return /[\u4e00-\u9fff]/.test(行) && (行.includes("/") || 行.includes("[") || 行.includes(":"));
}

const 既定のファイル = [
  "site/app.ts",
  "site/template.html",
  "site/recommender.ts",
  "src/build.ts",
  "src/mcp.ts",
];

type 目安 = "コードらしい" | "鍵らしい" | "文らしい";

/** 注（塊と行）を外す。完全ではない（文字列の中の記号に弱い）が、候補を出すには足りる。
 * 行の数が変はらぬ樣、外した所は空白で埋める（行番号がずれん）。 */
function 註を外す(本文: string): string {
  return 本文

    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(?<=\/\/)[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** 行の見た目から目安を決める（第 773・780 回）。 */
function 目安を決める(行: string): 目安 {
  const 註を外した行 = 行.replace(/\/\/.*$/, "").trim();
  if (
    /\$\{[^}]*$/.test(行) ||
    /^[^\s"'`(,]+\s*(?:[+\-*/]?=)[^=]/.test(註を外した行) ||
    /^[^\s"'`(,]+\s*:\s*["'`]/.test(註を外した行) ||
    /^(?:const|let|var|function|class|interface|type|return|if|for|while|import|export)\b/.test(
      註を外した行,
    )
  ) {
    return "コードらしい";
  }
  if (
    /^\s*\[/.test(行) ||
    /^\s*["'`][^"'`]*["'`],?\s*$/.test(行) ||
    /words:|\[\s*$|寄せ|\bretype\b/.test(行)
  ) {
    return "鍵らしい";
  }

  if (/^\s*LOCATION:/i.test(行)) return "鍵らしい";
  if (/(?:^|\\n)\s*(?:開催地|會場|開催場所)\s*:/.test(行)) return "鍵らしい";

  if ((行.match(/,/g) ?? []).length >= 5) return "鍵らしい";
  return "文らしい";
}

const 數: Record<目安, number> = { コードらしい: 0, 鍵らしい: 0, 文らしい: 0 };
const 文だけ = process.argv.includes("--文");
const 引數 = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function 見る(path: string): void {
  /* このスクリプトの筈は外す – 下の表の字が自分の行に於て鳴り、利用者に出る文ではない。 */
  if (path.endsWith("ja-text-audit.ts")) return;
  const 本文 = readFileSync(path, "utf8");
  const 註抜き = 註を外す(本文);
  const 行々 = 本文.split("\n");
  const 言ふ = (位置: number, 見出し: string): void => {
    const 行番号 = 註抜き.slice(0, 位置).split("\n").length;
    const 行 = (行々[行番号 - 1] ?? "").trim();

    const 實の行 = ((): string => {
      for (let k = 行番号 - 1; k > 0; k -= 1) {
        if (!/^\s/.test(行々[k - 1] ?? "")) return (行々[k - 1] ?? "").trim();
      }
      return "";
    })();
    const 續きか = /^\s/.test(行々[行番号 - 1] ?? "");
    const 目安 =
      續きか &&
      (/^\s*LOCATION:/i.test(實の行) ||
        /(?:^|\\n)\s*(?:開催地|會場|開催場所)\s*:/.test(實の行) ||
        /開催地\s*$/.test(實の行) ||
        /^DESCRIPTION:/i.test(實の行))
        ? "鍵らしい"
        : 目安を決める(行);
    數[目安] += 1;
    if (!文だけ || 目安 === "文らしい") {
      console.log(`${path}:${行番号}: ${見出し}（${目安}） | ${行.slice(0, 78)}`);
    }
  };
  for (const 語 of 中国語の語) {
    let at = 註抜き.indexOf(語);
    while (at >= 0) {
      言ふ(at, `中国語「${語}」`);
      at = 註抜き.indexOf(語, at + 1);
    }
  }
  for (const 字 of 旧字体の字) {
    if (計畫の內側の名.includes(字)) continue;
    let at = 註抜き.indexOf(字);
    while (at >= 0) {
      言ふ(at, `旧字体「${字}」`);
      at = 註抜き.indexOf(字, at + 1);
    }
  }
  /* 中国語の**簡体字** – 旧字体と同じ扱いで候補を出す。 */
  for (const 字 of 簡体字) {
    if (計畫の內側の名.includes(字)) continue;
    let at = 註抜き.indexOf(字);
    while (at >= 0) {
      /* 中国語をわざと受ける行は外す（正規表現・打鍵表 – 第 915 回の續け）。 */
      const 行番号 = 註抜き.slice(0, at).split("\n").length;
      const 行の文 = (行々[行番号 - 1] ?? "").trim();
      if (!中國語を受ける行か(行の文)) 言ふ(at, `簡体字「${字}」（日本語の字ではありません）`);
      at = 註抜き.indexOf(字, at + 1);
    }
  }
}

for (const path of 引數.length ? 引數 : 既定のファイル) {
  try {
    見る(path);
  } catch (error) {
    console.log(`${path}: 讀めない（${String(error).slice(0, 70)}）`);
  }
}
const 合計 = 數.コードらしい + 數.鍵らしい + 數.文らしい;
console.log(
  `\n候補 ${合計} 件（コードらしい ${數.コードらしい} 件・鍵らしい ${數.鍵らしい} 件・` +
    `文らしい ${數.文らしい} 件）。**掃除してよいのは文らしい物だけ** – 鍵は旧字体で打つ人の` +
    `為に意図的に置いてあり（第 772 回）、コードは改名に化ける（第 774 回）。`,
);
