#!/usr/bin/env node
/**
 * kamiyobi の収録を AI から引くための、読み取り専用の MCP サーバ（stdio。第 714 回）。
 *
 * 置き場所 – このリポジトリに同梱する。**静的サイト（GitHub Pages）には MCP を置けない**
 * ので、手元で動かす形にした（`node src/mcp.ts` / `npx kamiyobi-mcp`）。外へ送る物は無く、
 * 書き込みもしない（読むのは `data/snapshot.json` だけ）。
 *
 * 肝 – **画面と同じ検索核（`site/recommender.ts`）を使ふ**。別の索引を持つと、AI の答へる
 * 行數と案内文が畫面とずれる（人が見る物と AI が言ふ物が違ふのが一番惡い）。0 件の時に畫面が
 * 出す案内（全行の語・寄せ・群の斷り）も同じ函數から取る。
 *
 * 人間にも使へる – 引數に道具の名を書くと、其の場で其の道具を 1 回だけ走らせて文字を出す
 * （`node src/mcp.ts search "セキュリティ"`）。同じ道を人が確かめられる。
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recommendationAxes } from "../site/recommendation-core.ts";
import Recommender from "../site/recommender.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* 畫面が最初に読む窓（180 日）と、收錄の全體。**數字を畫面と一致させる**のが肝なので、
 * 先づ畫面と同じ窓（`public/catalog.json`）を見る。無ければ（まだ建てて居ない・配付物を
 * 持たない手元）収録の全体（`data/snapshot.json`）へ落ちて、其の旨を言ふ。 */
const CATALOG_PATH = join(ROOT, "public", "catalog.json");
const DATA_PATH = join(ROOT, "data", "snapshot.json");
/* 投稿先推薦の索引（建てた物）。**畫面が讀むのと同じ檔案**を使ふ – 別の索引を持つと、
 * AI が擧げる候補と畫面の候補が違ふ（第 714 回の「同じ検索核」と同じ理由）。 */
const RECOMMENDATION_PATH = join(ROOT, "public", "recommendation-index.json");
const SERVER_NAME = "kamiyobi";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL = "2025-06-18";

/* 行の形（`Recommender.candidateRows` が返す物の內、此處で使ふ分だけ）。 */
interface Row {
  conf: {
    key: string;
    title: string;
    acronym?: string;
    /* 正式名（第 887 回 – 略稱だけでは `Supercomputing` の樣に正式名にしか出て居ない語が
     * 引けない。實測 2026-10-20: search_deadlines は 37 行出すのに、venue_info は
     * 「收錄に在りません」と答へて居た）。 */
    full_name?: string;
    categories?: string[];
    rank?: unknown;
  };
  /** ランクの對（`ccf:A`・`core:A*` の形）。畫面のランク列と同じ正本から組む。 */
  rankPairs?: string[];
  /** 會議のタグ（`domestic-jp` など）。畫面の「国内研究会…のみ」と同じ判定に使ふ。 */
  tags?: string[];
  ed: {
    id: string;
    year?: number;
    place?: string;
    link?: string;
    event_start?: string;
    event_end?: string;
  };
  dl: {
    kind: string;
    label?: string;
    round?: number;
    precision?: string;
    tz_raw?: string;
    utc?: string;
    /** 確認の状態（上流が付けた印。オブジェクトの事と文字列の事がある – 語は畫面と同じ正本）。 */
    verification?: { status?: string } | string;
  };
  kind: string;
  est: boolean;
  t: number;
  /** 畫面が「表示している暦日」として出す時刻（`t` と 1 日ずれる行が在る – 窓と果ては此方を見る）。 */
  tShown?: number;
  localDate: string;
  dateOnly: boolean;
  hay: string;
}

let screenCache: Row[] | null = null;
let allCache: Row[] | null = null;

/* 元の檔案を一度だけ讀んで憶える（行と**生成時刻**を同じ物から取る）。畫面は右上に
 * 「データ生成」を常に出して居るので、MCP が其れを言はないと、人が見た日付と AI の答へが
 * 違ふ（人が見る物と AI が言ふ物を同じにする、が此の計畫の決まり）。 */
interface SnapshotFile {
  conferences?: Array<{
    key?: unknown;
    title?: unknown;
    acronym?: unknown;
    full_name?: unknown;
    link?: unknown;
    editions?: unknown[];
  }>;
  snapshot_metadata?: { generated_at?: unknown };
}
let snapshotCache: SnapshotFile | null = null;
let catalogCache: Record<string, unknown> | null | undefined;

/** 收錄の全体（`data/snapshot.json`。5,069 行・約 9MB）。 */
function snapshot(): SnapshotFile {
  if (!snapshotCache) snapshotCache = JSON.parse(readFileSync(DATA_PATH, "utf8")) as SnapshotFile;
  return snapshotCache;
}

/** 畫面が最初に読む窓（`public/catalog.json`）。無ければ null。 */
function catalog(): Record<string, unknown> | null {
  if (catalogCache === undefined) {
    try {
      catalogCache = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Record<string, unknown>;
    } catch {
      catalogCache = null;
    }
  }
  return catalogCache;
}

/** 画面が最初に読む窓の行。無ければ null。 */
function screenRows(): Row[] | null {
  if (screenCache) return screenCache;
  const 品書 = catalog();
  if (!品書) return null;
  try {
    screenCache = Recommender.candidateRows(品書 as never) as unknown as Row[];
    return screenCache;
  } catch {
    return null;
  }
}

/** 收錄の全体の行。 */
function allRows(): Row[] {
  if (!allCache) allCache = Recommender.candidateRows(snapshot() as never) as unknown as Row[];
  return allCache;
}

/** 使ふ窓を決める（既定は畫面と同じ。`scope: "all"` で收錄の全體）。
 * **生成時刻も一緒に返す** – 窓に依って出所の檔案が違ふので、古さの斷りも其れに合わせる。 */
/** 品書が載せた推薦の軸を、會議の key で引く（`candidateRows` は會議の欄を絞るので、
 * 軸は行の `conf` に残らない – 第 900 回）。品書が軸を持たない時は空を返す（其Caller は
 * 其場で計算する）。 */
let 軸の索引: Map<string, unknown> | undefined;
function 品書の軸(): Map<string, unknown> {
  if (軸の索引 !== undefined) return 軸の索引;
  const 品書 = catalog();
  const 會議 = Array.isArray(品書?.conferences) ? (品書!.conferences as unknown[]) : [];
  const 帶軸 = (會議 as Array<{ key?: unknown; recommendation_axes?: unknown }>).filter(
    (c) =>
      typeof c.key === "string" &&
      c.recommendation_axes &&
      typeof c.recommendation_axes === "object",
  );
  軸の索引 = new Map(帶軸.map((c) => [String(c.key), c.recommendation_axes] as [string, unknown]));
  return 軸の索引;
}

/** `scope` を正本に直す（`collection` は `all` と同じ物 – 索引の語）。 */
function scopeValue(scope: unknown): string {
  const 語 = String(scope ?? "")
    .trim()
    .toLowerCase();
  if (!語) return "";
  if (語 === "all" || 語 === "collection" || 語 === "full") return "all";
  if (語 === "screen" || 語 === "window" || 語 === "catalog") return "screen";
  return "";
}
/** 直前の `pick` が「知らない scope」を見た時の文（次の返り値の頭に付ける）。 */
let scopeErr = "";

function pick(scope: unknown): { list: Row[]; 名: string; 生成: unknown; 窓が無い: boolean } {
  scopeErr = "";
  /* **覚えてwifiらない scope は名指す**（第 908 回 – 實測 2026-11-01: `scope: "collection"`
   * や `scope: "nosuch"` は黙って**窓**を返して居た。索引の語は「収録の全体」なのに
   * schema には `all` としか無いため、AI が資料の語或其の儕の打鍵違いで別の物を見る –
   * 第 886 回の種別のと同じ括り）。`collection` は `all` の別名として受ける。 */
  if (String(scope ?? "") !== "" && scopeValue(scope) === "")
    scopeErr =
      `知らない scope「${String(scope)}」です（screen＝画面の窓／all＝収録の全体。` +
      "collection・full・window・catalog も受ける）。そのままの窓で出しました。";
  if (scopeValue(scope) === "all")
    return {
      list: allRows(),
      名: "収録の全体",
      生成: snapshot().snapshot_metadata?.generated_at,
      窓が無い: false,
    };
  const 窓 = screenRows();
  return 窓
    ? { list: 窓, 名: "画面が最初に読む窓", 生成: catalog()?.generated_at, 窓が無い: false }
    : /* 窓が無い時は收錄の全体を見るが、**其の旨を言はないと件數が配布先と違ふ理由が
       * 讀めない**（第 892 回 – 實測 2026-10-23: 品書をbuildして居ない手元では
       * `セキュリティ` が 37 件／42 件に割れた。黙って居ると AI は「畫面と違ふ」で躊く）。 */
      {
        list: allRows(),
        名: "収録の全体",
        生成: snapshot().snapshot_metadata?.generated_at,
        窓が無い: true,
      };
}

/** 窓が無い時の斷り（一覽を返す道具の頭に付ける）。空文字の時は何も足さない。 */
function 窓が無いの斷り(窓が無い: boolean): string {
  if (!窓が無い) return "";
  return (
    "※ 画面が最初に読む窓（public/catalog.json）がこの手元に無いので、収録の全体を読んでいます。" +
    "公開先の画面と同じ件数にするには、このリポジトリで `npm run build` してからお試しください。"
  );
}

const JST = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hour12: false,
});

/** 瞬間を日本時間で書く（畫面の日時欄と同じ読み）。`秒も` は締切の行だけ –
 * 畫面の「データ生成」は分までしか書かないので、同じ物は同じ書き方で出す。 */
function jst書(ms: number, 秒も: boolean): string {
  const parts = JST.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const 秒 = new Date(ms).getUTCSeconds();
  return `${get("year")}-${get("month")}-${get("day")}(${get("weekday")}) ${get("hour")}:${get("minute")}${
    秒も && 秒 ? `:${String(秒).padStart(2, "0")}` : ""
  } JST`;
}

function jst(ms: number): string {
  return jst書(ms, true);
}

/** 畫面の右上の「データ生成」と同じ書き方（分まで）。讀めない値は原文のまま返す
 * （畫面と同じ扱ひ – 勝手に日付を作らない）。 */
function 生成の表示(生成: unknown): string {
  const raw = typeof 生成 === "string" ? 生成.trim() : "";
  if (!raw) return "未確認";
  const at = Date.parse(raw);
  return Number.isFinite(at) ? jst書(at, false) : raw;
}

/** 畫面と同じ「データは N 日前」の斷り（生成から 3 日以上の時だけ）。**同じ函數から取る**ので、
 * 閾値も日数の數へ方も畫面と必ず一致する。 */
function 古さの斷り(生成: unknown, now: number): string {
  return String(Recommender.dataAgeNoteJa(生成, now) ?? "").trim();
}

/** ランクの語（畫面のランク列と同じ入口・同じ語）。無い行は畫面と同じく「ランク未確認」と
 * 書く – **書かないと、AI が「ランクが無い」と讀むか「此方の抜け」と讀むか決まらない**。 */
function ランクJa(r: Row): string {
  return (
    (r.rankPairs ?? [])
      .map((pair) => String(Recommender.rankPairLabelJa(pair) ?? "").trim())
      .filter(Boolean)
      .join("・") || `ランク${String(Recommender.unconfirmedLabelJa() ?? "未確認")}`
  );
}

/** 締切の行の**確認の状態**を、畫面と同じ語で數へる（第 868 回）。
 *
 * 「此の收錄は信用できるか」は研究者が最初に聞く事で、畫面は行ごとの札と行の詳細で答へて居る。
 * MCP は行ごとの札しか言はなかつたので、收錄全體の內譯（公式で確認済みが何行あるか）を
 * 答へられなかつた。語は畫面と同じ正本（`verificationStatusLabelTable`）から取る。 */
function 確認の內譯(rows: Row[]): string {
  const 表 = Recommender.verificationStatusLabelTable() as Record<string, string>;
  const 數 = new Map<string, number>();
  let 記録なし = 0;
  for (const r of rows) {
    const key = String(
      typeof r.dl?.verification === "string"
        ? r.dl.verification
        : ((r.dl?.verification as { status?: unknown } | undefined)?.status ?? ""),
    ).trim();
    if (!key) {
      記録なし += 1;
      continue;
    }
    const 語 = 表[key] || "再確認待ち";
    數.set(語, (數.get(語) ?? 0) + 1);
  }
  const 部 = [...數.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"))
    .map(([語, n]) => `${語} ${n} 行`);
  if (記録なし) 部.push(`確認の記録なし ${記録なし} 行`);
  return 部.join(" ／ ");
}

/** 1 行を 1 行の文字にする。**語は畫面の列と同じ入口から取る**（日時・種別・会議・ランク・
 * 会期・開催地）。並びは此方の都合（日時 → 種別 → 会議 → ランク → 会期 → 開催地）で、
 * 畫面の列の順其の侭ではない。 */
function line(r: Row, now: number): string {
  const 日 = r.dateOnly ? `${r.localDate}（時刻未確認）` : jst(r.t);
  const 殘り = Math.floor((r.t - now) / 86400000);
  const 殘り文 = r.dateOnly ? "" : ` 残り${殘り < 0 ? "（過ぎた）" : `${殘り}日`}`;
  const 種別 = String(Recommender.kindLabelJa(r.kind) ?? r.kind);
  const 回 = (r.dl.round ?? 1) > 1 ? ` R${r.dl.round}` : "";
  const 場所 = String(Recommender.placeJa(r.ed.place) ?? "").trim() || "未確認";
  const ランク = ランクJa(r);
  /* 一覧の行に付く**札**も入れる（畫面の列の外にある印 – 語も入口も畫面と同じ）。
   * ①延長（上流の締切名に Extended と付く行）②検証状態（確認済みと未設定では空 – 畫面も
   * 印を出さない）。「複数候補のため要確認」は上流に候補が複数あつて人が確かめるべき行で、
   * 此れを言はないと、AI が候補の一つを確定の締切として答へる。 */
  const 印 = [
    Recommender.isExtendedDeadline(r.dl) ? String(Recommender.extendedLabelJa() ?? "").trim() : "",
    String(Recommender.verificationStatusLabelJa(r.dl?.verification) ?? "").trim(),
  ].filter(Boolean);
  /* **會期も入れる**（畫面の「会期」列と同じ入口 `eventCellJa`）。出張の段取りは此れで決める
   * ので、締切だけ言へても足りん。決まって居ない行は畫面と同じ語（常時受付の期刊行は
   * 「該当なし」、それ以外は「未確認」）で書く – 默ると「無い」と讀まれる。 */
  const 會期 =
    String(Recommender.eventCellJa(r) ?? "").trim() ||
    String(
      Recommender.fieldNotApplicableJa(r)
        ? Recommender.notApplicableLabelJa()
        : Recommender.unconfirmedLabelJa(),
    );
  const 推定 = r.est ? "（推定）" : "";
  const 出典 = r.ed.link ? ` ${r.ed.link}` : "";
  /* 畫面の日時欄は「日本時間の読み」と「元の日時」の二段で出す。**日本時間で無い宣言**の行は、
   * 宣言した時間帯と瞬間（UTC）を添へる（實測 2026-10-06: `dl.tz_raw` は AoE・UTC-7・PDT・
   * JST など。`dl.aoe` は**何れの行にも在る派生値**なので、宣言を言ふには使へない）。*/
  const tz = String(r.dl.tz_raw ?? "").trim();
  const utc = String(r.dl.utc ?? "");
  const 元 =
    tz && utc && !/^JST$/i.test(tz)
      ? `（元の宣言 ${tz}／${utc.replace("T", " ").replace("Z", " UTC")}）`
      : "";
  return `${日}${殘り文}${元} | ${種別}${回}${推定}${印.length ? ` | ${印.join("・")}` : ""} | ${r.conf.title}（${r.ed.id}）| ${ランク} | 会期 ${會期} | ${場所}${出典}`;
}

/** 0 件の時に畫面が出す「打ち直すなら」と同じ物を組む（第 762 回）。
 *
 * **件數は照合そのもので數へる** – `shorterHitWordsJa` の件數は「行の文字に其の語が含まれるか」
 * で數へる爲、檢索の照合（語尾・助詞の扱ひ）と食ひ違ふ（實測 2026-10-06: 「デモが」を 7 件と
 * 數へるのに、其の語で引くと 0 件だつた）。同じ行集合・同じ照合で數へれば、**提案の件數と、
 * 其の語で引いた結果が必ず一致する**。0 件に成る候補は出さない（行き止まりへ送らない）。 */
function retypeTips(query: string, list: Row[], now: number): string[] {
  const 候補 = Recommender.shorterHitWordsJa(
    query,
    list.map((r) => r.hay),
    now,
  );
  const out: string[] = [];
  for (const hit of 候補) {
    const word = String(hit.word ?? "").trim();
    if (!word) continue;
    const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(word, now), now);
    const 件數 = list.filter((r) => 照合(r.hay) === true).length;
    if (!件數) continue;
    const how = String(hit.how ?? "");
    if (how === "split") out.push(`検索語を「${word}」に分けて打つ（両方を書く行が ${件數} 件）`);
    else if (how === "alone" && word.indexOf(" ") < 0)
      out.push(`検索語を「${word}」だけに絞る（${件數} 件当たります）`);
    else out.push(`検索語を「${word}」に打ち替える（${件數} 件当たります）`);
  }
  return out;
}

/** 0 件の時に畫面が出す案内と同じ物を組む（同じ函數から取る）。
 *
 * 第 873 回に欄の名前と「と」「や」の案内を足した。何れも**品書を持たないと答えられない問答**
 * （其の語だけで行が出るか）を伴ふので、行を持つ此方の側で答へて正典へ渡す（畫面の
 * `columnValueHitsJa`・`splitCountJa` と同じ筋 – 第 464・495・508 回）。 */
function guidance(query: string, matched: number, list: Row[], now: number): string[] {
  if (matched > 0) return [];
  const out: string[] = [];
  const whole = String(Recommender.wholeTableQueryNoteJa(query) ?? "").trim();
  if (whole) out.push(whole);
  Recommender.querySynonymNotes(query).forEach((note) => {
    if (note) out.push(String(note));
  });
  const word = String(Recommender.uiWordNoteJa(query, false) ?? "").trim();
  if (word) out.push(word);
  /* 語を照らすのは 1 描画に 1 度で足りる（同じ語を何度も分解しない）。 */
  const 照合を組む = (語: string): ((hay: string) => boolean) =>
    Recommender.searchMatcher(Recommender.expandRelativeMonths(語, now), now);
  /* 欄の名前（`分野` `種別` `会場` など）を打たれた人（第 244 回）。値ではないので、語を
   * 短くしても増えない – 値の例を名指して送る。 */
  const column = String(
    Recommender.columnQueryNoteJa(query, (語: string) =>
      list.some((r) => 照合を組む(語)(r.hay) === true),
    ) ?? "",
  ).trim();
  if (column) out.push(column);
  /* 二つの語を「と」「や」で繋いだ打ち方（第 612 回）。畫面と同じ順で、欄の名前・畫面自身の語・
   * 日數の幅の案内が立つ時は重ねない（同じ事を二度言はない – 畫面の `emptyDeadlineHint` と同じ）。 */
  const 日數の幅 = Boolean(String(Recommender.dayRangeNoteJa(query) ?? "").trim());
  if (!column && !word && !日數の幅) {
    const 件が当たるか = (文: string): number =>
      list.filter((r) => 照合を組む(文)(r.hay) === true).length;
    const conjunction = String(
      Recommender.conjunctionQueryNoteJa(query, 件が当たるか) ?? "",
    ).trim();
    if (conjunction) out.push(conjunction);
  }
  return out;
}

/* 日數の幅（「1か月以内」など）を打たれた人へ、**此の道具で引ける形**を返す（第 871 回）。
 *
 * 畫面は同じ時に「『締切まで』の選擇欄で『30 日以内』を選ぶと同じ話です」と送る
 * （`dayRangeNoteJa`）が、**此の道具に其の欄は無い**ので其の文は其の侭は使へない。代はりに、
 * 同じ幅を引ける**檢索語**を、其の語で實際に引いた件數つきで言ふ（第 762 回の「打ち直すなら」
 * と同じ約束 – 其の侭打ち直せる）。
 * 實測 2026-10-08（窓 870 行・固定時計 2026-10-08T12:00:00Z）: `1か月以内` は 0 件で案内も
 * 無く、同じ幅の `30日以内` は 90 件だつた。 */
function 日數幅の案内(
  query: string,
  list: Row[],
  now: number,
  args: Parameters<typeof 畫面の既定>[2],
): string[] {
  if (!String(Recommender.dayRangeNoteJa(query) ?? "").trim()) return [];
  const 日數 = Recommender.dayRangeDaysJa(query);
  /* 幅の終はりが書かれて居ない言ひ方（「3日前まで」）は、過去の幅なので絞らん（第 700 回）。 */
  if (日數 === null)
    return [
      "幅の終わりが書かれていない言い方（過去の幅）なので、検索語では絞りません。その範囲は過ぎています – include_past: true を付けると並びます。",
    ];
  /* 敎へるのは**此の道具の引數**（第 872 回に `within_days` を足した）。畫面の「締切まで」と
   * 同じ式で切るので、數へた件數は其の侭「其の引數で引いた件數」に成る（檢索語で代はるより正確 –
   * 檢索語の日數は締切の瞬間で數へるのに対し、窓は JST の暦日で切る）。 */
  const 件數 = 畫面の既定(list, now, { ...args, within_days: 日數 }).length;
  /* 時間・分の幅は日で丸める（此の表は締切を日單位で持つ – 畫面の同じ斷りと同じ事）。
   * 「3時間以内」に「同じ幅」と言ふと、丸めた事が傳はらん。 */
  const 丸め =
    /時間|分/.test(query) && 日數 <= 1
      ? " この表は締切を日単位で持つので、時間・分の幅は日で丸めます。"
      : "";
  if (件數)
    return [
      `日数の幅はそのままでは検索語に当たりません（画面は「締切まで」の選択欄で選びます）。語を省いて \`within_days: ${日數}\` で引けます（${件數} 件当たります）。${丸め}`.trimEnd(),
    ];
  return [
    `日数の幅はそのままでは検索語に当たりません。語を省いて \`within_days: ${日數}\` で引けますが、いまの絞り込みでは 0 件です。${丸め}`.trimEnd(),
  ];
}

/** 一覧の中で一番遠い締切の日（JST の暦日。畫面の `farthestRowDayJa` と同じ物を、
 * 此方の行の形で數へる）。時刻を持たん行は數へない。 */
function 一番遠い日(list: Row[]): string {
  let best = Number.NEGATIVE_INFINITY;
  for (const r of list) {
    const shown = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
    if (typeof shown !== "number" || !Number.isFinite(shown)) continue;
    if (shown > best) best = shown;
  }
  if (!Number.isFinite(best)) return "";
  /* JST の暦日（オフセットは此處に置く – 畫面と同じ數へ方）。 */
  const jst = new Date(best + 9 * 3600000);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
}

/* 打った日付が、いま見て居る窓・收錄の果ての何れより先か（第 293 回の畫面と同じ事）。
 *
 * 畫面は「收錄の全體を読み込む」を押す樣に言ふが、此の道具では `scope: "all"` が其れに
 * 當たる。**收錄の果てより先なら「無い」とは言はない** – 其の日に締切が在るかどうかは、
 * 此方は知らん（第 293 回の決めごと。AI に「其の日の締切は無い」と斷定させない）。
 * 實測 2026-10-09（窓 870 行・收錄 5,069 行）: 窓の果ては 2027-02-04・收錄の果ては
 * 2028-06-05 で、`2028年9月` は窓でも收錄でも 0 件・案内も無かつた（「無い」と讀めてしまふ。
 * 同じ日付でも `2028年3月` は收錄に 3 行在るので、第 869 回の窓の外の案内が受け持つ）。 */
function 果ての案内(query: string, list: Row[], 名: string): string {
  const span = Recommender.queryDaySpanJa(query);
  if (!span?.first) return "";
  const 窓の果て = 名 === "画面が最初に読む窓" ? 一番遠い日(list) : "";
  const 收錄の果て = 一番遠い日(allRows());
  if (窓の果て && span.first > 窓の果て) {
    if (收錄の果て && span.first > 收錄の果て)
      return `打った日付「${span.label}」は、収録している中で一番遠い締切 ${收錄の果て} より先です。その日付に締切があるかどうかも、まだ確認できていません。`;
    return `打った日付「${span.label}」は、いま見ている窓（${窓の果て} まで）より先です。scope: "all" で引くと、その先も探します${收錄の果て ? `（収録の中で一番遠い締切は ${收錄の果て} です）` : ""}。`;
  }
  if (收錄の果て && span.first > 收錄の果て)
    return `打った日付「${span.label}」は、収録している中で一番遠い締切 ${收錄の果て} より先です。その日付に締切があるかどうかも、まだ確認できていません。`;
  return "";
}

/** 數の引數を讀む。**使へない値を默つて既定に戻さない**（第 878 回）。
 *
 * 實測 2026-10-13: `search_deadlines({within_days: 0})` は窓が掛からずに 214 件を返して居た
 * – 「0 日以内」の問に 214 件と答へる形で、しかも其の值が無視された事をどこにも書いて居なかつた
 * （`list_upcoming({days: "abc"})` も既定の 30 日に默つて戻る）。知らない種別・知らないランクを
 * 頭で名指すのと同じ扱ひにした（第 727・858 回）。省かれた時は `使ふ` が null（何も言はない）。 */
function 數の引數(
  名: string,
  値: unknown,
  最小: number,
): { 使ふ: number | null; 斷り: string; 省かれた: boolean } {
  if (値 === undefined || 値 === null || String(値).trim() === "")
    return { 使ふ: null, 斷り: "", 省かれた: true };
  const n = Number(値);
  if (!Number.isFinite(n) || n < 最小)
    return {
      使ふ: null,
      斷り: `／${名} は ${最小} 以上の数で指定してください（いま ${JSON.stringify(値)}）。其の値は使はないので、既定の儘引きます`,
      省かれた: false,
    };
  return { 使ふ: n, 斷り: "", 省かれた: false };
}

/** 真偽の引數（第 909 回）。
 *
 * schema は boolean と書いてあるが、實測 2026-11-01 では `"true"` / `1` / `"yes"` を渡しても
 * **`=== true` の比較一つで黙って外れて居た** – `include_past: "true"` は 89 件のはずが 37 件に
 * なり、AI は「過去の締切を出した中得到 37 件」と返る（絞り込みが付かないのに Reasons を
 * 言わない）。數の引數（第 878 回）と同じ扱いにした – 読める形は其れで受け、讀めない形は
 * **名指す**。 */
function 真偽の引數(名: string, 値: unknown): { 使ふ: boolean; 斷り: string } {
  if (値 === undefined || 値 === null || String(値).trim() === "") return { 使ふ: false, 斷り: "" };
  if (typeof 値 === "boolean") return { 使ふ: 値, 斷り: "" };
  const 語 = String(値).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(語)) return { 使ふ: true, 斷り: "" };
  if (["false", "0", "no", "off"].includes(語)) return { 使ふ: false, 斷り: "" };
  if (語 === "真") return { 使ふ: true, 斷り: "" };
  if (語 === "偽") return { 使ふ: false, 斷り: "" };
  return {
    使ふ: false,
    斷り: `／${名} は true か false で指定してください（いま ${JSON.stringify(値)}）。其の値は使はないので、既定の儘扱います`,
  };
}

/* 畫面の既定の一覧と同じ絞り込み（第 714 回）。**同じ數字を返す**のが此の道具の値打ちなので、
 * 畫面が既定で隠して居る物（過去の締切・投稿締切以外の種別・推定）は此處でも隠す。
 * 隱した件數は頭に書く（默つて減らすと、AI が「37 件」と言つて人が「722 件」と見る）。 */
const 投稿の種別 = ["abstract", "paper", "journal"];

function 畫面の既定(
  list: Row[],
  now: number,
  args: {
    include_past?: unknown;
    kinds?: unknown;
    include_estimated?: unknown;
    rank?: unknown;
    domestic?: unknown;
    online?: unknown;
    /** 「締切まで N 日」の窓（畫面の同じ名前の選擇欄。第 872 回）。 */
    within_days?: unknown;
  },
): Row[] {
  const 過去も = args.include_past === true;
  const 窓の日數 = Number(args.within_days);
  const 窓あり = Number.isFinite(窓の日數) && 窓の日數 > 0;
  const 推定も = args.include_estimated === true;
  const 引き = args.kinds ?? (args as { kind?: unknown }).kind;
  const 種別 = Array.isArray(引き)
    ? 引き.map((k) => String(k))
    : typeof 引き === "string"
      ? [引き]
      : null;
  /* `kinds: ["all"]`（又は `"all"`）は**種別で絞らん**の意（第 727 回 – 實測 2026-10-06:
   * 此れを彈いて居たので、全ての種別を見る道が無く、「kinds を試してください」と言はれても
   * 試す物が無かつた）。未知のキーは其の侭では 0 件に成るので、誤りに氣付ける樣に下で知らせる。*/
  const 全部 = 種別?.some((k) => k.toLowerCase() === "all") ?? false;
  const 知らん = (種別 ?? []).filter(
    (k) =>
      !投稿の種別.includes(k) &&
      ![
        "all",
        "notification",
        "camera_ready",
        "registration",
        "rebuttal_start",
        "rebuttal_end",
        "review_release",
        "supplementary",
        "other",
      ].includes(k),
  );
  /* ランクは畫面の選擇欄と同じ**等級の厳密比較**（`A` を選んで `core:A*` を巻き込まない –
   * 第 726 回に畫面で直した其の判定を其の侭使ふ）。値は `A*` `A` `B` `C` `N`。 */
  const ランク = String((args as { rank?: unknown }).rank ?? "").trim();
  /* 畫面のチェック欄（「国内研究会・国内シンポジウムのみ」「オンライン参加可のみ」）と
   * **同じ判定**を持つ（第 865 回）。語で引いても同じ集合に成る事は實測したが、AI が
   * 魔法の語を知らないと使へない – 引數にすれば、畫面のボタンと同じ物が其の侭使へる。 */
  const 國內だけ = args.domestic === true;
  const オンラインだけ = args.online === true;
  /* 窓は**畫面と同じ式**で切る（`Recommender.withinDaysLimitMs` – 同じ日に同じ行を出す）。
   * 比べるのは「表示して居る暦日」（`tShown`。無ければ `t`）で、畫面の `rowShownDayMs` と同じ。
   * 過去も出す時は下側も効かせる（第 202 回の畫面と同じ – 上側だけだと 2019 年まで殘り、
   * 窓が意味を失ふ）。 */
  const 窓の上限 = 窓あり ? Recommender.withinDaysLimitMs(窓の日數, now) : 0;
  const 窓の下限 = 窓あり && 過去も ? Recommender.withinDaysFloorMs(窓の日數, now) : 0;
  return list
    .filter((r) => {
      if (!過去も && r.t < now) return false;
      if (!推定も && r.est) return false;
      if (窓あり) {
        const 日 = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
        if (日 >= 窓の上限) return false;
        if (窓の下限 && 日 < 窓の下限) return false;
      }
      if (ランク && !Recommender.rankMatches(r.rankPairs ?? [], ランク)) return false;
      /* 國內は**主催の區分**（日本で開かれる會議ではない）。判定は畫面と同じタグ一本。 */
      if (國內だけ && (r.tags ?? []).indexOf("domestic-jp") < 0) return false;
      /* オンラインは會場の表記から畫面と同じ函數で見る。 */
      if (オンラインだけ && !Recommender.placeOffersOnline(r.ed.place)) return false;
      if (全部) return true;
      if (種別 && 種別.length) return 種別.includes(r.kind);
      return 投稿の種別.includes(r.kind);
    })
    .concat(知らん.length ? [] : []);
}

/** 窓（畫面が最初に讀む 180 日）で 0 件の時、**收錄の全體**に何行あるかを數へる（第 869 回）。
 *
 * 畫面は窓の外の締切を「收錄の全體を読み込む」で出せる（第 290 回）。MCP にも `scope: "all"` が
 * あるのに、窓で 0 件の時に其の事を言はなかつた – 「2028 年」で引くと 0 件とだけ返り、
 * **AI が「2028 年の締切は無い」と答へてしまふ**（實測 2026-10-08: 窓 0 行・收錄の全體 12 行）。 */
function 窓の外の件數(照合: (hay: string) => boolean, 名: string): number {
  if (名 !== "画面が最初に読む窓") return 0;
  return allRows().filter((r) => 照合(r.hay) === true).length;
}

/** 名前の殼の中で、語が**獨立に立つ**か（英數字は前後が區切りの事を要求する – `sc` が
 * `science` や `isca` に當たらない。畫面の `nameOnlyConferenceMatch` と同じ規則）。 */
function 名前に立つ(語: string, 殼: string): boolean {
  const t = 語.toLowerCase();
  if (!/^[a-z0-9][a-z0-9 .+-]*$/u.test(t)) return 殼.indexOf(t) >= 0;
  const 文字 = /[a-z0-9]/u;
  let at = 殼.indexOf(t);
  while (at >= 0) {
    const 前 = at > 0 ? 殼.charAt(at - 1) : " ";
    const 後 = at + t.length < 殼.length ? 殼.charAt(at + t.length) : " ";
    if (!文字.test(前) && !文字.test(後)) return true;
    at = 殼.indexOf(t, at + 1);
  }
  return false;
}

/** 語を並べて打つて 0 件の時、**どの語が收錄に無いか**を言ふ（第 880 回）。
 *
 * 畫面は「検索語のうち『GPU』は収録データにも見当たりません。その語を外すと増えます」と言ふ
 * （第 258 回）。MCP は「打ち直すなら『ネットワーク』だけに絞る（20 件）」とだけ返して居た –
 * どちらが足りんのかは分かるが、**收錄が其の語を一つも持たん事**が讀めない。實測
 * 2026-10-15: `ネットワーク GPU` は GPU が窓 0 行・收錄 0 行（`gpu` の語がどこにも無い）。
 *
 * 件數は畫面と同じ正典（`Recommender.queryTermCounts`）で、**同じ行の集合**を數へる。 */
function 語ごとの案號(query: string, list: Row[], now: number): string[] {
  /* URL を貼つた人には**ドメインの部品を語として扱はない**（畫面が `termNote` を `!filter.urlQuery`
   * で閉じて居るのと同じ – 第 153 回）。實測 2026-10-16: `https://icde2027.example.org/cfp` に
   * 「『example』は収録データにも見当たりません」と出て居た – 分解された語はドメインの一部で、
   * 檢索の失敗理由では無い。 */
  if (Recommender.looksLikeUrlQuery(query)) return [];
  const 件數 = Recommender.queryTermCounts(
    Recommender.expandRelativeMonths(query, now),
    list.map((r) => r.hay),
    now,
  );
  if (件數.length < 2) return []; // 語が一つの時は他の家（打ち直し・種別の話）が受持ちを持つ。
  const 死んだ語 = 件數.filter((t) => t.count === 0).map((t) => t.term);
  const 殘り = 件數.filter((t) => t.count > 0);
  if (死んだ語.length) {
    /* 總ての語が死語なら「外すと増えます」とは言はない（外した殘りは空に成る）。 */
    const 外しても = 死んだ語.length === 件數.length ? "" : "その語を外すと増えます。";
    return [
      `検索語のうち${死んだ語
        .slice(0, 2)
        .map((w) => `「${w}」`)
        .join("・")}は収録データにも見当たりません。${外しても}`,
    ];
  }
  /* どれも收錄に在るのに「全部を含む行」が無い時 – 語ごとの件數を出して、どれを外すか選ばせる。 */
  if (殘り.length === 件數.length)
    return [
      `語をすべて含む行はありません（${件數
        .slice(0, 3)
        .map((t) => `「${t.term}」${t.count}件`)
        .join("・")}）。いずれかの語を外すと増えます。`,
    ];
  return [];
}

/** 表に出さない種別（採否通知・カメラレディ締切など）の**語**が打たれた時、其の種別の名を返す
 * （第 879 回）。畫面は「検索語は「採否通知」の種別に當たります（表には投稿締切だけを出します）」
 * と言ふ（第 244 回）– 外せる條件を並べる前に、**何が 0 件の原因か**を言ふ。MCP は默つて居た
 * （實測 2026-10-14: `カメラレディ` は既定の絞り込みで 0 件だが、其の種別が存在する事が
 * どこにも書かれない – AI は「カメラレディの締切は收錄に無い」と受け取る）。 */
function 隱れた種別の語(query: string): string[] {
  const table = Recommender.kindLabelTable();
  const 表に出さん種別 = Object.keys(table)
    .filter((kind) => 投稿の種別.indexOf(kind) < 0 && kind !== "all")
    .map((kind) => String(table[kind] || ""));
  return Recommender.queryHiddenKindMatches(query, 表に出さん種別);
}

/** 何の當たりも無い問への受皿（畫面の 0 件案內と同じ二つを言ふ・第 884 回）。
 *
 * 畫面は「分野名・主題・開催地の日本語でも引けます」に落ちる打ち手へ、
 * ①**この表が何を出す画面なのか**（催し物の名前・締切の日・分野・種別・開催地・参加形式 –
 *  第 240 回）、②**分野の欄が何を幾つ持つか**（第 679 回 – `脳科学` の樣な情報處理の
 *  九分野外の語でも空振りさせない爲に名前を並べる）を一筆置く。MCP は默つて居た –
 *  實測 2026-10-18: `脳科学` は見出しと古さの斷りしか返さなかつた。
 *
 * 分野の名は品書（`DATA.categories`）から數へる – 硬直の一覽を書くと增えた分野が落ちる。 */
function 受皿の案內(): string[] {
  /* 品書が持つ分野の地圖（`catalog.json` の `categories`）を、**畫面のと同じ順・同じ札**で
   * 並べる（品書はそれを見てチツプを出す – 此方が別に拾ふと增えた分野が落ちる）。 */
  const 地圖 = (catalog()?.categories ?? {}) as Record<string, string>;
  const 分野 = Object.keys(地圖)
    .sort((a, b) => {
      const la = Recommender.categoryChipLabelJa(a, String(地圖[a] || ""));
      const lb = Recommender.categoryChipLabelJa(b, String(地圖[b] || ""));
      return la.localeCompare(lb, "ja") || a.localeCompare(b);
    })
    .map((key) => Recommender.categoryChipLabelJa(key, String(地圖[key] || "")));
  const 受皿 =
    "別の語で試す（分野名・主題・開催地の日本語でも引けます）。" +
    (分野.length
      ? `分野の欄は${分野.join("・")}の${分野.length}種だけで、他の分野の言葉でも其の語を行に持つ締切なら当たります。`
      : "") +
    "この表が出すのは催し物の名前・締切の日・分野・種別・開催地・参加形式で、くわしくは画面の『見方のてびき』に書いています";
  return [受皿];
}

/** URL を貼つた人へ、**收錄の中心**を言ふ（第 881 回）。
 *
 * 畫面は「検索語の URL の会議は収録に見当かりません。収録の中心はランク付けの一覧に載る会議と
 * 国内研究会です。公式ページのアドレスではなく会議名（「ICDE」など）で試してください」と言ふ
 * （第 153 回 – 打つた文字列を「語が無い」と言つても收錄の範圍が傳はらない）。MCP は默つて居た。
 * 讀み上げの `zeroResultLiveNote` と同じ文なので、rep（目）と讀み上げで食ひ違はない。 */
function URLの案内(query: string): string[] {
  if (!Recommender.looksLikeUrlQuery(query)) return [];
  return [
    "検索語の URL の会議は収録に見当たりません。収録の中心はランク付けの一覧に載る会議と国内研究会です。公式ページのアドレスではなく会議名（「ICDE」など）で試してください。",
  ];
}

/** 表に出さん種別の語が打たれた時の文（第 879 回・第 888 回）。
 *
 * `search_deadlines` と `explain_word` の**兩方**が出す（書き寫すと、片方だけが古くなる –
 * 實測 2026-10-21: 檢索は `kinds: ["camera_ready"]` を教へて居たのに、語を調べる方は默つて居た）。
 * 件數は**其の指定で實際に引いた數**（第 762 回と同じ約束 – 其の儘打ち直せる）。 */
function 種別の報べ(
  query: string,
  list: Row[],
  now: number,
  args: Record<string, unknown> | undefined,
  // 素で當たつた行（無ければ其の窓の行）の中から、その種別だけの行で數へる。
  素の?: Row[],
): string[] {
  const 種別の語 = 隱れた種別の語(query);
  if (!種別の語.length) return [];
  const 選べる = 種別の語.map((語) => `「${語}」`).join("・");
  /* 種別の鍵に直す（表示の語から – 增えた種別が落ちない様に選びの表から引く）。 */
  const 鍵々 = 種別の語
    .map((語) =>
      Object.keys(Recommender.kindLabelTable()).find((k) => Recommender.kindLabelTable()[k] === 語),
    )
    .filter((k): k is string => Boolean(k));
  if (!鍵々.length) return [];
  const 件數 = 畫面の既定(素の ?? list, now, { ...(args ?? {}), kinds: 鍵々 }).length;
  return [
    `検索語は${選べる}の種別に当たります（表には投稿締切だけを出します）。kinds: ${JSON.stringify(鍵々)} で引けます（${件數} 件当たります）。`,
  ];
}

/** 語が 0 件の時、**収録の會議の名前**に當たつて居ないかを見る（第 867 回）。
 *
 * 畫面の 0 件案内は「名簿に在るのに締切の行が 1 本も無い會議」を名指す（第 294 回）が、
 * 其の計算は畫面の側に在り、MCP は Recommender 層の案内しか使つて居なかつた – 締切を持たん
 * 會議の名前で引くと「1 行も出ません」とだけ言ひ、**収録に在る事**も、會期が何處に載るかも
 * 言はなかつた（實測 2026-10-08: `apnoms` は版 1 件・會期ありで upcoming.md に載つて居る）。 */
function 名乘りの案内(query: string, list: Row[]): string[] {
  /* URL を貼つた人にも、ドメインの部品を會議の名として扱はない（畫面は名簿の問を空白で切るので、
   * URL は一つの語の儘で名前に當たらない – 第 153 回）。此方は `/` でも切るので、其の儘だと
   * 「cfp に似た名前の会議」の樣な部品の話が出てしまふ。 */
  if (Recommender.looksLikeUrlQuery(query)) return [];
  /* 打たれた形を憶えて置く（名簿の案内に、打つた通りの字で出す – 小致しにして示さない）。 */
  const 原の語々 = query
    .split(/[\s、。，,・/|（）()「」『』【】]+/)
    .map((w) => w.trim())
    .filter((w) => [...w].length >= 2);
  const 語々 = 原の語々.map((w) => w.toLowerCase());
  if (!語々.length) return [];
  /* 數字と日付の部品だけの語（`2027` `2027年` `3月`）は、締切の日の指定として打ち足された物と
   * 見る（第 296 回の畫面と同じ規則）。年の語を名前の語として要求すると、名前に年を含まん
   * 會議が全部落ちる – 實測 2026-10-11: `ACSAC 2027` は收錄 0 行で案内も無し（畫面は
   * 「打った語に似た名前の会議（ACSAC）は、収録の名簿に見えます」と言ふ）。 */
  const 名前の語 = 語々.filter((w) => !(/\d/u.test(w) && /^[\d\s./\-年月日時分秒週周]+$/u.test(w)));
  if (!名前の語.length) return [];
  const 行の鍵 = new Set(list.map((r) => String(r.conf.key ?? "")));
  const 會議々 = snapshot().conferences ?? [];
  const 名前の殼 = (c: Record<string, unknown>): string =>
    [String(c.key ?? ""), String(c.title ?? ""), String(c.acronym ?? ""), String(c.full_name ?? "")]
      .join(" ")
      .toLowerCase();
  const 當たる = 會議々.filter((c) => 名前の語.every((w) => 名前に立つ(w, 名前の殼(c))));
  if (!當たる.length) {
    /* 名前にその語は見えるが、**全部の語に當たる會議が無い**時も、語は名簿に在る事を言ふ
     * （第 294 回の「無い」の列から外す話はここでも生きる）。「いずれかの語を外すと増えます」
     * だけでは、引いた会議の締切が読み込めて居ない事が傳はらない。 */
    const 見える語 = 名前の語.filter((w) => 會議々.some((c) => 名前に立つ(w, 名前の殼(c))));
    if (!見える語.length) return [];
    /* 打たれた形で示す（小致しにすると、別の言ひ方をして居る樣に見える）。 */
    const 原に戻す = (w: string): string => 原の語々.find((x) => x.toLowerCase() === w) ?? w;
    return [
      `収録の名簿に、その語に似た名前の会議は在ります（${見える語
        .map((w) => `「${原に戻す(w)}」`)
        .join("・")}）。`,
    ];
  }
  const 見本 = 當たる.slice(0, 3).map((c) => {
    const key = String(c.key ?? "");
    const 版々 = Array.isArray(c.editions) ? c.editions : [];
    const 會期あり = 版々.some((e) =>
      String((e as { event_start?: unknown } | null)?.event_start ?? "").trim(),
    );
    const 狀態 = 行の鍵.has(key)
      ? "締切の行は在りますが、いまの絞り込みで 0 件に成つて居ます（絞り込みを外すと出ます）"
      : 會期あり
        ? "締切の行が 1 本もありません（会期だけが収録に在り、upcoming.md とカレンダーには「開催」として載ります）"
        : "締切の行が 1 本もありません（会期も確認できて居ません）";
    return `- ${String(c.title ?? key)}（key: ${key}・版 ${版々.length} 件）: ${狀態}`;
  });
  return [
    `収録の会議の名前には ${當たる.length} 件当たります:`,
    ...見本,
    ...(當たる.length > 見本.length ? [`- ほか ${當たる.length - 見本.length} 件`] : []),
  ];
}

function sortRows(list: Row[]): Row[] {
  return list.slice().sort((a, b) => a.t - b.t || a.conf.title.localeCompare(b.conf.title, "ja"));
}

/* ---- 道具 ---- */

function searchDeadlines(
  args: {
    query?: unknown;
    limit?: unknown;
    include_past?: unknown;
    include_estimated?: unknown;
    kinds?: unknown;
    kind?: unknown;
    rank?: unknown;
    domestic?: unknown;
    online?: unknown;
    within_days?: unknown;
    scope?: unknown;
  },
  now: number,
): string {
  /* 真偽の引數を**一度だけ**読み、読める形に直す（第 909 回 – `include_past: "true"` は
   * `=== true` の比較一つで黙って外れて居た。數の引數（第 878 回）と同じ扱ひ）。 */
  const 真偽 = {
    include_past: 真偽の引數("include_past", args.include_past),
    include_estimated: 真偽の引數("include_estimated", args.include_estimated),
    domestic: 真偽の引數("domestic", args.domestic),
    online: 真偽の引數("online", args.online),
  };
  /* 絞り込みは**正規化した引數**で見る（下の判定は `=== true` だけ – 一箇所で直す）。
   * **在った引數だけ**書き戻す（省いた物を false にしてしまうと、「絞り込みを指定した」判定が
   *  – 語も絞り込みも無ければ「検索語が空です」と返す筈が、行を返して居た）。 */
  const _ARGS = args;
  args = {
    ...args,
    ...(_ARGS.include_past !== undefined ? { include_past: 真偽.include_past.使ふ } : {}),
    ...(_ARGS.include_estimated !== undefined
      ? { include_estimated: 真偽.include_estimated.使ふ }
      : {}),
    ...(_ARGS.domestic !== undefined ? { domestic: 真偽.domestic.使ふ } : {}),
    ...(_ARGS.online !== undefined ? { online: 真偽.online.使ふ } : {}),
  };
  const query = String(args.query ?? "").trim();
  /* 語が空でも**絞り込みを指定して居れば**引ける（第 793 回 – 實測 2026-10-06: 「登録締切を全部
   * 見たい」と云ふ聞き方に答へられなかつた。第 865 回に `rank`・`domestic`・`online` へ廣げた –
   * 「國內の締切を全部」も同じ形の聞き方）。語も絞り込みも無い時だけ斷る。 */
  const 絞り込みだけ =
    !query &&
    (args.kind !== undefined ||
      args.kinds !== undefined ||
      args.rank !== undefined ||
      args.domestic !== undefined ||
      args.online !== undefined ||
      args.within_days !== undefined);
  if (!query && !絞り込みだけ)
    return "検索語が空です。会議名・分野・開催地・締切の語をください（語を省くなら kind / kinds / rank / domestic / online / within_days の何れかを添へてください）。";
  const 限り = 數の引數("limit", args.limit, 1);
  const limit = Math.min(限り.使ふ ?? 20, 100);
  /* 「締切まで N 日」の窓（畫面の同じ名前の選擇欄と同じ物。第 872 回）。頭にも言ふ –
   * 窓で切つた事を默ると、AI が「これで全部」と讀む。使へない値は其の旨を言ふ（第 878 回）。 */
  const 窓の引數 = 數の引數("within_days", args.within_days, 1);
  const 窓の日數 = 窓の引數.使ふ;
  const 窓あり = 窓の日數 !== null;
  const 讀めない引數 = [
    限り.斷り,
    窓の引數.斷り,
    真偽.include_past.斷り,
    真偽.include_estimated.斷り,
    真偽.domestic.斷り,
    真偽.online.斷り,
  ]
    .filter((t) => t)
    .join("");
  const { list, 名, 生成, 窓が無い } = pick(args.scope);
  const 古さ = 古さの斷り(生成, now);
  /* 語が空（種別だけの時）は**全部に當たる**目にする（第 793 回）。 */
  const 照合 = 絞り込みだけ
    ? () => true
    : Recommender.searchMatcher(Recommender.expandRelativeMonths(query, now), now);
  const 素の = list.filter((r) => 照合(r.hay) === true);
  const 窓の外 = 素の.length ? 0 : 窓の外の件數(照合, 名);
  const hit = sortRows(畫面の既定(素の, now, args));
  const 知って居る種別 = [
    "all",
    ...投稿の種別,
    "notification",
    "camera_ready",
    "registration",
    "rebuttal_start",
    "rebuttal_end",
    "review_release",
    "supplementary",
    "other",
  ];
  const 知らん = (Array.isArray(args.kinds) ? args.kinds.map((k) => String(k)) : []).filter(
    (k) => !知って居る種別.includes(k),
  );
  /* 知らない等級も名指す（`A+` の樣な無い値は、其の侭では 0 件に成る – AI が打ち直せる樣に）。 */
  const ランク = String(args.rank ?? "").trim();
  const 知らんランク = ランク && !Recommender.rankGradeOrderJa().includes(ランク) ? ランク : "";
  /* 日付は日本時間で出す。**元の表記が別の日の事が在る**ので、月で引いた時に表示の月がずれる
   * 行が在る（實測 2026-10-06: `9月` で引いた行が「2026-10-16(金) 20:59 JST」と出る – 元の
   * 表記は AoE で 9 月 30 日）。AI が其のまま「10 月」と答へん樣に、頭で斷つて置く。*/
  /* 日付の斷りは**日付を聞いた時だけ**書く（第 749 回 – 初めは每回書いて居たので、`KDD` の樣な
   * 語の檢索にも關係無い斷りが付いて居た。雜音は、要る所でだけ言ふ）。*/
  const 日付の語 =
    /(?:\d+月|\d+日|今月|来月|先月|今週|来週|先週|今年|来年|年内|年度|以内|までに|以降)/.test(
      query,
    );
  const 頭 = `${絞り込みだけ ? "語を指定せず、絞り込みだけ" : `検索語「${query}」に当たる締切`}: ${hit.length} 件（${名} ${list.length} 行・画面の既定と同じ絞り込み。絞る前は ${素の.length} 行${ランク ? `／ランク ${ランク}` : ""}${args.domestic === true ? "／国内のみ" : ""}${args.online === true ? "／オンライン参加可のみ" : ""}${窓あり ? `／締切まで ${窓の日數} 日以内` : ""}${讀めない引數}）${知らん.length ? `／知らない種別（其の侭では 0 件に成ります）: ${知らん.join("・")}` : ""}${知らんランク ? `／知らないランク（等級は ${Recommender.rankGradeOrderJa().join("・")}）: ${知らんランク}` : ""}${日付の語 ? "\n日付は日本時間（JST）。月や日付の語は、締切の日付と「会期」の日付の両方に当たる（画面のてびきと同じ約束）ので、月で引いた時に見出しの月と違ふ日が出る行が在る。" : ""}${窓が無い ? `\n${窓が無いの斷り(true)}` : ""}${scopeErr ? `\n${scopeErr}` : ""}`;
  if (!hit.length) {
    /* 畫面と同じ約束 – 案内は「素の當たりが 0」の時に出る物なので、絞り込みで 0 に成つた時は
     * 其の旨を書く（絞り込みを外せば出る事がある）。 */
    const 案内 = 素の.length ? [] : guidance(query, 0, list, now);
    /* 收錄の果てより先の日付を打たれた時は「無い」と言はない（第 293 回の畫面と同じ）。
     * 窓の外に行が在る時は其の案内が同じ事を言ふので、重ねない。 */
    const 果て = 素の.length || 窓の外 ? "" : 果ての案内(query, list, 名);
    return [
      頭,
      "",
      素の.length
        ? `語は当たりますが、既定の絞り込み（今後の投稿締切・推定を除く）で 0 件に成りました。include_past / include_estimated / kinds${ランク ? " / rank（いま " + ランク + "）" : ""} を試してください。`
        : 窓の外
          ? `この語は画面が最初に読む窓（${list.length} 行）には 1 行もありませんが、**収録の全体には ${窓の外} 行あります**（scope: "all" で引けます）。`
          : (果て ?? "この語では 1 行も出ません。"),
      /* 表に出さん種別の語が打たれて居たら、其の種別が在る事を言ふ（第 879 回）。
       * 打ち直す手が `kinds` なので、何を選べばいいかが其の儘分かる。 */
      ...(() => {
        /* 見える結果が 0 の時に出す（畫面の `kindNote` は raw の當たりを條件にしない –
         * `hiddenKindQueryWords` は語だけで決まる）。此のブロツクは既に `!hit.length` の中。 */
        const 種別の語 = 隱れた種別の語(query);
        if (!種別の語.length) return [];
        const 選べる = 種別の語.map((語) => `「${語}」`).join("・");
        /* 種別の鍵に直す。 */
        const 鍵々 = 種別の語
          .map((語) =>
            Object.keys(Recommender.kindLabelTable()).find(
              (k) => Recommender.kindLabelTable()[k] === 語,
            ),
          )
          .filter((k): k is string => Boolean(k));
        if (!鍵々.length) return [];
        /* **其の指定で何件出るか**を實際に數へる（第 762 回と同じ約束 – 其の儘打ち直せる）。
         * 素で當たつた行を、その種別だけにした畫面の既定へ通す。 */
        const 件數 = 畫面の既定(素の, now, { ...args, kinds: 鍵々 }).length;
        return [
          `検索語は${選べる}の種別に当たります（表には投稿締切だけを出します）。kinds: ${JSON.stringify(鍵々)} で引けます（${件數} 件当たります）。`,
        ];
      })(),
      ...語ごとの案號(query, list, now),
      ...(素の.length ? [] : URLの案内(query)),
      ...案内.map((n) => `案内: ${n}`),
      /* 日數の幅（「1か月以内」）は畫面の「締切まで」と同じ引數（`within_days`・第 872 回）を
       * 件數つきで言ふ（第 871 回）。 */
      ...(素の.length ? [] : 日數幅の案内(query, list, now, args)),
      /* どの案内にも當たらなかつた問（畫面の「別の語で試す」に落ちる打ち手）には、
       * この表が何を出す画面なのかと、分野の欄の名前を言ふ（第 884 回）。 */
      ...(() => {
        if (案内.length || 日數幅の案内(query, list, now, args).length) return [];
        if (窓の外 || 果て) return [];
        if (名乘りの案内(query, list).length) return [];
        if (URLの案内(query).length) return [];
        if (隱れた種別の語(query).length) return [];
        if (語ごとの案號(query, list, now).length) return [];
        const 手 = retypeTips(query, 畫面の既定(list, now, args), now);
        if (手.length) return []; // 「打ち直すなら」が立つ時は其方に讓る（重ねて二度言はない）。
        return 受皿の案內();
      })(),
      /* 名簿の案内は**見える結果が 0 の時**に出す（畫面と同じ – 畫面は raw の當たりが在つても、
       * 既定の絞り込みで 0 件に成つた時に名簿を名指す。實測 2026-10-11: `情報処理学会 HPC 研究會` は
       * 窓に 4 行當たるが、既定の絞り込みで 0 件 – MCP は「include_past を試して」だけを返して居た）。 */
      ...名乘りの案内(query, list),
      ...(() => {
        if (素の.length) return [];
        const 手 = retypeTips(query, 畫面の既定(list, now, args), now);
        return 手.length ? [`打ち直すなら ${手.join(" / ")}`] : [];
      })(),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  const 見本 = hit.slice(0, limit).map((r) => line(r, now));
  return [
    頭,
    `（日本時間の早い順。${limit} 件まで表示${hit.length > limit ? `・残り ${hit.length - limit} 件` : ""}）`,
    "",
    ...見本,
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

function listUpcoming(
  args: { days?: unknown; kind?: unknown; scope?: unknown },
  now: number,
): string {
  const 日數の引數 = 數の引數("days", args.days, 1);
  const 使ふ日數 = 日數の引數.使ふ;
  const days = Math.min(使ふ日數 ?? 30, 400);
  const 讀めない引數 = 日數の引數.斷り;
  /* 使へない値を貰つた時は「既定の N 日」と書く（默つて 30 日を假定しない）。省かれた時は
   * 其の儘「N 日以内」（省略した人に「既定」と囘りくどく言はない）。 */
  const 日數の表現 =
    使ふ日數 === null && !日數の引數.省かれた ? `${days} 日（既定）` : `${days} 日以内`;
  const 引き = args.kind ?? (args as { kinds?: unknown }).kinds;
  const 名乘り = (Array.isArray(引き) ? 引き : 引き === undefined ? [] : [引き])
    .flat()
    .map((k) => String(k).trim())
    .filter((k) => k.length > 0);
  const 全部 = 名乘り.some((k) => k.toLowerCase() === "all");
  /* 種別は**どれかに當たる行**として選ぶ（第 886 回）。`kinds: ["paper","zzz"]` の樣に
   * 複數をもらつた時、空白で繫いで「paper zzz」といふ存在せぬ種別にして居た – 實測
   * 2026-10-19: 0 件で默つて居た。大文字でも受け付ける（AI は `PAPER` を送る）。 */
  const 選ぶ = new Set(名乘り.map((k) => k.toLowerCase()));
  /* 知らない種別は名指す（`search_deadlines` と同じ扱ひ – 其の侭では 0 件に成る）。 */
  const 知って居る種別 = [
    "all",
    ...投稿の種別,
    "notification",
    "camera_ready",
    "registration",
    "rebuttal_start",
    "rebuttal_end",
    "review_release",
    "supplementary",
    "other",
  ];
  const 知らん = 名乘り.filter((k) => !知って居る種別.includes(k.toLowerCase()));
  const { list, 名, 生成, 窓が無い } = pick(args.scope ?? "all");
  const 古さ = 古さの斷り(生成, now);
  /* 上の境目は**畫面の窓と同じ** JST の暦日で切る（第 874 回）。經由 24 時間で切つて居ると、
   * 同じ「N 日以内」の問に二つの道具が違ふ數を返す – 實測 2026-10-10（窓・論文のみ）:
   * 7 日で list_upcoming 16 件／search_deadlines 19 件、90 日で 134 件／128 件。同じ式は
   * `within_days`（第 872 回）と共有する。下の境目（今後の物だけ）は `r.t` の侭で、
   * 畫面の既定と同じ。 */
  const 限り = Recommender.withinDaysLimitMs(days, now);
  /* 表示して居る暦日で比べる（`tShown`。無ければ `t`）。 */
  const 暦日 = (r: Row): number =>
    typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
  const hit = sortRows(
    list.filter(
      (r) =>
        r.t >= now &&
        暦日(r) < 限り &&
        (全部 || 選ぶ.size === 0 || 選ぶ.has(r.kind) || 選ぶ.has(r.dl.kind)),
    ),
  );
  const 知らんの斷り = 知らん.length
    ? `／知らない種別（其の侭では 0 件に成ります）: ${知らん.join("・")}`
    : "";
  return [
    `今日から ${日數の表現}（JST の暦日で数える）の締切: ${hit.length} 件（${名}・日本時間の早い順${讀めない引數}${知らんの斷り}）`,
    ...(scopeErr ? [scopeErr] : []),
    ...(窓が無いの斷り(窓が無い) ? [窓が無いの斷り(窓が無い)] : []),
    "",
    ...hit.slice(0, 100).map((r) => line(r, now)),
    ...(hit.length > 100 ? ["", `（100 件まで表示・残り ${hit.length - 100} 件）`] : []),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

function venueInfo(args: { key?: unknown; name?: unknown; scope?: unknown }, now: number): string {
  const key = String(args.key ?? "").trim();
  const name = String(args.name ?? "").trim();
  if (!key && !name) return "key（会議の識別子）か name（会議名の一部）をください。";
  /* `名` は使はない（此の道具は會議の名を自分で組み立てる）ので受け取らない。 */
  const { list, 生成 } = pick(args.scope ?? "all");
  const 古さ = 古さの斷り(生成, now);
  /* 会議は**略稱で打たれる**のが普通（實測 2026-10-06: `KDD` `CCS` `AsiaCCS` は此の matching では
   * 見付からなかつた – 表の題は「ACM SIGKDD Conference …」の樣に長く、略稱は別の欄に在る）。
   * 題・略稱・識別子の三つを見る（第 726 回）。*/
  const 求 = name.toLowerCase();
  const 的 = (r: Row): boolean =>
    key
      ? r.conf.key.toLowerCase() === String(key).toLowerCase()
      : r.conf.title.toLowerCase().includes(求) ||
        String(r.conf.acronym ?? "")
          .toLowerCase()
          .includes(求) ||
        String(r.conf.full_name ?? "")
          .toLowerCase()
          .includes(求) ||
        r.conf.key.toLowerCase().includes(求);
  const hit = list.filter(的);
  if (!hit.length) {
    /* **「收錄に無い」と「收錄に在るが締切の行が 1 本も無い」を混同しない**（第 866 回）。
     * 畫面は其の二つを分けて居る（第 294 回の實測: 品書の會議 248 件のうち 74 件は締切が 1 本も
     * 無い）。行から引くと、締切を持たん會議は「收錄に無い」と答へてしまふ – 收錄その物から引く。 */
    const 求 = name.toLowerCase();
    const 收錄の會議 = snapshot().conferences ?? [];
    /* key を指定されて居る時は**其の key で**名簿を引く。名が空の儘名前で探すと、
     * `title.includes("")` がどれにも當たつて**先頭の会議**を返してしまふ – 實測 2026-10-12:
     * `venue_info({key: "sc"})`（窓に行が無い）が、全く別の會議（jornadas-dl2）の情報を
     * 「その会議は収録に在りますが…」と返して居た。問はた會議の事を言ふのが此の道具の役目。 */
    const 在る = key
      ? 收錄の會議.find((c) => String(c.key ?? "").toLowerCase() === key.toLowerCase())
      : 收錄の會議.find((c) => {
          const ck = String(c.key ?? "").toLowerCase();
          const title = String(c.title ?? "").toLowerCase();
          const acronym = String(c.acronym ?? "").toLowerCase();
          return (
            Boolean(ck) &&
            (ck === 求 ||
              title.includes(求) ||
              acronym.includes(求) ||
              /* 正式名も見る（第 887 回 – `Supercomputing` は `ICS` の正式名の中にしか
               * 出て居なかつた。實測 2026-10-20: search_deadlines は 37 行出すのに、
               * 此方は「收錄に在りません」と答へて居た）。 */
              String(c.full_name ?? "")
                .toLowerCase()
                .includes(求) ||
              ck.includes(求))
          );
        });
    if (在る) {
      const 版々 = Array.isArray(在る.editions) ? 在る.editions : [];
      const 會期あり = 版々.some((e) =>
        String((e as { event_start?: unknown } | null)?.event_start ?? "").trim(),
      );
      const link = String(在る.link ?? "").trim();
      return [
        `問はた会議（${String(在る.acronym || 在る.title || 在る.key)}・key: ${String(在る.key)}）は収録に在りますが、**締切の行が 1 本もありません**（版 ${版々.length} 件）。` +
          (會期あり
            ? "会期は収録に在るので、直近の一覧（upcoming.md）とカレンダー（deadlines.ics）には「開催」として載ります。"
            : "会期も確認できていないので、どの一覧にも出ません。"),
        ...(link ? [`公式ページ: ${link}`] : []),
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }
    /* **版（edition）の識別子**を渡された時は、其の會議を指して敿へる（第 887 回）。
     * 實測 2026-10-20: `venue_info({key: "sc26"})` は「收錄に在りません」と答へて居た –
     * `data.csv` の `edition_id` や `data.json` の `editions[].id` を其の儘渡すことは
     * 實際に在る（AI は此れ等を讀んで居る）。版は確かに會議では無いが、「無い」では無い。 */
    const 版の會議 = key
      ? 收錄の會議.find((c) =>
          (Array.isArray(c.editions) ? c.editions : []).some(
            (e) =>
              String((e as { id?: unknown } | null)?.id ?? "").toLowerCase() === key.toLowerCase(),
          ),
        )
      : undefined;
    if (版の會議) {
      const 本の會議 = String(版の會議.key ?? "");
      return [
        `「${key}」は**版（edition）の識別子**で、会議その物の key ではありません。` +
          `会議の key は \`${本の會議}\` です（key で引き直すと、この会議の全ての版と締切が出ます）。`,
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }
    return [
      `その会議は収録に在りません（収録 ${收錄の會議.length} 会議）。会議名の一部で試すか、search_deadlines で引いてください。`,
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  /* 曖昧な打ち方（`KDD` は kdd・sigkdd・pakdd・ecmlpkdd に當たる）では**一つの会議に決め打たない**。
   * 決め打つと、別の会議の版を一つに混ぜて返す（實測 2026-10-06 にそう成つた – 第 726 回）。
   * 名乘りが割れた時は候補を並べて、細く打ち直して貰ふ。*/
  const 會々 = [...new Set(hit.map((r) => r.conf.key))];
  if (會々.length > 1) {
    const 名乗り = [...new Map(hit.map((r) => [r.conf.key, r.conf.title])).entries()];
    /* 候補には**公式の繋ぎ先**も添へる（第 750 回 – 名前と key だけでは、どれが探して居る物か
     * 決められん。人は URL を見て選ぶ）。同じ key の行の內、最初に繋ぎ先を持つ物を使ふ。*/
    const 繋ぎ先 = new Map<string, string>();
    for (const r of hit) {
      const url = String(r.ed.link ?? "").trim();
      if (url && !繋ぎ先.has(r.conf.key)) 繋ぎ先.set(r.conf.key, url);
    }
    return [
      `「${key || name}」には ${會々.length} の会議が当たりました。名を細く打つか、key で指してください:`,
      ...(scopeErr ? [scopeErr] : []),
      ...名乗り
        .slice(0, 20)
        .map(([k, t]) => `- ${t}（key: ${k}）${繋ぎ先.get(k) ? ` ${繋ぎ先.get(k)}` : ""}`),
      ...(名乗り.length > 20 ? [`- ほか ${名乗り.length - 20} 件`] : []),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  const 一つ = hit[0];
  const 版 = [...new Set(hit.map((r) => r.ed.id))].sort();
  /* **今後の物を先に**並べる（第 751 回 – 實測 2026-10-06: `venue sigkdd` の一覽が 2021 年から
   * 始まつて居た。人は「次はいつか」を聞いて居るので、過去を先に讀ませない。同じ側では日の早い順）。*/
  const 見本 = sortRows(hit)
    .slice()
    .sort((a, b) => Number(a.t < now) - Number(b.t < now) || a.t - b.t)
    .map((r) => line(r, now));
  /* 今後の締切が無い会議では、**其の事を先に言ふ**（第 754 回 – 過ぎた行だけを並べると、
   * 讀む人（と AI）が「次はこれ」と取り違へる）。 */
  const 今後 = hit.filter((r) => r.t >= now).length;
  const 斷り = 今後 ? "" : "※ この会議の今後の締切は収録にありません（下の行は過ぎた物です）。\n";
  /* **次の投稿締切**を先頭で言ふ（第 893 回 – 實測 2026-10-24: `venue sigkdd` の一覽の
   * 先頭は「反論期間終了」と「採否通知」で、「KDD の次の締切は？」と聞いた人が投稿の締切を
   * 探すのに 60 を越える行を讀まなければ成らなかつた）。投稿の種別（論文・概要）の行だけを
   * 先頭へ出す – 「締切」と言へば投稿の締切を指すのが普通。 */
  const 投稿の行 = hit
    .filter((r) => 投稿の種別.includes(r.kind))
    .sort((a, b) => Number(a.t < now) - Number(b.t < now) || a.t - b.t);
  const 次の投稿 = 投稿の行.find((r) => r.t >= now);
  /* 過ぎた分の「直近」は**一番遲い過去**（投稿の締切が今年の分まで出たなら其れを言ふ –
   * 一番古い過去を出すと「5 年前に終はつた會議」と讀めてしまふ）。 */
  const 直近の過去 = 投稿の行
    .filter((r) => r.t < now)
    .reduce<(typeof 投稿の行)[number] | null>((a, b) => (!a || b.t > a.t ? b : a), null);
  const 投稿の案內 = 次の投稿
    ? `次の投稿締切: ${line(次の投稿, now)}`
    : 直近の過去
      ? `次の投稿締切: 今後の収録にありません（直近では ${line(直近の過去, now)}）。`
      : "次の投稿締切: 収録にありません（この会議の投稿の締切は 1 本も記録されていません）。";

  return [
    斷り +
      `会議: ${一つ.conf.title}（key: ${一つ.conf.key}${一つ.conf.acronym ? `・${一つ.conf.acronym}` : ""}）`,
    ...(scopeErr ? [scopeErr] : []),
    `版: ${版.join(" / ")}`,
    /* 分野は畫面と同じ日本語で出す（第 726 回 – 機械向けのキー（`ai`）の侭では、人が讀む時に
     * 畫面のチップと結び付かん。同じ入口（`categoryLabelJa`）から取る – 書き寫すとずれる）。*/
    `分野: ${
      (一つ.conf.categories ?? [])
        .map((key) => String(Recommender.categoryLabelJa(key) ?? key))
        .join("・") || "未確認"
    }`,
    /* ランクも言ふ（一つの會議を調べた人が、次の一手を決めるのに要る – 畫面の列と同じ語）。 */
    `ランク: ${ランクJa(一つ)}`,
    /* 其の會議の締切が、どの位確かめられて居るか（行ごとの札だけでは、全體の偏りが分からん）。 */
    `確認: ${確認の內譯(hit)}`,
    投稿の案內,
    "",
    /* 並びは第 751 回から「今後の物が先」に變はつたので、其れを書く（前に書いて居た
     * 「日本時間の早い順」は、版を跨ぐと過去が先に來る意味に讀めてしまふ）。切り詰めも
     * **默らない**（第 765 回 – 60 件で切れて居る事を言はないと、AI が「これで全部」と答へる）。*/
    `締切と会期（今後の物から、同じ側では日本時間の早い順）${見本.length > 60 ? `・${見本.length} 件のうち 60 件` : ""}:`,
    ...見本.slice(0, 60),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

function explainWord(args: { word?: unknown; scope?: unknown }, now: number): string {
  const word = String(args.word ?? "").trim();
  if (!word) return "語をください。";
  const { list, 名, 生成, 窓が無い } = pick(args.scope);
  const 古さ = 古さの斷り(生成, now);
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(word, now), now);
  const 件數 = list.filter((r) => 照合(r.hay) === true).length;
  /* 0 件の時に出す案内は、**素の照合で行が在つても**要る（第 888 回）。畫面は見える一覧が 0 の
   * 時に名簿・種別・打ち直しの話を出す（第 875 回）– 語を調べる人も同じ話が必要。實測
   * 2026-10-21: `explain_word("カメラレディ")` は 70 行ある事だけ言つて、其の種別の選び方
   * （`kinds: ["camera_ready"]`）を言はなかつた（「畫面が出す案内文を其の儘返す」に反する）。 */
  const 窓の外 = 窓の外の件數(照合, 名);
  const 案内 = guidance(word, 0, list, now);
  const 果て = 窓の外 ? "" : 果ての案内(word, list, 名);
  const 日數 = 日數幅の案内(word, list, now, {});
  const 種別の報 = 種別の報べ(word, list, now, {});
  const 語ごと = 語ごとの案號(word, list, now);
  const URLの報 = URLの案内(word);
  const 名簿 = 名乘りの案内(word, list);
  const 手 = retypeTips(word, 畫面の既定(list, now, {}), now);
  const 指南 = [
    ...案内,
    ...(果て ? [果て] : []),
    ...日數,
    ...(種別の報.length ? [種別の報] : []),
    ...語ごと,
    ...URLの報,
    ...名簿,
  ];
  /* 受皿は何も立たなんだ時だけ（`search_deadlines` と同じ門 – 第 884 回）。 */
  const 受皿 = 指南.length || 手.length ? [] : 受皿の案內();
  if (件數 > 0) {
    /* 行が出る時は**中身を少し見せる**（第 796 回）。行は `search_deadlines` と同じ形
     * （`line()`）で、3 行まで。 */
    const 素の行 = list.filter((r) => 照合(r.hay) === true);
    /* **兩方の數を言ふ**（第 797 回 – 素の照合と、画面の既定の絞り込みを通した數は違ふ）。 */
    const 畫面の行 = 畫面の既定(素の行, now, {});
    const 行 = sortRows(畫面の行).slice(0, 3);
    return [
      `「${word}」は素の照合で ${件數} 行・画面の既定の絞り込み（今後・投稿締切の種別・推定を除く）を通すと ${畫面の行.length} 行です（${名}）。`,
      ...行.map((r) => `- ${line(r, now)}`),
      ...(畫面の行.length > 行.length
        ? [`- …ほか ${畫面の行.length - 行.length} 行（search_deadlines で引けます）`]
        : []),
      /* 畫面の既定で 0 件に成る時は、その**理由**を添える（第 888 回）。 */
      ...(畫面の行.length === 0 && (指南.length || 受皿.length)
        ? ["画面の既定の絞り込みで 0 件に成る理由:", ...指南, ...受皿].map((n) =>
            n === "" ? "" : `- ${n}`,
          )
        : []),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  return [
    `「${word}」は 0 行です。画面が此の時に出す案内:`,
    ...(scopeErr ? [scopeErr] : []),
    ...(窓が無いの斷り(窓が無い) ? [窓が無いの斷り(窓が無い)] : []),
    ...(窓の外
      ? [
          `- 画面が最初に読む窓（${list.length} 行）には 1 行もありませんが、**収録の全体には ${窓の外} 行あります**（scope: "all" で引けます）`,
        ]
      : []),
    /* 「案内は無し」は**何も立たなんだ時だけ**（第 875 回の檢索と同じ – 次の行に名簿の案内が
     * 在るのに「無し」と書くのは噓だつた）。 */
    ...(指南.length || 受皿.length
      ? [...指南, ...受皿].map((n) => `- ${n}`)
      : ["- （案内は無し＝表の語では無い語）"]),
    ...手.map((t) => `- 打ち直すなら ${t}`),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

/** 容量を MiB / KB で示す（畫面の `bytesJa` と同じ式 – 兩方で單位が違ふと読めない）。 */
function 容量の文(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `約 ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `約 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function collectionStats(now: number): string {
  const list = allRows();
  /* 会議と版は**收錄その物**から數へる（行から數へると「締切を持つ物」だけに成り、建てた時の
   * 「696 会議 / 2,603 版」と食ひ違ふ – 第 769 回に一度其れを踏んだ）。行は締切の數へに使ふ。*/
  const 收錄 = snapshot();
  const 会議 = (收錄.conferences ?? []).length;
  const 版 = (收錄.conferences ?? []).reduce(
    (n, c) => n + (Array.isArray(c.editions) ? c.editions.length : 0),
    0,
  );
  const 今後 = list.filter((r) => r.t >= now).length;
  const 日 = list.map((r) => r.localDate || new Date(r.t).toISOString().slice(0, 10)).sort();
  /* 生成時刻は**同じ檔案**から取る（畫面の右上の「データ生成」と同じ書き方・同じ函數）。
   * 畫面が最初に讀む窓は別の檔案なので、其方の生成時刻も添へる（古さの斷りは窓ごとに違ふ）。 */
  const 元の生成 = 收錄.snapshot_metadata?.generated_at;
  const 窓の生成 = catalog() ? 生成の表示(catalog()?.generated_at) : "";
  const 古さ = 古さの斷り(元の生成, now);
  /* 容量は**測った値だけ**書く（第 906 回 – 實測 2026-10-31: 畫面は「収録の全体」を押す前に
   * 容量を數字で示す樣にした（第 905 回）が、AI 側は「全部取り込むのにどれ-elles要るか」が
   * 分から無い。品書が `history_bytes` を載せて居れば其れを使い、無い時は**書かない**
   * – 數をでっち上げない。畫面と同じ単位（MiB）に揃へる）。 */
  const 全体容量 = (() => {
    const 申告 = Number((catalog() as { history_bytes?: unknown } | null)?.history_bytes ?? 0);
    if (Number.isFinite(申告) && 申告 > 0) return 容量の文(申告);
    try {
      const 実 = statSync(join(ROOT, "public", "data.json")).size;
      return 実 > 0 ? 容量の文(実) : "";
    } catch {
      return "";
    }
  })();
  const ファイル = [
    "index.html（画面。絞り込みと検索）",
    "upcoming.md / upcoming.html（直近 180 日の表）",
    "data.csv（1 行 1 締切の平坦な表）",
    "deadlines.ics（カレンダー。1 日 1 件の終日）",
    `data.json（収録の全体。機械可読の正${全体容量 ? `・${全体容量}` : ""}）`,
    "llms.txt（機械向けの索引。何が何処に在るか）",
  ];
  return [
    `収録（${DATA_PATH.replace(`${ROOT}/`, "")}）: 会議 ${会議} 件 / 版 ${版} 件（生の収録。建てる時は同じ物を束ねるので、建てた表示とは少し違い得る）/ 締切の行 ${list.length} 行（日付の幅 ${日[0]} 〜 ${日[日.length - 1]}）`,
    `データ生成: ${生成の表示(元の生成)}（上の行と同じ出所。画面の右上と同じ書き方）`,
    ...(窓の生成 ? [`画面が最初に読む窓（public/catalog.json）のデータ生成: ${窓の生成}`] : []),
    `うち今後の締切: ${今後} 行（${new Date(now).toISOString().slice(0, 10)} 以降）`,
    `確認の状態: ${確認の內譯(list)}`,
    ...(古さ ? ["", 古さ] : []),
    "",
    "配付して居るファイル（サイトと同じ場所に在る）:",
    ...ファイル.map((f) => `- ${f}`),
  ].join("\n");
}

/* ---- 投稿先の推薦（第 857 回）---- */

/* 畫面の「投稿先を探す」は、論文の題名・概要から候補を出す – 此の計畫の看板だが、MCP には
 * 出口が無く、AI は「この論文どこに出せる?」に此の收錄を使って答へられなかつた。
 *
 * **語の一致だけ**で評價する（意味檢索の埋め込みは讀まない – 模型を抱へると此の道具が重く
 * 成る。畫面も埋め込みが無い時は同じ道に落ちる）。其の旨は返り値の頭に書く（人が見る數と
 * AI が言ふ數が違ふのが一番惡い – 埋め込みを使へる畫面では點が少し動く）。 */
let recommendationCache: { rows: Row[]; conferences: unknown[] } | null | undefined;

/** 推薦の索引を一度だけ讀み、同じ下準備（名前の IDF と reranker）をして行を作る。 */
function recommendation(): { rows: Row[]; conferences: unknown[] } | null {
  if (recommendationCache !== undefined) return recommendationCache;
  try {
    const 品書 = JSON.parse(readFileSync(RECOMMENDATION_PATH, "utf8")) as {
      conferences?: unknown[];
      reranker?: unknown;
    };
    const conferences = Array.isArray(品書.conferences) ? 品書.conferences : [];
    if (!conferences.length) throw new Error("conferences が空");
    Recommender.setNameIdf(Recommender.buildNameIdf(conferences));
    Recommender.setReranker(品書.reranker ?? null);
    recommendationCache = {
      rows: Recommender.candidateRows(品書 as never) as unknown as Row[],
      conferences,
    };
  } catch {
    recommendationCache = null;
  }
  return recommendationCache;
}

function recommendVenues(args: { paper?: unknown; limit?: unknown }, now: number): string {
  const paper = String(args.paper ?? "").trim();
  if (!paper)
    return [
      "論文の題名か概要をください。",
      "画面の入力と同じ形（`題名 | キーワード, キーワード | 投稿先`）が一番よく当たります（1 行だけでも構ひません）。",
    ].join("\n");
  const 索引 = recommendation();
  if (!索引)
    return `推薦の索引（${RECOMMENDATION_PATH.replace(`${ROOT}/`, "")}）が読めません。建てた物（\`npm run build\`）と同じ場所に置いてから使つてください。`;
  const 限り = 數の引數("limit", args.limit, 1);
  const limit = Math.min(限り.使ふ ?? 10, 30);
  const lines = Recommender.parsePaperLines(paper);
  if (!lines.length)
    return "論文の題名を読み取れませんでした。題名を 1 行でください（`|` でキーワードと投稿先を添へられます）。";
  /* **候補の pool は畫面と同じ**（第 894 回 – 實測 2026-10-25: 此方は索引の行をそのまま使つて
   * 居たので、2,458 本の内 2,270 本（92%）が**過ぎた締切**だつた。「投稿先を探す」の候補が
   * 1・2 番目に過ぎた締切を擧げ、AI は「おすすめ」として締め切つた會報を勧めてしまふ。
   * 畫面は「これからの締切 + 常時受付のジャーナル + これからの締切が無い會議の過去代表 1 行」
   * （`site/app.ts` の `pool`）で選ぶので、此方も其の行を使ふ。索引は**品書が在る時は讀まない**
   * – 畫面が讀むのは品書で、索引は IDF と再学習の重みだけを持ち出す（第 714 回と同じ役目の
   * 分け方）。品書が無い手元では索引の行へ落とす（候補が 0 件にならん樣に）。 */
  const 品書の行 = screenRows();
  const 行 = 品書の行 ?? 索引.rows;
  const 會議 = 品書の行 ? ((catalog()?.conferences as unknown[]) ?? []) : 索引.conferences;
  const pool = 行
    .filter((r) => !Recommender.deadlineRowIsPast(r, now))
    .concat(Recommender.journalRows(會議, now) as unknown as Row[])
    .concat(Recommender.pastRepresentatives(行 as never, now) as unknown as Row[]);
  const 候補 = Recommender.venueRecommendations(pool, lines, null, now, {
    fieldedLexical: true,
  }).filter((r) => r.fit.score >= 10);
  const 題 = lines
    .map((l) => String(l.title ?? "").trim())
    .filter(Boolean)
    .join(" / ");
  /* pool には「これからの締切が無い會議の過去代表 1 行」が入る（畫面と同じ）。黙って居ると
   * AI が「今後締め切れる會報」として過去の行を勧めてしまふ – 畫面の「締切済み」と同じ
   * 言い方で件數を頭に書く（第 894 回）。 */
  const 過ぎた件數 = 候補.filter((r) => Number(r.row.t) < now).length;
  const 頭 =
    `「${題}」に合う投稿先: ${候補.length} 件（語の一致と再学習の重みで評価 – ` +
    `意味検索の埋め込みは読まないので、埋め込みを使える画面とは点が動く事があります${限り.斷り}）` +
    /* 過ぎた候補は「次回の開催に向けた参考」として件数を分けて書く（黙って居ると AI が
     * 今出せるように勧めてしまふ – 画面の「締切済み」と同じ出し分け）。 */
    (候補.length > 過ぎた件數
      ? `（うち ${過ぎた件數} 件は締切が過ぎた会議です – 次回の開催に向けた参考に載せています）`
      : "");
  if (!候補.length)
    return [
      頭,
      "",
      "この題名の語と重なる投稿先は見付かりませんでした。題名に加へて、分野の語やキーワード（`tsn, real-time, scheduling` の様に）を添へると当たりやすくなります。",
    ].join("\n");
  const 見本 = 候補.slice(0, limit);
  /* pool に過去の代表が入って居ることを默らない（AI が「これから締め切る會報」として
   * 過去の行を埋めないように – 頭で件数を分けて言ふ）。 */
  return [
    頭,
    /* 札の意味は**畫面のてびきと同じ言い回し**で添える（第 896 回 – 實測 2026-10-27:
     * 札（「候補」・「重なりうすい」）を其の儘返すだけで、何を意味するかが讀めなかつた。
     * AI が「候補」を確度として取り違へると、推薦の强さが變はつてしまふ）。 */
    "札は「候補」＝いちばん近い会議との差が小さい、「重なりうすい」＝言葉の重なりが弱い、です（画面の『見方のてびき』と同じ）。数値は並べるための目安で、採択の予測ではありません。",
    `（一致評価の高い順。${limit} 件まで表示${候補.length > limit ? `・残り ${候補.length - limit} 件` : ""}）`,
    "",
    ...見本.map((r, i) => {
      const 評價 = `${String(r.fit.label ?? "評価保留")}（${Number(r.fit.score) || 0} 点）`;
      /* **選定理由** – 畫面のカードと同じ言ひ回し・同じ要素（`site/app.ts` の `reasonSignals`
       * と同じ 5 つ + 過去掲載先）。實測 2026-10-28: AI が「何で此の會報か」を根拠付きで
       * 言へなかつた（點と札だけ）。畫面が持つ物を默つて落とすと、推薦の強さが分からん。 */
      /* **締切の確認状況** – 畫面のカードと同じ 4 つの軸（`site/app.ts` の
       * `deadlineTrust`。軸その物は `recommendation-core.ts` の共有計算）。實測
       * 2026-10-29: MCP の推薦行は日付と種別だけを出して、**その締切が公式確認できて居るか**
       * を言はなかつた（AI が「次は 2027-01-29 です」と言へても、推定の日付なのか分からん）。 */
      /* 軸は**品書が載せた値**を先に読む（畫面の `axesForRecommendation` と同じ順番 –
       * 其れが無い時だけ其場で求める）。品書が其れを持つ前は、品書の会議は窓の版しか無くて
       * 历年が 1 年になり、`ICDE` が「新規・確認した年 1 年」と出て居た（第 900 回）。 */
      const 載つて居る軸 = 品書の軸().get(String(r.row.conf.key ?? ""));
      const 軸 =
        載つて居る軸 && typeof 載つて居る軸 === "object"
          ? (載つて居る軸 as ReturnType<typeof recommendationAxes>)
          : recommendationAxes(
              r.row.conf as unknown as Record<string, unknown>,
              Number(r.fit.score) || null,
              now,
            );
      const 信賴の札: Record<string, string> = {
        official: "公式確認",
        publisher: "出版社確認",
        "curated-manual": "手動確認",
        aggregator: "集約情報",
        assumption: "推定",
        unverified: "未確認",
      };
      const 締切の信賴 = 軸.deadline_trust;
      /* **會議の續いて居る年数** – 畫面のカードと同じ言ひ回し。實測 2026-10-31: 品書に載せた
       * 軸を読む樣にして居るため、`ICDE` が「新規・確認した年 1 年」で無くて
       * 「成長中・確認した年 7 年」になる（選擇の材料になる – 新規の會報は査讀が亂暴な筈）。 */
      const 成熟の語: Record<string, string> = {
        established: "確立",
        emerging: "成長中",
        new: "新規",
        unverified: "未確認",
      };
      const 成熟 = 軸.venue_maturity;
      const 成熟の文 =
        `会議の続いている年数: ${成熟の語[成熟.status] ?? String(成熟.status)}` +
        `（確認した年 ${Number(成熟.evidence?.yearsObserved) || 0}年、その会議の論文サンプル ${Number(成熟.evidence?.profileCoverage) || 0}件）`;
      const 確認狀況 =
        `締切の確認状況: 日付 ${信賴の札[締切の信賴.date] ?? String(締切の信賴.date)}` +
        ` ／ 時刻 ${信賴の札[締切の信賴.time] ?? String(締切の信賴.time)}` +
        ` ／ タイムゾーン ${信賴の札[締切の信賴.timezone] ?? String(締切の信賴.timezone)}` +
        ` ／ 種別 ${信賴の札[締切の信賴.kind] ?? String(締切の信賴.kind)}`;
      /* **取得狀態と締切の競合** – 畫面のカードが常に出す 2 つを、**普通の時は黙つて居る**
       * （第 899 回 – 實測 2026-10-30: 會議 696 件の取得狀態は全部「今回あたって確認」、
       * 競合が有るのは 4 會議だけ。常套の文を各行に足すと、變な 1 行だけが埋もれる）。 */
      const 新しい狀態: Record<string, string> = {
        fresh: "今回あたって確認",
        "cache-fallback": "前回の取得データ（今回は上流にあたらず）",
        "snapshot-fallback": "確定済みの収録データ（今回は上流にあたらず）",
      };
      const 特記 = [
        ...(締切の信賴.sourceFreshness !== "fresh"
          ? [
              `取得状態: ${新しい狀態[締切の信賴.sourceFreshness] ?? String(締切の信賴.sourceFreshness)}`,
            ]
          : []),
        ...(Number(締切の信賴.conflicts) > 0
          ? [`締切の競合: ${Number(締切の信賴.conflicts)} 件`]
          : []),
      ];
      const agg = (r.match as { agg?: Record<string, number> } | undefined)?.agg ?? {};
      const 理由: string[] = [];
      const 號: Array<[string, number]> = [
        ["分野の一致", agg.domain ?? 0],
        ["会議名一致", agg.venueName ?? 0],
        ["採択論文一致", agg.paper ?? 0],
        ["日本語一致", agg.jp ?? 0],
        ["主題の一致", agg.tags ?? 0],
      ];
      for (const [名, 値] of 號) if (値 > 0) 理由.push(名);
      if ((agg.venue ?? 0) > 0) 理由.push("過去掲載先一致");
      const 意味順 = (r.fit as { semanticRank?: number | null }).semanticRank;
      if (意味順) 理由.push(`意味検索順位 ${意味順}`);
      if (r.boosted) 理由.push("同じ分野（掲載先から推定）");
      return (
        `${i + 1}. 一致評価 ${評價}｜${line(r.row as unknown as Row, now)}｜${成熟の文}｜${確認狀況}` +
        `${特記.length ? `｜${特記.join("｜")}` : ""}｜選定理由: ` +
        `${理由.length ? 理由.join(" / ") : "目立つ一致はないが候補に入った"}`
      );
    }),
  ].join("\n");
}

const TOOLS = [
  {
    name: "search_deadlines",
    description:
      '**語を省いて `kind` / `kinds` / `within_days` だけでも引ける**（「登録締切を全部」「30 日以内の締切を全部」の様な聞き方）。kamiyobi の収録（国際会議・国内研究会の締切と会期）を日本語で引く。会議名・分野・開催地・締切の語・相対日付（『今月』『30日以内』『来週』など）が使へる。**0 件の時は、画面と同じ案内（その語が表に無い事）と、同じ「打ち直すなら」の次の一手を返す** – その一手の件数は、実際に引いた時に出る行数と一致する（その侭打ち直せる）。**欄の名前（`分野` `種別` `会場` など）を打たれたら、値で打ち直す事を言う**（「「種別」はこの表の欄の名前で、値その物ではありません。値で打ってください（例: 「論文締切」）」– 例で打つと行が出る）。**二つの語を「と」「や」で繋いだ打ち方には、どちらかだけで打つ事を、片方づつの件数つきで言う**（「「ネットワーク」を書く行は N 件、「セキュリティ」を書く行は N 件ありますが、『と』で繋いで打つと両方を含む行を探すため 0 件になります。どちらかだけで打ってください」）。**窓（`scope: "screen"`）で 0 件の時は、収録の全体に何行あるかを言う**（「窓には 1 行もありませんが、収録の全体には N 行あります（`scope: "all"` で引けます）」– 窓は画面が最初に読む 180 日ぶんだけなので、其れを「無い」と読ませない）。**日数の幅（「1か月以内」）は検索語に当たらないので、同じ幅を引く引数を件数つきで言ふ**（「語を省いて `within_days: 30` で引けます（N 件当たります）」– 画面の「締切まで」の選択欄と同じ物が `within_days` である。「3日前まで」の様に幅の終はりが無い言ひ方は、過去なので `include_past: true` を教へる）。**打つた日付が収録の果て（一番遠い締切）より先なら、「無い」とは言はない**（「打った日付「2029年3月」は、収録している中で一番遠い締切 <日付> より先です。その日付に締切があるかどうかも、まだ確認できていません。」– 画面の第 293 回と同じ決めごと）。**0 件の時は、収録の会議の名前に当たっていないかも見る**（「締切の行が 1 本もありません」「会期は upcoming.md に『開催』として載ります」のように、収録に在る事と、何処を見ればよいかを言う – 「収録に無い」とは言わない。**名前に年を添えて打つても受け付ける**（`ACSAC 2027` の様に、年の語は名前の要求から外す – 画面の第 296 回と同じ）。**語に当たる行が在るのに既定の絞り込みで 0 件の時も名簿を名指す**（「締切の行は在りますが、いまの絞り込みで 0 件に成つて居ます（絞り込みを外すと出ます）」）。**必須の引数は無い**。絞り込みは画面と同じ物が揃っている（`kinds`・`rank`・`domestic`・`online`・`within_days`・`include_past`・`include_estimated`）。**使い切れない数の値は黙って既定に戻さない**（`within_days: 0` `days: "abc"` `limit: -1` などは「その値は使はないので、既定の儘引きます」と頭に書く – 知らない種別・知らないランクと同じ扱ひ）**表に出さん種別の語（「採否通知」「カメラレディ」など）は、その種別を `kinds` で選ぶ事を件数つきで教える**（「検索語は『カメラレディ締切』の種別に当たります（表には投稿締切だけを出します）。kinds: ["camera_ready"] で引けます（N 件当たります）」– 画面の第 244 回と同じ話）。行にはランク（`CCF A・CORE A*` の形。無い行は「ランク未確認」）・会期・確認の状態の札（`複数候補のため要確認` など。確認済みと未設定では付かない）と `延長後` も付く。収録が古ければ、末尾に画面と同じ断りが付く。' +
      "**語を並べた時は、収録に無い語を名指す**（「検索語のうち『gpu』は収録データにも見当たりません。その語を外すと増えます」・どれも在る時は語ごとの件数を並べる – 画面の第 258 回と同じ）" +
      "**URL を貼った人には、打つた文字を「語が無い」とは言はない**（ドメインの部品を語として扱はない – 「検索語の URL の会議は収録に見当かりません。収録の中心は…。会議名（「ICDE」など）で試してください」。画面の第 153 回と同じ）。" +
      "**どの案内にも当たらなかった問には、この表が何を出す画面なのかを言ふ**（催し物の名前・締切の日・分野・種別・開催地・参加形式と、**分野の欄が何を幾つ持つか** – 画面の第 240・679 回と同じ。例: 「脳科学」のような収録の外の語でも空振りで終わらない）。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索語（日本語。例: セキュリティ / 今月 / 海外開催）",
        },
        limit: { type: "number", description: "返す行数（既定 20・最大 100）" },
        include_past: {
          type: "boolean",
          description: "過ぎた締切も含める（既定 false＝画面の既定と同じ）",
        },
        include_estimated: { type: "boolean", description: "推定の締切も含める（既定 false）" },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "種別のキーで絞る（既定は画面と同じ abstract / paper / journal）",
        },
        kind: {
          type: "string",
          description: "種別のキーを一つだけ絞る（`kinds` の単数の書き方。同じ物を受ける）",
        },
        rank: {
          type: "string",
          description:
            "ランクの等級で絞る（`A*` / `A` / `B` / `C` / `N`。画面のランク欄と同じ厳密比較 – `A` は `core:A*` を巻き込まない）",
        },
        domestic: {
          type: "boolean",
          description:
            "国内研究会・国内シンポジウムだけに絞る（画面の同じ名前のチェック欄と同じ判定。**日本で開かれる国際会議は入らない** – それは開催地の語「東京」「日本」で引く）",
        },
        online: {
          type: "boolean",
          description:
            "オンライン参加可の行だけに絞る（画面の同じ名前のチェック欄と同じ判定。会場の表記にオンライン・ハイブリッドなどの記述がある行だけ – 記述が無い行を対面と決めつけない）",
        },
        within_days: {
          type: "number",
          description:
            "「締切まで N 日」の窓（画面の同じ名前の選択欄と同じ判定。JST の暦日で切り、`include_past: true` の時は同じ日数の過去側も含める）。語を省いてこれだけでも引ける",
        },
        scope: {
          type: "string",
          enum: ["screen", "all"],
          description:
            "見る窓。screen＝画面が最初に読む窓（180 日。catalog.json が在る時だけ）／all＝収録の全体（過去と先の締切も含む）",
        },
      },
      /* **必須の引数は無い**（語も種別も無い時は、代はりの聞き方を返す）。schema で query を
       * 必須にすると、說明に書いた「語を省いて kind / kinds だけでも引ける」呼び方を、
       * schema を検める客户が彈く（第 854 回に氣付いた）。 */
    },
  },
  {
    name: "list_upcoming",
    description:
      "今日から N 日以内の締切を日本時間の早い順に返す（**種別では絞らない**（既定）– `kind` を渡すとその種別だけに絞れます。複数は配列で（どれかに当たる行）。登録・カメラレディ・採否通知も混ざる。**推定の締切も入ります**（search_deadlines の既定は外すので、条件を揃えて比べるときは `include_estimated: true` を添えてください）。上の境目は JST の暦日で切り、`search_deadlines` の `within_days` と同じ数え方です（同じ条件なら同じ件数になります）。100 件を超える時は其の旨と残り件数を末尾に書く。行にはランク（`CCF A・CORE A*` の形。無い行は「ランク未確認」）・会期・確認の状態の札も付きます。",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "何日先まで（既定 30・最大 400）" },
        kind: {
          type: "string",
          description:
            '種別のキー（例: paper / abstract / camera_ready。全部なら "all"。複数を配列で渡すとどれかに当たる行を選ぶ。大文字は小文字に直して受ける）',
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "種別のキーの並び（search_deadlines と同じ名。どちらでも受ける）",
        },
        scope: {
          type: "string",
          enum: ["screen", "all"],
          description: "見る窓（既定 all。collection・full・window・catalog も同じ）",
        },
      },
    },
  },
  {
    name: "venue_info",
    description:
      "1 つの会議の版・分野・締切・会期を返す。**key（識別子）・name（名前の一部）・略称・正式名のどれでも引ける**（正式名は `ICS` = ACM International Conference on Supercomputing のように略称だけでは出て居ない語も引ける）。**版（edition）の識別子**（`data.csv` の `edition_id` のような `sc26`）を渡された時は、それが版だと言つた上で会議の key を教へる（「収録に無い」とは言わない）。締切は**今後の物から**並ぶ（同じ側では日の早い順）。今後の締切が無い会議では其の旨を先に言ふ。**次の投稿締切（論文・概要）を先頭で言ふ**（「反論期間終了」のような投稿以外の日を先頭に置かない – 「締切」と言へば投稿の締切を指すのが普通）。名乗りが割れた時は候補（名・key・公式 URL）を並べて決め打たない。**分野とランク（`CCF A・CORE A*` の形）も返す**。行には会期と確認の状態の札も付く。収録が古ければ、末尾に画面と同じ断りが付く。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会議の識別子（例: kdd）" },
        name: { type: "string", description: "会議名の一部（例: KDD）" },
        scope: {
          type: "string",
          enum: ["screen", "all"],
          description: "見る窓（既定 all。collection・full・window・catalog も同じ）",
        },
      },
    },
  },
  {
    name: "collection_stats",
    description:
      "この収録その物の規模（会議数・版数・締切の行数・日付の幅・今後の件数）と、配付して居るファイルの一覧を返す。**この収録のデータ生成時刻（画面の右上と同じ書き方）も返す**ので、「何時のデータか」を人に言ふ時に使ふ。「この収録は何か」「何件あるか」「人に渡すなら何を渡せばよいか」に答へる時に使ふ。生成から 3 日以上経つて居れば、一覧を返す道具と同じ断りも付く。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recommend_venues",
    description:
      "投稿予定の論文（題名・キーワード・概要）に合う投稿先を、一致評価の高い順に返す（画面の「投稿先を探す」と同じ推薦核を使ふ）。**語の一致と再学習の重みで評価する**（意味検索の埋め込みは読まない – 使える画面とは点が動く。再学習の重みも画面は読んでいないので、札の付き方が画面と違う事が在る。其の旨は返り値の頭に書く）。**候補の pool は画面と同じ**（これからの締切 + 常時受付のジャーナル + これからの締切が無い会議の過去代表 1 行 – 過ぎた候補の件数は頭に分けて書く）。入力は画面と同じ `題名 | キーワード, キーワード | 投稿先` の形が一番よく当たる。候補は点の高い順で、切り詰めた時は残り件数を書く。",
    inputSchema: {
      type: "object",
      properties: {
        paper: {
          type: "string",
          description:
            "投稿予定の論文。`題名 | キーワード, キーワード | 投稿先` の形（1 行だけでも構はない）",
        },
        limit: { type: "number", description: "返す候補の数（既定 10・最大 30）" },
      },
      required: ["paper"],
    },
  },
  {
    name: "explain_word",
    description:
      "1 つの語が収録に何行当たるか（**素の照合で数へるので、`search_deadlines` の絞り込みを通した数とは違ふ事が在る**。行が出る時は中身を 3 行まで見せる）と、0 行の時に画面が出す案内文を其の儘返す（人が見る説明と AI の説明を同じにする。**`search_deadlines` と同じ案内を出す** – 表に出さん種別の選び方・収録に無い語・URL・この表が何を出す画面なのかも言ふ）。**0 行の時は「打ち直すなら」の次の一手も返す**（件数は実際に引いた時の行数と一致）。",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "調べる語（例: 学生でも投稿できる）" },
        scope: { type: "string", enum: ["screen", "all"], description: "見る窓（既定 screen）" },
      },
      required: ["word"],
    },
  },
] as const;

function callTool(name: string, args: Record<string, unknown>, now: number): string {
  if (name === "search_deadlines") return searchDeadlines(args, now);
  if (name === "list_upcoming") return listUpcoming(args, now);
  if (name === "venue_info") return venueInfo(args, now);
  if (name === "explain_word") return explainWord(args, now);
  if (name === "recommend_venues") return recommendVenues(args, now);
  if (name === "collection_stats") return collectionStats(now);
  throw new Error(`知らない道具: ${name}`);
}

/* ---- stdio の MCP（1 行 = 1 つの JSON-RPC）---- */

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(raw: string, now: number): void {
  let request: { id?: unknown; method?: unknown; params?: unknown };
  try {
    request = JSON.parse(raw) as typeof request;
  } catch {
    return; // 読めない行は默つて捨てる（MCP の決まり – 返事の形が作れない）
  }
  const { id, method } = request;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const reply = (result: unknown): void => send({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    const 求め =
      typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL;
    reply({
      protocolVersion: 求め,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  /* 通知（`notifications/*`）には返事を書かない（書くと相手が誤解する）。 */
  if (typeof method === "string" && method.startsWith("notifications/")) return;
  if (method === "ping") {
    reply({});
    return;
  }
  if (method === "tools/list") {
    reply({ tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = callTool(name, args, now);
      reply({ content: [{ type: "text", text }] });
    } catch (error) {
      /* 「Error: 」を外して讀める文にする（第 890 回 – 實測 2026-10-22: 知らない道具を
       * 呼ぶと「道具の実行に失敗: Error: 知らない道具: nope」と出て居た。`String(error)`
       * は `Error:` を先頭に付けるので、利用者が讀む文は其れを剝ぐ）。 */
      const 文 = String(error instanceof Error ? error.message : error).trim();
      reply({
        content: [{ type: "text", text: `道具の実行に失敗: ${文 || "不明な失敗"}` }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) fail(-32601, `知らない呼び出し: ${String(method)}`);
}

export function runStdio(now = Date.now()): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const raw = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (raw) handle(raw, now);
      at = buffer.indexOf("\n");
    }
  });
}

/* 人が確かめる道（`node src/mcp.ts search "セキュリティ" 5`）。 */
function main(): void {
  const [tool, ...rest] = process.argv.slice(2);
  if (!tool || tool === "--help" || tool === "-h") {
    process.stdout.write(
      [
        "kamiyobi の MCP サーバ（読み取り専用・stdio）。",
        "  AI から: MCP の客户として此のファイルを起動する（`node src/mcp.ts`）。",
        "  人から: 道具の名を引数に書くと 1 回だけ走らせて文字を出す。",
        `  道具: ${TOOLS.map((t) => t.name).join(" / ")}`,
        '  例: node src/mcp.ts search "セキュリティ" 5',
        '  例: node src/mcp.ts explain_word "学生でも投稿できる"',
        "  例: node src/mcp.ts list_upcoming 30",
        "  例: node src/mcp.ts venue_info kdd",
      ].join("\n") + "\n",
    );
    return;
  }
  const now = Date.now();
  /* 人の打ちやすい短い名も受ける（AI は MCP の名を其の儘使ふ）。 */
  const 別名: Record<string, string> = {
    search: "search_deadlines",
    upcoming: "list_upcoming",
    venue: "venue_info",
    explain: "explain_word",
    recommend: "recommend_venues",
    /* 殘りの一つにも讀みやすい短い名indle（第 904 回 – 其它 5 つに有るのに此れだけ無かった）。 */
    stats: "collection_stats",
  };
  const 名 = 別名[tool] ?? tool;
  /* **道具の名が違つたら、跡yticsではなく助けを書く**（第 904 回 – 實測 2026-10-31:
   * `node src/mcp.ts 検索` は Node の stack trace が出て居た。人が一到來た數が其のままで、
   * 何をputsれば良いかが讀めない）。 */
  if (!TOOLS.some((t) => t.name === 名)) {
    const 一覧 = [
      `知らない道具「${tool}」です。道具の名は下列の 6 つです（--help でも此れが出ます）。`,
      ...TOOLS.map((t) => `  ${t.name}${別名[tool] === t.name ? `（別名 ${tool}）` : ""}`),
      "",
    ].join("\n");
    process.stdout.write(`${一覧}\n`);
    return;
  }
  /* 人の道では、題名が空白で割れて渡つて來る。**末尾が數の時だけ**件數として扱ふ
   * （題名の語に數字が混ざる事がある – 全部を件數と讀むと、題名が削られる）。 */
  const 尾が數 = rest.length > 1 && /^\d+$/.test(String(rest[rest.length - 1] ?? ""));
  const args: Record<string, unknown> =
    名 === "search_deadlines" || 名 === "explain_word"
      ? { query: rest[0], word: rest[0], limit: rest[1] }
      : 名 === "recommend_venues"
        ? {
            paper: (尾が數 ? rest.slice(0, -1) : rest).join(" "),
            limit: 尾が數 ? rest[rest.length - 1] : undefined,
          }
        : 名 === "list_upcoming"
          ? { days: rest[0], kind: rest[1] }
          : (() => {
              /* 打たれた語が**そのまま key** に在る時は key として扱ふ。名の一部として引くと、
               * `sc` の様に 42 件の候補に割れてしまふ（實測 2026-10-12 – 其の語の會議を
               * 一意に指して居るのに、候補の一覽を返して居た）。 */
              const 語 = String(rest[0] ?? "").trim();
              const 其の儘 =
                Boolean(語) &&
                (snapshot().conferences ?? []).some(
                  (c) => String(c.key ?? "").toLowerCase() === 語.toLowerCase(),
                );
              return 其の儘 ? { key: 語 } : { name: 語 };
            })();
  process.stdout.write(`${callTool(名, args, now)}\n`);
}

/* 直接起動された時だけ stdio を開く（import した検査では開かない）。 */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 2) main();
  else runStdio();
}
