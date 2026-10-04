/*
 * 第 678 回 – 締切の種別その物に `締切` を繋いで打つ人を、種の語に寄せる
 *
 * 搜しは `X + 締切` の繋がれた形を語尾で割るが、頭の語彙に載つた物だけ割る（第 517・528・666・
 * 667・677 回）。`採否通知` `登録締切` のやうに**種別の語自体が表の欄の値**だつた語は、其處で
 * 割ると別の規則（種の寄せ・分野の複合）の受け先を経んで行が廣うならん（第 677 回の実測 –
 * `採否通知deadline` を割つても 0 行 ⇔ 空格 3 行）ので、拔いた。拔いた儘にすると繋いだ人だけが
 * 0 行で默つて了うので、**言い換えの表 `QUERY_SYNONYMS_JA`**（画面に出るラベルへ寄せて、件數欄に
 * 「こう探しました」と出す家 – 第 246 回）で受ける。
 * 事實（2026-08-09 生成の実ビルド・品書 3,250 行）:
 *   `採否通知` 240 行 ⇔ `採否通知締切` 舊 0 行・讓り無言 → **240 行**（種別『採否通知』）
 *   `採否通知` 240 行 ⇔ `採否通知deadline` 舊 0 行・讓り無言 → **240 行**
 *   `査読結果公開` 32 行 ⇔ `結果締切` 舊 0 行・讓り無言 → **32 行**
 *   `登録締切` 22 行 ⇔ `参加登録締切` 舊 0 行・讓り無言 → **22 行**
 *   `登録締切` 22 行 ⇔ `参加締切` 舊 0 行・讓り無言 → **22 行**
 * 彈いた物の事實も張る – `査読締切` は羣の案内が持つ家（第 535 回 – 搜 0 行の侬）、
 * `参加申込締切`（0 行）は申込が論文か登錄か打ち手自身が分らんので種の語を名指せんですます、
 * 同じ語を重ねた打ち手（`結果締切締切`）は寄せを經ん 0 行（單一の鍵なので二重に寄せん）。
 * 振ひ – 搜し文 383 本で增 5・減 0（目録も增 5・減 0）、讓りの打ち手 2,578 本で增 0・消 0・
 * 書換 0（SPEC.md 第 678 回）。
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(fs.readFileSync(queryReferenceSnapshotPath(), "utf8")) as never,
) as unknown as Array<{ hay: string }>;
const 畳 = (x: unknown) => String(x).normalize("NFKC").toLowerCase();
function 當る(q: string): string[] {
  const matcher = Recommender.searchMatcher(Recommender.expandRelativeMonths(q, AT), AT);
  return 品書.filter((r) => matcher(String(r.hay)) === true).map((r) => 畳(r.hay));
}
const 當 = (q: string) => 當る(q).length;
for (let i = 0; i < 170; i += 1) 當("クラウド締切"); // 初回の遅さを引くので暖める
function 讓(q: string): string {
  const 有 = (x: string): boolean => 當る(x).length > 0;
  const 數 = (x: string): number => 當る(x).length;
  return [
    Recommender.columnQueryNoteJa(q, 有),
    Recommender.uiWordNoteJa(q, false),
    Recommender.dayRangeNoteJa(q),
    Recommender.wholeTableQueryNoteJa(q),
    ...((Recommender.relativeDayNotes(q, AT) || []) as string[]),
    ...(Recommender.querySynonymNotes(q) || []),
    Recommender.conjunctionQueryNoteJa(q, 數),
  ]
    .filter(Boolean)
    .join(" ∥ ")
    .trim();
}
const 列 = (a: string[]) => [...new Set(a)].sort().join("\n");

describe("種の語に締切を繋いだ打ち手の寄せ（第 678 回）", () => {
  it("五つの打ち手が種の語と同じ行に出て、寄せた事を讓りが言う", () => {
    const 與: Array<[string, string, string, number]> = [
      ["採否通知締切", "採否通知", "採否通知", 240],
      ["採否通知deadline", "採否通知", "採否通知", 240],
      ["結果締切", "査読結果公開", "査読結果公開", 32],
      ["参加登録締切", "登録締切", "登録締切", 22],
      ["参加締切", "登録締切", "登録締切", 22],
    ];
    for (const [續, 種, 示, 數] of 與) {
      expect(當(續), `繋いだ ${續} が 0 行の侬`).toBe(數);
      // 寄せ先（種の語その物）と**同じ行の集合** – 別の意味の行を混ぜて居ん證。
      expect(列(當る(續)), `${續} が ${種} と違う行に當たつた`).toBe(列(當る(種)));
      // 默つて廣げん – 件數欄に種の語を名指す文が出る（第 246 回の決まり）。
      const 文 = 讓(續);
      expect(文, `${續} の寄せを隱して並べた`).toContain(`種別「${示}」`);
      expect(文, `${續} の打ち手その物を示さん`).toContain(續);
      // 增えた行が噓で無い證 – 種の語を行に持つ。
      const 外 = 當る(續).filter((h) => !h.includes(畳(種)));
      expect(外, `${續} の行に ${種} が無い: ${外[0]?.slice(0, 60)}`).toEqual([]);
    }
  });

  it("彈いた打ち手の事實 – 羣の案内が持つ語・種の語を名指せん語・重ねた語", () => {
    // `査読締切` は羣の案内の家（搜 0 行の侬 – 搜しを動かさん）。
    expect(當("査読締切"), "`査読締切` の搜しが動いた").toBe(0);
    expect(讓("査読締切"), "羣の案内が消えた").toContain("繋ぎ方");
    // `参加申込締切` は彈いた – 申込が論文か登錄か打ち手自身が分らん（種の語を名指せんですます）。
    expect(當("参加申込締切"), "`参加申込締切` を寄せて了うた").toBe(0);
    // 同じ語を重ねた打ち手は單一の鍵に會はん（二重に寄せん）。
    expect(當("結果締切締切"), "重ねた語を寄せて了うた").toBe(0);
    // 英字だけの語尾を変へた形も同じ種に屆く（`締切` と `deadline` で行が変わらん）。
    expect(列(當る("採否通知deadline")), "deadline と 締切 で行が変わつた").toBe(
      列(當る("採否通知締切")),
    );
  });

  it("單語と別の家の振ひは無傷 – 今までの當たりはそのまま", () => {
    const 金型: Array<[string, number]> = [
      ["採否通知", 240],
      ["査読結果公開", 32],
      ["結果", 32],
      ["参加", 109],
      ["参加登録", 66],
      ["登録", 22],
      ["登録締切", 22],
      ["クラウド締切", 892],
      ["特集号締切", 17],
      ["最終原稿締切", 147],
      ["情報理論締切", 9],
      ["高性能計算提出", 130],
      ["延長締切", 36],
      ["オンライン提出", 0],
      ["8月締切", 546],
      ["システム締切", 0],
      ["ソナー締切", 0],
      ["分散計算締切", 0],
    ];
    for (const [q, n] of 金型) expect(當(q), `搜 ${q}`).toBe(n);
    expect(品書.length, "品書の行数その物が動いた").toBe(3250);
  });

  it("語の中に在る時も寄る（打ち直しを言はんで屆く）", () => {
    // 語を二つ打つ人也同じ經路 – 種の寄せは語ごとに効く（助詞で割れる形は別の家が持つ）。
    expect(當("採否通知 2027"), "單語の側の動きが變はつた").toBe(當("採否通知締切 2027"));
    expect(當("結果締切"), "`結果締切` が 0 行に了うた").toBeGreaterThan(0);
    const 文 = 讓("採否通知締切 2027");
    expect(文, "語を足した所で寄せを隱した").toContain("種別「採否通知」");
  });

  it("寄せの表に種の語を載せる決まり – 展開語は欄に出る語だけ", () => {
    const 源 = fs.readFileSync("site/recommender.ts", "utf8");
    const 欄 = [
      ...String(/const KIND_LABEL_JA[^=]*= \{([\s\S]*?)\n {2}\};/.exec(源)?.[1]).matchAll(
        /"([^"]+)"/g,
      ),
    ]
      .map((m) => m[1])
      .filter((v, i, a) => a.indexOf(v) === i);
    expect(欄.length, "種別の欄の語が讀められん（檢査が空振りする）").toBeGreaterThan(6);
    const 塊 = String(/const QUERY_SYNONYMS_JA[\s\S]*?\n {2}\];/.exec(源)?.[0]);
    expect(塊, "寄せ語の対応表が讀められん").not.toBe("");
    for (const 語 of ["採否通知締切", "結果締切", "参加登録締切", "参加締切"])
      expect(塊, `載せ但した: ${語}`).toContain(`"${語}"`);
    // 載せ直した五語の展開語は種の欄に出る語その物（默つて別物を並べん – 第 246 回の決まり）。
    // ※表の他の條の展開語は分野・主題タグ等の欄にも並び得る（別の檢査が表全体を見て張る –
    //   `tests/build_golden.test.ts` の「展開語は画面に出す表記そのもの」）。此處は此の五語だけ見る。
    let 調べ = 0;
    // 改行を許す – `npx biome check --write` が長い條を折るので、一行目は前提に出來ん（第 679 回）。
    for (const m of 塊.matchAll(
      /"([^"]*(?:締切|deadline))",\s*"種別「([^」]+)」",\s*\[([^\]]*)\]/g,
    )) {
      const [鍵, 示, 展] = [m[1], m[2], m[3]];
      if (
        !["採否通知締切", "採否通知deadline", "結果締切", "参加登録締切", "参加締切"].includes(鍵)
      )
        continue;
      調べ += 1;
      expect(展, `${鍵} の展開語が一個も無い`).toContain(`"${示}"`);
      expect(欄, `種の寄せ先が欄に出る語に無い: ${鍵} → ${示}`).toContain(示);
    }
    expect(調べ, "載せた五語の條が讀められん（檢査が空振りする）").toBe(5);
  });
});
