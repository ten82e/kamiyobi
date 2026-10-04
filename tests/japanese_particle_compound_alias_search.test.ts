/*
 * 第 676 回 – 助詞を含む和名（`モノのインターネット` の類ひ）を搜しが語に割らずに引けるやうにした
 *
 * 事實（2026-08-09 生成の実ビルド・品書 3,250 行・搜し欄）:
 *   `モノのインターネット` 0 行 → 9 行（搜し欄で `IoT` と打つ人は已に 9 行受けて居た）
 *   `ネットワークの測定`   0 行 → 21 行（`ネットワーク測定` と同じ 21 行）
 *   `データの管理`         0 行 → 51 行（`データ管理` と同じ 51 行）
 *   `プライバシーの保護`   0 行 → 116 行（`プライバシー` と同じ 116 行）
 *   `インターネットの測定` 0 行 → 10 行
 *   `ものづくり`           0 行 → 2 行（ISRIMT – 收錄は `manufacturing` と書く）
 * 根本原因は表で無く**割り方**にあつた。搜しは一まとめの語として寄せ表を引く前に助詞
 * （`QUERY_PARTICLE_SPLIT_CHARS`）で語を割る為、`モノのインターネット` は
 * `[["モノ"], ["インターネット"]]` に化け、其の侬が表の鍵として引けん（割れた片側は別の語の
 * 組になる – `測定` `管理` `保護` `モノ` はいずれも 0 行なので、AND で全体が默つた）。
 * 第 674 回は此れを「助詞で割れる和名は載せん」（決まり⑤）として拔いたが、原因を取り違へて居た。
 * 直しは `site/recommender.ts` の `splitQueryToken` の頭に門を一つ – **寄せ表に其の侬の鍵が
 * 載つて居る和名は割らん** – 載せた表の鍵を搜しが引けるやうにするのが本筋なのである。
 * 既存の 231 條（開催地）と 131 條（主題）の鍵には助詞を含む物が無く（この檢査が確かめる）、
 * 割らん門は新しい条目にしか効かない – 振ひの突合は搜し文 371 本で增 6・減 0、讓り 2,578 本で
 * 增 0・消 0・書換 0 を見て居る（SPEC.md 第 676 回）。
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import Recommender from "../site/recommender.ts";
import { TOPIC_QUERY_ALIASES_JA } from "../site/topic-aliases.ts";
import { queryReferenceSnapshotPath } from "./query_reference.ts";

const AT = Date.parse("2026-08-09T00:00:00Z");
const 品書 = Recommender.candidateRows(
  JSON.parse(fs.readFileSync(queryReferenceSnapshotPath(), "utf8")) as never,
) as unknown as Array<{ hay: string }>;
const 目録 = Recommender.candidateRows(
  JSON.parse(fs.readFileSync("public/data.json", "utf8")) as never,
) as unknown as Array<{ hay: string }>;
const 畳 = (x: unknown) => String(x).normalize("NFKC").toLowerCase();
function 搜(row: Array<{ hay: string }>, q: string): string[] {
  const 當 = Recommender.searchMatcher(Recommender.expandRelativeMonths(q, AT), AT);
  return row.filter((r) => 當(String(r.hay)) === true).map((r) => 畳(r.hay));
}
const 當 = (q: string) => 搜(品書, q);
for (let i = 0; i < 170; i += 1) 當("クラウド締切"); // 初回の遅さを引くので暖める
const 表に載る = (ja: string) => TOPIC_QUERY_ALIASES_JA.some((対) => 対[0] === ja);

/* 和名, 寄せ先, 品書の件數, 目録の件數（2026-08-09 生成で實測） */
const 載せた六條: Array<[string, string, number, number]> = [
  ["モノのインターネット", "IoT", 9, 9],
  ["ネットワークの測定", "network measurement", 21, 23],
  ["インターネットの測定", "internet measurement", 10, 10],
  ["データの管理", "data management", 51, 51],
  ["プライバシーの保護", "privacy", 116, 120],
  ["ものづくり", "manufacturing", 2, 2],
];

describe("助詞を含む和名も寄せ表が引ける（第 676 回）", () => {
  it("六條が搜し 0 行から行に出て、注も出る", () => {
    for (const [ja, canonical] of 載せた六條) {
      // 上流更新で収録数は変わる。和名と寄せ先が同じ行を返すことを検査する。
      expect(當(ja).length, `品書 ${ja}`).toBeGreaterThan(0);
      expect(當(ja), `品書 ${ja}`).toEqual(當(canonical));
      expect(搜(目録, ja).length, `目録 ${ja}`).toBeGreaterThan(0);
      expect(搜(目録, ja), `目録 ${ja}`).toEqual(搜(目録, canonical));
      expect(Recommender.querySynonymNotes(ja).join(" "), `${ja} の注`).toContain("も探しています");
    }
  });

  it("載せた和名は助詞で割れん – 表に無い語は今まで通り割れる", () => {
    for (const [ja] of 載せた六條) {
      const 組 = Recommender.queryTokenGroups(ja, AT);
      expect(組.length, `${ja} が ${JSON.stringify(組)} と割れた`).toBe(1);
      expect(組[0], `${ja} の組に寄せ先が無い`).toContain(ja);
    }
    // 門は表に載つた鍵だけを守る – 他の打ち方の割り方は變はらん（減 0 の根拠）。
    expect(Recommender.queryTokenGroups("機械の学習", AT)).toEqual([["機械"], ["学習"]]);
    expect(Recommender.queryTokenGroups("ネットワークの性能", AT)).toEqual([
      ["ネットワーク"],
      ["性能"],
    ]);
    expect(Recommender.queryTokenGroups("データの分析", AT)[0].length).toBeGreaterThan(0);
    // 助詞を含む鍵を載せて居ない表（開催地・主題の既存の 362 條）に助詞の鍵は無い –
    // 割らん門は新しい条目にしか効かない事を表その物で確かめる。
    const 助詞々 = "のもへがをやをでには";
    const 割れる鍵 = TOPIC_QUERY_ALIASES_JA.map((対) => 対[0]).filter((和名) =>
      [...和名].some((字) => 助詞々.indexOf(字) >= 0 && 表に載る(和名)),
    );
    expect([...new Set(割れる鍵)].sort(), "想定外の助詞の鍵").toEqual(
      [
        "インターネットの測定",
        "モノのインターネット",
        "データの管理",
        "ネットワークの測定",
        "ものづくり",
        "プライバシーの保護",
      ].sort(),
    );
  });

  it("增えた行の內譯が揃ひ、割れる前の打ち手と同じ行に出る", () => {
    // 寄せた語を行うに持つ行だけ – 誤爆で增えて居らん事を一行ずつ見る。
    for (const [ja, en] of 載せた六條) {
      const 語列 = 畳(en).split(/\s+/);
      const 外 = 當(ja).filter((h) => !h.includes(畳(ja)) && !語列.every((w) => h.includes(w)));
      expect(外, `${ja} を寄せたのに內譯の揃はん行を拾った: ${外[0]?.slice(0, 70)}`).toEqual([]);
    }
    // 搜し欄で其の方の綴りを打つ人と同じ行に出る（割る前の 0 行を埋めるだけの寄せでない證）。
    const 揃 = (a: string[]) => [...new Set(a)].sort();
    expect(揃(當("モノのインターネット"))).toEqual(揃(當("IoT")));
    expect(揃(當("データの管理"))).toEqual(揃(當("データ管理")));
    expect(揃(當("ネットワークの測定"))).toEqual(揃(當("ネットワーク測定")));
    expect(揃(當("プライバシーの保護"))).toEqual(揃(當("プライバシー")));
  });

  it("拔いた一本 – `音声の認識` は寄せ先が語を揃へで書く行を持たん（決まり①）", () => {
    expect(表に載る("音声の認識"), "拔いた積りの条目が載つて居る").toBe(false);
    expect(當("音声の認識").length, "`音声の認識` に行が出た").toBe(0);
    // 搜し欄で `speech recognition` と打つ人は 19 行受けるが、其れは寄せ表を通らんと –
    // 二つの語が別々の組になり、`recognition` の組が和名（`認識`）等も持つ為 56 行に廣い。
    // 寄せ表の語列は同じ行に二語が並ぶ事を要求するので、その行は 0 行 – 內譯の揃はんと載せん。
    expect(當("speech recognition").length).toBe(19);
    expect(當("recognition").length).toBe(56);
    const 揃ふ = 品書.filter(
      (r) => 畳(r.hay).includes("speech") && 畳(r.hay).includes("recognition"),
    );
    expect(揃ふ.length, "speech と recognition を揃へで書く行が出たので再考する").toBe(0);
  });

  it("單語の当たりは無傷 – 割らん門を足した所での減は無い", () => {
    const 金型: Array<[string, number]> = [
      ["暗号", 117],
      ["視覚", 250],
      ["機械学習", 504],
      ["ネットワーク", 257],
      ["データ管理", 51],
      ["プライバシー", 116],
      ["ネットワーク測定", 21],
      ["データマイニング", 177], // 第 673 回の `data mining` への寄せ – 語を揃へで書く行も含む
      ["計算機科学", 0],
      ["30日以内", 689],
      ["file", 15],
      ["systems", 1004],
      ["高性能計算", 207],
    ];
    for (const [q, n] of 金型) expect(當(q).length, `搜 ${q}`).toBe(n);
    expect(品書.length, "品書の行数その物が動いた").toBe(3250);
    expect(TOPIC_QUERY_ALIASES_JA.length, "主題の寄せ表の条目數").toBe(138);
  });
});
