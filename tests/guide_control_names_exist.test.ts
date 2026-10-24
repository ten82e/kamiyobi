import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { builtSite } from "./built_site.ts";
import { REPO_ROOT } from "./helpers.ts";

/** 頁に無くてよい物 – **検索欄に打つ語**と**値の例**（操作では無い）。第 746 回の總当たりで洗つた物。 */
const 打つ物の例 = [
  "ワークショップ 締切",
  "会議の日程",
  "会場はどこ",
  "採否はいつ分かる",
  "コンピュータアーキテクチャ",
  "明日締切",
  "締切延長",
  "中旬",
  "年度初め",
  "年度末",
  "土日",
  "9月22日",
  "年末年始",
  "年末",
  "年始",
  "査読",
  "反論期間開始",
  "1月から7月",
  "8月22日以降",
  "17時以降",
  "明日以降",
  "デモ",
  "ポスター",
  "最寄り",
  "公式ページのURLを教えて",
  /* 値の例（行の『会期』に出る形を示した物）。 */
  "2026年12月1日(火)〜12月2日(水)",
];

/** 案内文（note と読み上げ）を、群の語から集める。 */
function 案内文(): string[] {
  const src = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
  const body = src.slice(src.indexOf("const UI_WORD_GROUPS_JA"), src.indexOf("type UIWordGroup"));
  const out: string[] = [];
  for (const m of body.matchAll(/words: \[([\s\S]*?)\],/g)) {
    const words = [...m[1].matchAll(/"([^"]+)"/g)].map((w) => w[1]);
    if (!words.length) continue;
    out.push(String(Recommender.uiWordNoteJa(words[0], false) || ""));
    out.push(String(Recommender.uiWordLiveNoteJa(words[0]) || ""));
  }
  return out;
}

describe("案内が名指す『…』は、頁か JS に実物がある（第 747 回）", () => {
  it("總ての『…』が、頁・JS・打つ物の例の何れかにある", () => {
    const site = builtSite();
    const 頁 = readFileSync(join(site, "index.html"), "utf8");
    const js = readFileSync(join(site, "app.js"), "utf8");
    const 引用 = new Set<string>();
    for (const 文 of 案内文()) {
      for (const q of 文.matchAll(/『([^』]{2,30})』/g)) 引用.add(q[1]);
    }
    expect(引用.size, "案内から『…』が一つも取れない（書き方が変わった）").toBeGreaterThan(50);
    const 幽靈 = [...引用].filter(
      (x) => !頁.includes(x) && !js.includes(x) && !打つ物の例.includes(x),
    );
    expect(
      幽靈,
      "案内が名指す物が、頁にも JS にも無く、打つ物の例にもない（選べない物を指している）",
    ).toEqual([]);
  });

  it("打つ物の例の一覽が、使われなくなった物で膨らんで居ない", () => {
    /* 例を消したのに一覽に残ると、次に同じ語が幽靈として現れても氣付けない。 */
    const 全部 = 案内文().join("\n");
    const 使はれない = 打つ物の例.filter((x) => !全部.includes(`『${x}』`));
    expect(使はれない, "使われて居ない例が一覽に残つている").toEqual([]);
  });
});
