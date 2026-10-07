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
 * 何故要るか: 此の型の不具合を何度も踏んだ（第 706 回の快照・檔案、第 733 回の值、第 738 回の
 * 文件、第 745 回の常時受付、第 759 回の當たります）。成果物を見る検査では捕まらない物が在る
 * （文は JS が組み立てるので、静的な index.html には出ない）。
 */

import { readFileSync } from "node:fs";

/** 中国語の語（日本語では別の語を使う）。 */
const 中国語の語 = ["文件", "快照", "檔案", "值", "增"];

/** 旧字体の字（この計画の内側では使うが、利用者に出る文では使わない）。 */
const 旧字体の字 = "收錄檢當兩變學會國轉譯聲眞晝驛拂";

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

function 見る(path: string): number {
  const 本文 = readFileSync(path, "utf8");
  const 註抜き = 註を外す(本文);
  let 件數 = 0;
  for (const 語 of 中国語の語) {
    let at = 註抜き.indexOf(語);
    while (at >= 0) {
      const 行番号 = 註抜き.slice(0, at).split("\n").length;
      const 行 = 本文.split("\n")[行番号 - 1].trim();
      console.log(`${path}:${行番号}: 中国語「${語}」 | ${行.slice(0, 90)}`);
      件數 += 1;
      at = 註抜き.indexOf(語, at + 1);
    }
  }
  for (const 字 of 旧字体の字) {
    let at = 註抜き.indexOf(字);
    while (at >= 0) {
      const 行番号 = 註抜き.slice(0, at).split("\n").length;
      const 行 = 本文.split("\n")[行番号 - 1].trim();
      /* 識別子の宣言行は外す（變數名に舊字體を使ふ事が在る – 利用者には出ない。人が見る候補を
       * 減らす爲の目安で、完全な判別では無い）。*/
      if (!/^(?:const|let|var|function|class|interface|type)\b/.test(行)) {
        console.log(`${path}:${行番号}: 旧字体「${字}」 | ${行.slice(0, 90)}`);
        件數 += 1;
      }
      at = 註抜き.indexOf(字, at + 1);
      continue;
      件數 += 1;
      at = 註抜き.indexOf(字, at + 1);
    }
  }
  return 件數;
}

const 引數 = process.argv.slice(2);
const ファイル = 引數.length ? 引數 : 既定のファイル;
let 合計 = 0;
for (const path of ファイル) {
  try {
    合計 += 見る(path);
  } catch (error) {
    console.log(`${path}: 讀めない（${String(error).slice(0, 60)}）`);
  }
}
console.log(`\n候補 ${合計} 件。註・識別子の物は其の侭でよい（人が見て決める）。`);
