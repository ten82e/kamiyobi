import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { likelyDuplicateVenues } from "../scripts/validate-data.ts";
import { REPO_ROOT } from "./helpers.js";

// overrides.yaml の 2027 以降 edition で
// 「event 情報のみ・deadlines 無し」のブロックは、意図マーカー
// （未公開 / CFP 未 / 会期のみ / 上流と一致 等のコメント）を必須とする。
// esann 2027 の会期だけの実 edition 追加が merge の
// 「実 edition は推定を置換」ルールで推定締切を消し、締切 0 件になった。
const OVERRIDES_PATH = join(REPO_ROOT, "data", "overrides.yaml");

// 意図マーカーとして認める語（コメント内に現れればよい）
const MARKERS =
  /未公開|CFP\s*未|会期のみ|上流と一致|意図的|\bTBA\b|\bintentional|deadlines?\s*(なし|無し|未|空)/i;

interface EventOnlyBlock {
  key: string;
  year: number;
}

interface VenueRecord {
  key?: string;
  title?: string;
  full_name?: string;
  link?: string;
  legacy_keys?: string[];
  editions?: Array<{ year?: number }>;
}

function loadVenues(path: string): VenueRecord[] {
  const loaded = loadYaml(readFileSync(join(REPO_ROOT, path), "utf8")) as {
    conferences?: VenueRecord[];
  };
  return loaded.conferences ?? [];
}

const COLLAPSED_PROMOTIONS: Record<string, string[]> = {
  "bdiot-2026": ["acm-bdiot-2026"],
  "admit-2026": ["ieee-admit-2026"],
  "ccisc-2026": ["ieee-ccisc-2026"],
  "csp-2027": ["csp-ei-2027", "ieee-csp-2027"],
  "icaici-2026": ["ieee-icaici-2026"],
  icbda2027: ["icbda-2027"],
  "iccns-2026": ["iccns-ei-2026"],
  "iccr-2026": ["ieee-iccr-2026"],
  "icimt-2026": ["icimt-ei-2026"],
  "icmip-2027": ["icmip-ei-2027"],
  "keir-cikm2026": ["keir-cikm-2026"],
  raai2026: ["raai-2026"],
};

function expectCollapsedPromotions(records: VenueRecord[], source: string) {
  const liveKeys = new Set(records.map((conference) => conference.key));
  for (const [key, legacyKeys] of Object.entries(COLLAPSED_PROMOTIONS)) {
    const matches = records.filter((conference) => conference.key === key);
    expect(matches, `${source}: ${key} must have one live record`).toHaveLength(1);
    expect(matches[0]?.link, `${source}: ${key} must point at an official page`).toMatch(
      /^https?:\/\//,
    );
    expect(matches[0]?.link, `${source}: ${key} must not use an aggregator link`).not.toMatch(
      /easychair|wikicfp|dbworld|listserv/i,
    );
    for (const legacy of legacyKeys) {
      expect(liveKeys.has(legacy), `${source}: ${legacy} must not remain a live key`).toBe(false);
      expect(matches[0]?.legacy_keys ?? []).toContain(legacy);
    }
  }
}

/**
 * overrides.yaml の生テキストを走査し、2027+ の edition で
 * `deadlines:` キーを持たないブロックを列挙する。
 * 各ブロックの直上コメントに意図マーカーが無ければ FAIL。
 */
function findUnmarkedEventOnlyBlocks(raw: string, minYear = 2027): EventOnlyBlock[] {
  const lines = raw.split("\n");
  const hits: EventOnlyBlock[] = [];
  // ブロック構造: `<key>:` → `    editions:` → `      <year>:` (conferences 直下)
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(lines[i]); // conferences.<key>:
    if (!m) continue;
    const key = m[1];
    if (key === "aliases" || key === "drop") continue;
    // editions を探す
    let j = i + 1;
    while (j < lines.length && /^\s/.test(lines[j]) && !/^ {2}[a-z0-9-]+:/.test(lines[j])) {
      if (/^ {4}editions:/.test(lines[j])) break;
      j++;
    }
    if (j >= lines.length || !/^ {4}editions:/.test(lines[j])) continue;
    // editions 配下の year ブロック
    let k = j + 1;
    while (k < lines.length && /^\s/.test(lines[k]) && !/^ {4}[a-z0-9-]+:/.test(lines[k])) {
      const ym = /^ {6}(\d{4}):\s*$/.exec(lines[k]);
      if (ym) {
        const year = Number(ym[1]);
        if (year >= minYear) {
          // この year ブロック内に deadlines: / event 情報があるか（次の year ブロックまで）
          let l = k + 1;
          let hasDeadlines = false;
          let hasEventInfo = false;
          while (
            l < lines.length &&
            /^\s/.test(lines[l]) &&
            !/^ {6}\d{4}:/.test(lines[l]) &&
            !/^ {4}[a-z0-9-]+:/.test(lines[l]) &&
            !/^ {2}[a-z0-9-]+:/.test(lines[l])
          ) {
            if (/deadlines:/.test(lines[l])) hasDeadlines = true;
            if (/date_text:|event_start:|event_end:|place:/.test(lines[l])) hasEventInfo = true;
            l++;
          }
          // 規律対象: event 情報のみ（date_text 等）で deadlines を持たないブロック。
          // link のみのブロックは対象外（会期・締切どちらも触れず事故経路にならない）。
          if (!hasDeadlines && hasEventInfo) {
            // コメント窓: key 行の直前コメント群まで含める
            const above = lines.slice(Math.max(0, i - 8), k).join("\n");
            if (!MARKERS.test(above)) hits.push({ key, year });
          }
        }
      }
      k++;
    }
  }
  return hits;
}

describe("invariants", () => {
  it("I3: overrides.yaml の 2027+ event-only edition は意図マーカー必須", () => {
    const raw = readFileSync(OVERRIDES_PATH, "utf8");
    const hits = findUnmarkedEventOnlyBlocks(raw);
    expect(hits).toEqual([]);
  });

  it("I3: マーカーありの event-only ブロックは合格する", () => {
    const raw = `
conferences:
  # 会期のみ（締切は CFP 未発表）
  dummy-conf:
    editions:
      2027:
        date_text: April 1-3, 2027
        event_start: '2027-04-01'
        event_end: '2027-04-03'
`;
    expect(findUnmarkedEventOnlyBlocks(raw)).toEqual([]);
  });

  it("I3: マーカー無しの 2027+ event-only ブロックを検出する (fail-closed)", () => {
    const raw = `
conferences:
  dummy-conf:
    editions:
      2027:
        date_text: April 1-3, 2027
        event_start: '2027-04-01'
        event_end: '2027-04-03'
`;
    const hits = findUnmarkedEventOnlyBlocks(raw);
    expect(hits).toEqual([{ key: "dummy-conf", year: 2027 }]);
  });
});

describe("invariants", () => {
  it("I4: 手編集データのカテゴリは全て config.yaml に存在する (#269)", () => {
    // 経緯: hpc-fabrics-2026 が categories: [hpc, networks]（typo）を持ち、
    // classify の既知カテゴリへのフィルタが networks を黙って落として
    // networking フィードから欠落した（#269）。未知カテゴリは無警告で
    // 消えるため、手編集データ側で存在チェックして fail-closed にする。
    const config =
      (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as Record<string, any>) ?? {};
    const known = new Set(Object.keys((config.categories as Record<string, unknown>) ?? {}));
    expect(known.size).toBeGreaterThan(0);

    const referenced: Array<[string, string]> = [];
    const addConfs = (confs: unknown[], source: string): void => {
      for (const c of confs) {
        if (typeof c !== "object" || c === null) continue;
        const rec = c as Record<string, unknown>;
        const key = String(rec.key ?? rec.title ?? "?");
        for (const cat of (rec.categories as unknown[] | null) ?? []) {
          referenced.push([`${source}:${key}`, String(cat)]);
        }
      }
    };
    // data/extra.yaml（会議配列）
    const extra =
      (loadYaml(readFileSync(join(REPO_ROOT, "data", "extra.yaml"), "utf8")) as Record<
        string,
        any
      >) ?? {};
    addConfs((extra.conferences as unknown[] | null) ?? [], "extra.yaml");
    // data/overrides.yaml（key → patch の map）
    const overrides =
      (loadYaml(readFileSync(join(REPO_ROOT, "data", "overrides.yaml"), "utf8")) as Record<
        string,
        any
      >) ?? {};
    const patches = (overrides.conferences as Record<string, unknown>) ?? {};
    for (const [key, patch] of Object.entries(patches)) {
      if (typeof patch !== "object" || patch === null) continue;
      const rec = patch as Record<string, unknown>;
      for (const cat of (rec.categories as unknown[] | null) ?? []) {
        referenced.push([`overrides.yaml:${key}`, String(cat)]);
      }
    }

    const unknown = referenced.filter(([, cat]) => !known.has(cat));
    expect(unknown).toEqual([]);
  });

  it("I5: local の表記違い同一開催回を二重公開しない (#677)", () => {
    const extra = loadVenues("data/extra.yaml");
    const canonical = [
      ...loadVenues("data/manual.yaml"),
      ...loadVenues("data/curated.generated.yaml"),
    ];
    expect(likelyDuplicateVenues(extra), "extra.yaml").toEqual([]);
    expect(likelyDuplicateVenues(canonical), "manual.yaml + curated.generated.yaml").toEqual([]);
  });

  it("I6: 旧昇格12グループは公式リンク付きの正規キー1件へ収束している", () => {
    expectCollapsedPromotions(loadVenues("data/extra.yaml"), "extra.yaml");
    expectCollapsedPromotions(loadVenues("data/manual.yaml"), "manual.yaml");
  });

  it("I5: 同一会議の表記揺れを検出し、同じ略称の別会議は許す", () => {
    const edition = [{ year: 2027 }];
    expect(
      likelyDuplicateVenues([
        {
          key: "icbda-2027",
          title: "IEEE ICBDA 2027",
          full_name: "IEEE 12th International Conference on Big Data Analytics (ICBDA 2027)",
          editions: edition,
        },
        {
          key: "icbda2027",
          title: "ICBDA2027",
          full_name: "12th International Conference on Big Data Analytics",
          editions: edition,
        },
      ]),
    ).toEqual(["icbda-2027 / icbda2027"]);
    expect(
      likelyDuplicateVenues([
        {
          key: "sec",
          title: "SEC 2027",
          full_name: "ACM/IEEE Symposium on Edge Computing",
          editions: edition,
        },
        {
          key: "sec-sc",
          title: "SEC 2027",
          full_name: "IFIP International Information Security Conference",
          editions: edition,
        },
        {
          key: "fse-se",
          title: "FSE 2027",
          full_name: "ACM International Conference on the Foundations of Software Engineering",
          editions: edition,
        },
        {
          key: "fse-sc",
          title: "FSE 2027",
          full_name: "Fast Software Encryption",
          editions: edition,
        },
      ]),
    ).toEqual([]);
  });
});

it("I29: 公式ドメインの宿主が割れる会議は venue_identities で結ぶ（第 1032 回）", async () => {
  const config =
    (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as Record<string, any>) ?? {};
  const 結び = (config.venue_identities ?? {}) as Record<
    string,
    { source_ids?: Record<string, string> }
  >;
  expect(
    Object.keys(結び).length,
    "venue_identities が読めない（この検查が空振り）",
  ).toBeGreaterThan(5);

  /* 宿主（`new URL(...).hostname`）を取り出す – 年が違ふだけの同じサイトは
   * `2027.aclweb.org` / `2026.aclweb.org` の様に**別の宿主**に成るが、それは事故ではない
   * （mergeSources が別の絲で結ぶ）。ここで見たいのは **ICDM の様に全然違う宿主**。 */
  const 宿主 = (公式: unknown): string => {
    const 文 = String(Array.isArray(公式) ? (公式[0] ?? "") : (公式 ?? "")).trim();
    try {
      return new URL(文).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };

  /* 上流の ccfddl と local を持つ会議で、宿主が割れている物を全部集める。
   * キャッシュがある時だけ走る（CI の offline ビルドと同じ經路）。 */
  const { hooks } = await import("../src/cli.ts");
  const collected = await hooks.collect(join(REPO_ROOT, ".cache"), { offline: true });
  const local = (collected.groups[0] ?? []) as Array<Record<string, any>>;
  const ccfddl = (collected.groups[1] ?? []) as Array<Record<string, any>>;
  expect(local.length, "local 源が読めない").toBeGreaterThan(0);
  expect(ccfddl.length, "ccfddl 源が読めない").toBeGreaterThan(0);

  const 割れた: string[] = [];
  for (const l of local) {
    const key = String(l.key ?? "");
    const c = ccfddl.find((x) => x.key === key);
    if (!c) continue;
    const lh = 宿主(l.identity?.officialDomains);
    const ch = 宿主(c.identity?.officialDomains);
    if (lh && ch && lh !== ch) 割れた.push(key);
  }
  expect(割れた.length, "宿主が割れる会議が一つもない（この検查が空振り）").toBeGreaterThan(3);

  const 結んで無い = 割れた.filter((key) => !(key in 結び));
  expect(
    結んで無い,
    "公式ドメインの宿主が local と ccfddl で割れる会議に venue_identities の一枚がない（ICDM 2027 の事故と同じ形 – 建造が ambiguous published history identity で飛ぶ）",
  ).toEqual([]);

  /* `icdm` の一枚は**三つの情報源**を結んで居なければならない（事故の核）。
   * `source_ids` は「情報源の名 → その情報源の中の ID」。 */
  const icdm = 結び.icdm;
  expect(icdm, "venue_identities に icdm がない").toBeTruthy();
  const icdmの源 = Object.keys(icdm?.source_ids ?? {});
  const 實際の源 = new Set((local.find((c) => c.key === "icdm")?.sources ?? []) as string[]);
  for (const 源 of 實際の源) {
    expect(icdmの源, `icdm の結びに ${源} が無い`).toContain(源);
  }
  /* ccfddl の ICDM は `DB/icdm`（フォルダ付き）なので、素の `icdm` ではない。
   * 此を書き間違へると同じ事故に成る。 */
  expect(icdm?.source_ids?.ccfddl, "icdm の ccfddl の ID が DB/icdm ではない").toBe("DB/icdm");
  expect(icdm?.source_ids?.local, "icdm の local の ID が icdm ではない").toBe("icdm");
  expect(icdm?.source_ids?.aideadlines, "icdm の aideadlines の ID が icdm ではない").toBe("icdm");
});
