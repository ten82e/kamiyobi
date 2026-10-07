/**
 * 利用者に出る文に、現代仮名遣いでない字（旧字体）や中国語が混ざっていないかの**候補**を出す。
 *
 * 使い方:
 *   node scripts/ja-text-audit.ts                # 既定のファイルを見る
 *   node scripts/ja-text-audit.ts site/app.ts    # 指定したファイルだけを見る
 *
 * 何故「候補」か: 註や識別子では旧字体を使う（この計画の内側の文体）。機械で註と文を完全に
 * 分けるのは無理なので、**人が見て確かめる**前提で候補を出す。出口は常に 0（検査ではない –
 * 赤くして止める物ではない。止める物は tests/ 側に在る）。
 *
 * 候補は三つに分けて出す（**掃除してよいのは「文らしい」だけ**）:
 *   - コードらしい: 行が宣言で始まる、或いは其の字が `${…}` の内側に在る。此の計画は日本語の
 *     識別子を使ふので、字を掃除すると**コードの改名**に化ける（第 774 回に型検査が止めた）。
 *   - 鍵らしい: 行が裸の並びの要素、或いは語の表（`words:`・寄せ表）の近く。旧字体で打つ人の
 *     為に**意図的に**置いてあるので触らない（第 772 回に一括置換で検査七本が落ちた）。
 *   - 文らしい: 上の何れでもない物＝掃除の対象。
 *
 * 何故要るか: 此の型の不具合を何度も踏んだ（第 706 回の快照・檔案、第 733 回の值、第 738 回の
 * 文件、第 745 回の常時受付、第 759 回の當たります）。成果物を見る検査では捕まらない物が在る
 * （文は JS が組み立てるので、静的な index.html には出ない）。
 */

import { readFileSync } from "node:fs";

/** 中国語の語（日本語では別の語を使う）。 */
const 中国語の語 = ["文件", "快照", "檔案", "值", "增"];

/** 旧字体の字（この計画の内側では使うが、利用者に出る文では使わない）。 */
const 旧字体の字 = "收錄檢當兩變學會國轉譯聲眞晝驛拂";

/** 計画の内側の名前（変数名・関数名）に使っている字。利用者に出ないので報告から外す。
 * 實測 2026-10-06: 既定の五ファイルで 75 件のうち大半が `聲`（読み上げの函数名）だった。 */
const 計畫の內側の名 = ["聲"];

const 既定のファイル = [
  "site/app.ts",
  "site/template.html",
  "site/recommender.ts",
  "src/build.ts",
  "src/mcp.ts",
];

/** 註（塊と行）を外す。完全ではない（文字列の中の記号に弱い）が、候補を出すには足りる。 */
function 註を外す(本文: string): string {
  return 本文
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^(\s*)\/\/.*$/gm, "$1");
}

/** 候補の分類（第 773・776 回）。 */
function 分類(行: string, 字: string): "コード" | "鍵" | "文" {
  if (/^(?:const|let|var|function|class|interface|type|return|if|for|while)\b/.test(行)) {
    return "コード";
  }
  const 前 = 行.slice(0, Math.max(0, 行.indexOf(字)));
  if (前.lastIndexOf("${") > 前.lastIndexOf("}")) return "コード";
  if (/^\s*["'`][^"'`]*["'`],?\s*$/.test(行) || /words:|\[\s*$|寄せ/.test(行)) return "鍵";
  return "文";
}

const 數 = { コード: 0, 鍵: 0, 文: 0 };

function 見る(path: string): void {
  const 本文 = readFileSync(path, "utf8");
  const 註抜き = 註を外す(本文);
  const 行々 = 本文.split("\n");
  const 言ふ = (位置: number, 見出し: string): void => {
    const 行番号 = 註抜き.slice(0, 位置).split("\n").length;
    const 行 = (行々[行番号 - 1] ?? "").trim();
    const 目安 = 分類(行, 見出し.slice(-1));
    數[目安] += 1;
    console.log(`${path}:${行番号}: ${見出し}（${目安}らしい） | ${行.slice(0, 80)}`);
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
}

const 引數 = process.argv.slice(2);
for (const path of 引數.length ? 引數 : 既定のファイル) {
  try {
    見る(path);
  } catch (error) {
    console.log(`${path}: 讀めない（${String(error).slice(0, 60)}）`);
  }
}
const 合計 = 數.コード + 數.鍵 + 數.文;
console.log(
  `\n候補 ${合計} 件（コードらしい ${數.コード} 件・鍵らしい ${數.鍵} 件・文らしい ${數.文} 件）。` +
    `**掃除してよいのは文らしい物だけ** – 鍵は旧字体で打つ人の為に意図的に置いてあり` +
    `（第 772 回）、コードは改名に化ける（第 774 回）。`,
);
