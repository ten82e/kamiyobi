/**
 * 羣の讀み上げ（`live`）の長さの**橫断檢査**（第 651 回）。
 *
 * 六十字の決まりは第 247 回から有るが、これまで檢査して居たのは**新規に作った羣と家每**で、
 * 舊い羣をまとめて見た檢査が無かつた。源の羣目録を作って讀み上げを通ると（第 651 回實測 –
 * **七十三羣・語 1,502 本**）、**先頭の語で六十字を越える家が七つ**（最長 105 字 – `以前` 85 字
 * `印刷` 72 字 `データの出典` …）と、**讀み上げの文その物が六十を越える家**が一つ（`ics` 66 字）在つた。
 * 讀み上げは聲で聽く物で、長く成る程**後で說く筈の打ち替への道が切れて聽こえる**（畫面の斷りは
 * 其侪讀めるので聲だけが劣化する – 何も知らない人が損をする形）。
 *
 * 缩める時に落としてならん物を檢査が實測で拾つた（此の回合の五つの失敗が其れ）– 打ち替への道を
 * 名指す語（『過去の締切も表示』『1月から7月』『ブラウザの印刷』『データ源』『件数欄』『見方のてびき』
 * 『『ランク』の選択欄』）は tests/meta_query_note.test.ts 等が「讀み上げが場所を言わない」「絞れん
 * 事を言わない」で張つて居た。又、六十字を越えて居る事を**讓した所として張つて居た**檢査
 * （第 247 回 – tests/venue_speaker_days_left_words.test.ts）は、越えんやうに成つたので**通る張りに
 * 張り替へた**。
 *
 * 檢査は
 *  ① 源から讀んだ**全ての羣**を通す事（羣の數が源の `words: [` と會ふ – 潛り拔け防止）、
 *  ② 讀み上げが空で無い事（空だと「打った語」だけ讀む – 實測で檢査の穴だつた）、
 *  ③ 讀み上げの文その物・先頭の語で組み立てた文が各六十字に納まる事、
 *  ④ 缩めた十の家が指し先を持つ事
 * を張る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { REPO_ROOT } from "./helpers.ts";

const 源 = readFileSync(join(REPO_ROOT, "site", "recommender.ts"), "utf8");
const 羣の先 = 源.indexOf("const UI_WORD_GROUPS_JA");

type 羣 = { 語: string[]; 讀み上げ: string };

/** 一つの羣の書字から語列と讀み上げを読む。 */
function 解(本: string): 羣 {
  const 始 = 本.indexOf("words: [");
  const 語: string[] = [];
  if (始 >= 0) {
    const 終 = 本.indexOf("]", 始);
    for (const m of 本.slice(始, 終 < 0 ? undefined : 終).matchAll(/"([^"]*)"/g)) 語.push(m[1]);
  }
  const l = /live:\s*"((?:[^"\\]|\\.)*)"/.exec(本);
  return { 語, 讀み上げ: l ? l[1] : "" };
}

/**
 * 羣の一覽のオブジェクトを順に読む。キーの順は羣每に違う（`PCメンバー` は `words` が後ろ）ので、
 * 正規表現で寄せず、**文字每に括弧の深さを數へて**區切る（字列の中の括弧は數へん）。
 */
function 羣の目録(): 羣[] {
  expect(羣の先, "羣の一覽が見つからん（檢査の目その物が壞れた）").toBeGreaterThan(0);
  let i = 源.indexOf("= [", 羣の先) + 3;
  const 出: 羣[] = [];
  for (;;) {
    /* 羣の間には斷りの註が幾つも入る – 空白と逗點だけ飛ばしても停まる（第 651 回の実發生 –
     * 註の先頭で「羣の終わり」と誤つた）。*/
    for (;;) {
      while (i < 源.length && /[\s,]/.test(源[i])) i++;
      if (源[i] === "/" && 源[i + 1] === "*") {
        i += 2;
        while (i + 1 < 源.length && !(源[i] === "*" && 源[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      if (源[i] === "/" && 源[i + 1] === "/") {
        while (i + 1 < 源.length && 源[i + 1] !== "\n") i++;
        i++;
        continue;
      }
      break;
    }
    if (源[i] !== "{") break;
    let 深 = 0;
    let 字列 = false;
    let エス = false;
    let 物 = "";
    for (; i < 源.length; i++) {
      const 字 = 源[i];
      物 += 字;
      /* ブロック註と行註は羣の間に幾つも挟まる – 其の中の括弧と字列記號で深さが狂はぬやうに
       * 飛ばす（第 651 回の実發生 – 註を數へたら二羣で止まつた）。*/
      if (!字列 && 字 === "/" && (源[i + 1] === "*" || 源[i + 1] === "/")) {
        物 += 源[i + 1];
        if (源[i + 1] === "/") {
          while (i + 1 < 源.length && 源[i + 1] !== "\n") {
            i++;
            物 += 源[i];
          }
        } else {
          while (i + 1 < 源.length && !(源[i] === "*" && 源[i + 1] === "/")) {
            i++;
            物 += 源[i];
          }
          i++;
          物 += "/";
        }
        continue;
      }
      if (字列) {
        if (エス) エス = false;
        else if (字 === "\\") エス = true;
        else if (字 === '"') 字列 = false;
        continue;
      }
      if (字 === '"') 字列 = true;
      else if (字 === "{") 深++;
      else if (字 === "}") {
        深--;
        if (深 === 0) {
          i++;
          break;
        }
      }
    }
    出.push(解(物));
  }
  return 出;
}

function 讀み上げ(語: string): string {
  return String(Recommender.uiWordLiveNoteJa(語, false) || "");
}

describe("羣の讀み上げの長さの橫断檢査（第 651 回）", () => {
  it("源の羣の數が讀める數と會ふ（新しい羣を潛らせない）", () => {
    const 目録 = 羣の目録();
    const 宣 = 源.slice(源.indexOf("= [", 羣の先), 源.indexOf("\n  ];", 羣の先));
    expect(目録.length, "羣の數が源の `words: [` と會はんと").toBe(宣.split("words: [").length - 1);
    /* 空振り防止 – 第 651 回の実測は七十三羣・語 1,502 本。減つたら檢査の目が壞れて居る。*/
    expect(目録.length, "讀める羣が少なすぎる").toBeGreaterThanOrEqual(73);
    expect(
      目録.reduce((a, x) => a + x.語.length, 0),
      "讀める語が少なすぎる",
    ).toBeGreaterThanOrEqual(1500);
  });

  it("全ての羣が讀み上げを持ち、文その物が六十字に納まる（空は語だけ讀む穴）", () => {
    for (const { 語, 讀み上げ: l } of 羣の目録()) {
      const 名 = 語[0] ?? "?";
      expect(l, `「${名}」の羣に讀み上げが無い`).not.toBe("");
      expect([...l].length, `「${名}」の讀み上げが六十を越える（文その物）`).toBeLessThanOrEqual(
        60,
      );
    }
  });

  it("全ての羣の讀み上げが、先頭の語で組んで六十字に納まる（第 247 回の決まりを橫断で張る）", () => {
    const 越 = 羣の目録()
      .map(({ 語 }) => [[...讀み上げ(語[0])].length, 語[0]] as [number, string])
      .filter(([字]) => 字 > 60);
    expect(
      越.map(([字, 語]) => `${語}（${字} 字）`).join("・"),
      "讀み上げが六十字を越えた家（聲で打ち替への道が切れる）",
    ).toBe("");
  });

  it("斷りの側には讀み上げ以上の話が載つて居る（聲だけ惡くなる家が無い）", () => {
    for (const { 語 } of 羣の目録()) {
      const 聲 = 讀み上げ(語[0]);
      const 文 = String(Recommender.uiWordNoteJa(語[0], false) || "");
      expect([...文].length, `「${語[0]}」の斷りが讀み上げより短い`).toBeGreaterThanOrEqual(
        [...聲].length,
      );
    }
  });

  it("缩めた十の家が、落としてならん指し先を持つ（檢査が實測で拾つた物）", () => {
    const 指し先: Array<[string, string[]]> = [
      ["以前", ["過去の締切も表示", "1月から7月", "過ぎた締切"]],
      ["印刷", ["ブラウザの印刷", "見方のてびき", "コピー"]],
      ["データの出典", ["データ源", "検索では絞り込めません"]],
      ["プロセッサ", ["コンピュータアーキテクチャ"]],
      ["上半期", ["暦月"]],
      ["メジャー", ["『ランク』の選択欄", "クイック抽出"]],
      ["収録期間", ["件数欄", "見方のてびき", "検索では絞り込めません"]],
      ["書き出し", [".ics", "CSV", "引き継がれません"]],
      /* 橫断檢査で新たに出た三家（第 651 回）*/
      ["ics", ["語の途中で当たった", "カレンダーに追加"]],
      ["大会", ["研究会", "ワークショップ"]],
    ];
    for (const [語, 物] of 指し先) {
      const 聲 = 讀み上げ(語);
      for (const p of 物) expect(聲, `「${語}」の讀み上げから「${p}」が消えた`).toContain(p);
      expect(
        [...聲].length,
        `「${語}」の讀み上げが長い（${[...聲].length} 字）`,
      ).toBeLessThanOrEqual(60);
    }
  });
});
