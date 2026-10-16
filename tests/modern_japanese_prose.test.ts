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
      }
    }
    expect(見つけた, `現代かな遣いへ直す: \n${見つけた.join("\n")}`).toEqual([]);
  });

  it("画面の雛形（`site/template.html`）の文にも残っていない", () => {
    const 本文 = readFileSync("site/template.html", "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const 見つけた = 古い書き方.filter((語) => 本文.includes(語));
    expect(見つけた, `template.html に残る古い書き方: ${見つけた.join("・")}`).toEqual([]);
  });
});
