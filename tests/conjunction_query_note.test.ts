/**
 * 二つの語を「と」「や」「または」で繋いだ打ち方の導き（SPEC §7・第 612 回）。
 * 實測（2026-08-09 生成の実ビルド 868 行・固定時刻 2026-08-09T00:00:00Z）:
 * `口頭発表とポスター発表` は 0 件で、畫 face は何も言はなんだ – 語ごとの件數案内は
 * 群が二つ以上の時だけ立つ（第 256 回）ので、繋げて打たれると通らん。割つて直す案内
 * （第 532 回）も、片側の行が 0 件なので 0 件の侭。訪ねの意味は「二つの内のどちらが在るか」
 * なので、片方ずつの件數を名指して打ち直させると決まる。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { site } from "./built_golden_shared.ts";
import { deadlineHintFunction } from "./runtime_extract.ts";

type ConjRec = {
  conjunctionQueryNoteJa: (文: string, 件が當たるか: (文: string) => number) => string;
  searchMatcher: (文: string, 基: number) => (hay: unknown) => boolean;
  candidateRows: (data: unknown) => Array<{ hay: string }>;
};
let R: ConjRec;
beforeAll(async () => {
  const mod = await import(pathToFileURL(`${site}/recommender.js`).href);
  R = mod.default as unknown as ConjRec;
});

const 偽の件數 = (表: Record<string, number>) => (文: string) => 表[文] ?? 0;

describe("二つの語を繋いで訪ねる打ち方", () => {
  it("片方だけ行が無い形を、語と件數を名指して敎うる", () => {
    const 案内 = R.conjunctionQueryNoteJa(
      "口頭発表とポスター発表",
      偽の件數({ 口頭発表: 0, ポスター発表: 6 }),
    );
    expect(案内).toContain("「口頭発表」を書く行はなく");
    expect(案内).toContain("「ポスター発表」を書く行は 6 件");
    expect(案内).toContain("どちらかだけで打ってください");
    /* 打ち方その物を並べて、何を繋ぐと 0 件になるかを示す（第 388 回 – 打った語を名指す）。*/
    expect(案内).toContain("「口頭発表」と「ポスター発表」を「と」で繋いで");
  });

  it("両方が行を持つ形は、二つの件數を並べて兩方を含まん事を言う", () => {
    const 案内 = R.conjunctionQueryNoteJa("査読と採択", 偽の件數({ 査読: 13, 採択: 129 }));
    expect(案内).toContain("「査読」を書く行は 13 件");
    expect(案内).toContain("「採択」を書く行は 129 件");
    expect(案内).toContain("両方を含む行を探すため 0 件");
  });

  it("讓る形 – 默って二つの話をするな（第 530 回・第 337 回）", () => {
    /* 兩方の語が行持たん – 収録に無い語の話は別の案内がする（第 256 回・第 296 回）。*/
    expect(R.conjunctionQueryNoteJa("猫犬と羊山羊", 偽の件數({}))).toBe("");
    /* 打ち方自体が行を出すなら説教せんの門（第 337 回）。*/
    expect(
      R.conjunctionQueryNoteJa("査読と採択", 偽の件數({ 査読と採択: 4, 査読: 13, 採択: 129 })),
    ).toBe("");
    /* 既に空格で割れて居る打ち方は語ごとの件數案内の家（第 256 回）。*/
    expect(R.conjunctionQueryNoteJa("査読 と 採択", 偽の件數({ 査読: 13, 採択: 129 }))).toBe("");
    /* 語の途中で割らん（`と` は語の中にも入る）。助詞で始まる片側は受けない。*/
    expect(R.conjunctionQueryNoteJa("ひとつの締切", 偽の件數({ ひと: 0, の締切: 40 }))).toBe("");
    /* 一文字には割らん。*/
    expect(R.conjunctionQueryNoteJa("会と館", 偽の件數({ 会: 0, 館: 3 }))).toBe("");
  });

  it("長い目から見る – `または` を `と` で途中で割らん", () => {
    const 案内 = R.conjunctionQueryNoteJa(
      "査読または採択",
      偽の件數({ 査読: 13, 採択: 129, また: 8, して採択: 0, 査読または: 0 }),
    );
    expect(案内).toContain("「査読」を書く行は 13 件");
    expect(案内).not.toContain("「また」");
  });

  it("畫 faceの配線 – 數へる側を渡されん時は默り、渡すと斷りが出る（第 533 回と同じ筋）", () => {
    const hint = deadlineHintFunction();
    const base = {
      window: "all",
      past: false,
      cats: 0,
      domestic: false,
      online: false,
      rank: "all",
      kind: "",
      est: false,
      hidden: { past: 0, est: 0 },
      hiddenKindWords: [],
      queryMatch: { catalog: 0, journal: 0 },
      termCounts: [],
      urlQuery: false,
      catalogConferences: 12,
    };
    expect(hint({ ...base, query: "口頭発表とポスター発表" })).not.toContain("を書く行はなく");
    expect(
      hint({
        ...base,
        query: "口頭発表とポスター発表",
        splitCount: (文: string) => (文 === "ポスター発表" ? 6 : 0),
      }),
    ).toContain("「口頭発表」を書く行はなく、");
  });

  it("實データの品書でも決まる（噓の語を挙げたん – 第 337 回）", () => {
    const data = JSON.parse(readFileSync(`${site}/catalog.json`, "utf8")) as unknown;
    const rows = R.candidateRows(data).map((r) => String(r.hay));
    const 基 = Date.parse("2026-08-09T00:00:00Z");
    const 件 = (文: string) => rows.filter((h) => R.searchMatcher(文, 基)(h) === true).length;
    const 案内 = R.conjunctionQueryNoteJa("口頭発表とポスター発表", 件);
    expect(案内).toContain("「口頭発表」を書く行はなく");
    expect(件("ポスター発表")).toBeGreaterThan(0);
    expect(案内).toContain(`「ポスター発表」を書く行は ${件("ポスター発表")} 件`);
  });
});
