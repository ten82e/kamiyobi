import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtSite } from "./built_site.ts";

/** 日本語の文に混ざると読めなくなる語（文字番號で持つ – このファイルの見た目にも出さない）。 */
const 混ぜない語: Array<[string, number[]]> = [
  ["中國語の「ファイル」", [0x6587, 0x4ef6]],

  ["中國語の「值」", [0x503c]],
  ["中國語の「增」", [0x589e]],
  ["中國語の「スナップショット」", [0x5feb, 0x7167]],
  ["舊字の「ファイル」（計畫の內側では使ふが、出來上がりでは使はない）", [0x6a94, 0x6848]],
];

const 見る物 = [
  "index.html",
  "upcoming.html",
  "404.html",
  "llms.txt",
  "upcoming.md",
  "health.md",
  "data.csv",
];

describe("出來上がりに、日本語でない語を混ぜない（第 740 回）", () => {
  it("利用者が読む物に、混ざると読めなくなる語がない", () => {
    const site = builtSite();
    let 見た = 0;
    for (const name of 見る物) {
      const path = join(site, name);
      if (!existsSync(path)) continue;
      見た += 1;
      /* 引用（`` `…` `` で括つた実物の記録）は外してから見る – 説明の為に引用する事がある。 */
      let 本文 = readFileSync(path, "utf8").replace(/`[^`\n]*`/g, "");

      if (name.endsWith(".html")) 本文 = 本文.replace(/<!--[\s\S]*?-->/g, "");
      for (const [呼び名, 符] of 混ぜない語) {
        const 語 = String.fromCharCode(...符);

        const 殘り = 本文.split(語).length - 1;
        expect(殘り, `${name} に${呼び名}の語が ${殘り} 箇所混ざつて居る`).toBe(0);
      }
    }
    /* 空振り防止（一つのファイルも見て居ない検査に成つて居ないか）。 */
    expect(見た, "出來上がりを一つも見て居ない（建ててから走らせる事）").toBeGreaterThanOrEqual(5);
  });
});

it("生成した散文に、旧字体を混ぜない（第 848 回）", () => {
  const 舊字體 =
    "亞惡壓圍爲醫壹榮衞驛悅圓緣艷鹽奧應歐毆櫻橫溫價畫會懷繪擴殼學嶽樂渴卷陷勸寬歡罐觀關顏歸" +
    "氣龜僞戲犧舊據擧峽狹鄕曉區驅勳薰羣徑惠揭溪經繼莖螢輕鷄藝擊缺儉劍圈檢權獻硏縣險顯驗嚴廣效" +
    "恆鑛號國黑濟碎齋劑冱雜參慘蠶贊殘絲齒兒辭濕實舍壽收從澁獸縱肅處敍將燒獎條狀乘淨剩疊孃讓" +
    "釀囑觸寢愼盡圖粹醉穗隨髓數樞瀨聲靜齊攝竊專淺戰纖禪曾雙壯爭莊搜巢裝騷增藏臟屬續墮體對帶" +
    "滯臺瀧擇澤單膽團彈斷癡遲蟲鑄廳徵聽懲鎭遞鐵點轉傳燈當黨盜稻鬪德獨讀屆繩惱腦霸廢拜賣麥發" +
    "髮拔蠻祕拂佛變邊辨瓣辯舖步寶豐襃沒飜槇每萬滿默彌藥與搖樣謠來賴亂覽龍兩獵綠淚壘禮勵戾靈" +
    "齡曆歷戀鍊爐勞樓郞錄灣眞稱舉產譯譽閱虛蠟淸昻剝摑盃";
  const site = builtSite();
  let 見た = 0;
  for (const 名 of ["llms.txt"]) {
    const path = join(site, 名);
    if (!existsSync(path)) continue;
    見た += 1;
    const 本文 = readFileSync(path, "utf8");
    for (const 字 of 舊字體) {
      expect(本文.includes(字), `${名} に舊字體「${字}」が混ざつて居る`).toBe(false);
    }
  }
  expect(見た, "生成した散文を見て居ない").toBeGreaterThanOrEqual(1);
});

it("日本語の値を許し、中国語の異なる字を検出する", () => {
  const unwanted = (text: string) =>
    混ぜない語.some(([, points]) => text.includes(String.fromCodePoint(...points)));
  expect(unwanted("数値・初期値・値を確認する")).toBe(false);
  expect(unwanted(`初期${String.fromCodePoint(0x503c)}`)).toBe(true);
});
