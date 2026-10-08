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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  conf: { key: string; title: string; acronym?: string; categories?: string[]; rank?: unknown };
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
function pick(scope: unknown): { list: Row[]; 名: string; 生成: unknown } {
  if (String(scope ?? "") === "all")
    return { list: allRows(), 名: "収録の全体", 生成: snapshot().snapshot_metadata?.generated_at };
  const 窓 = screenRows();
  return 窓
    ? { list: 窓, 名: "画面が最初に読む窓", 生成: catalog()?.generated_at }
    : { list: allRows(), 名: "収録の全体", 生成: snapshot().snapshot_metadata?.generated_at };
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

/** 0 件の時に畫面が出す案内と同じ物を組む（同じ函數から取る）。 */
function guidance(query: string, matched: number): string[] {
  if (matched > 0) return [];
  const out: string[] = [];
  const whole = String(Recommender.wholeTableQueryNoteJa(query) ?? "").trim();
  if (whole) out.push(whole);
  Recommender.querySynonymNotes(query).forEach((note) => {
    if (note) out.push(String(note));
  });
  const word = String(Recommender.uiWordNoteJa(query, false) ?? "").trim();
  if (word) out.push(word);
  return out;
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
  },
): Row[] {
  const 過去も = args.include_past === true;
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
  return list
    .filter((r) => {
      if (!過去も && r.t < now) return false;
      if (!推定も && r.est) return false;
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

/** 語が 0 件の時、**収録の會議の名前**に當たつて居ないかを見る（第 867 回）。
 *
 * 畫面の 0 件案内は「名簿に在るのに締切の行が 1 本も無い會議」を名指す（第 294 回）が、
 * 其の計算は畫面の側に在り、MCP は Recommender 層の案内しか使つて居なかつた – 締切を持たん
 * 會議の名前で引くと「1 行も出ません」とだけ言ひ、**収録に在る事**も、會期が何處に載るかも
 * 言はなかつた（實測 2026-10-08: `apnoms` は版 1 件・會期ありで upcoming.md に載つて居る）。 */
function 名乘りの案内(query: string, list: Row[]): string[] {
  const 語々 = query
    .toLowerCase()
    .split(/[\s、。，,・/|（）()「」『』【】]+/)
    .map((w) => w.trim())
    .filter((w) => [...w].length >= 2);
  if (!語々.length) return [];
  const 行の鍵 = new Set(list.map((r) => String(r.conf.key ?? "")));
  const 當たる = (snapshot().conferences ?? []).filter((c) => {
    const 名 = [
      String(c.key ?? ""),
      String(c.title ?? ""),
      String(c.acronym ?? ""),
      String(c.full_name ?? ""),
    ]
      .join(" ")
      .toLowerCase();
    return 語々.every((w) => 名.includes(w));
  });
  if (!當たる.length) return [];
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
    scope?: unknown;
  },
  now: number,
): string {
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
      args.online !== undefined);
  if (!query && !絞り込みだけ)
    return "検索語が空です。会議名・分野・開催地・締切の語をください（語を省くなら kind / kinds / rank / domestic / online の何れかを添へてください）。";
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const { list, 名, 生成 } = pick(args.scope);
  const 古さ = 古さの斷り(生成, now);
  /* 語が空（種別だけの時）は**全部に當たる**目にする（第 793 回）。 */
  const 照合 = 絞り込みだけ
    ? () => true
    : Recommender.searchMatcher(Recommender.expandRelativeMonths(query, now), now);
  const 素の = list.filter((r) => 照合(r.hay) === true);
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
  const 頭 = `${絞り込みだけ ? "語を指定せず、絞り込みだけ" : `検索語「${query}」に当たる締切`}: ${hit.length} 件（${名} ${list.length} 行・画面の既定と同じ絞り込み。絞る前は ${素の.length} 行${ランク ? `／ランク ${ランク}` : ""}${args.domestic === true ? "／国内のみ" : ""}${args.online === true ? "／オンライン参加可のみ" : ""}）${知らん.length ? `／知らない種別（其の侭では 0 件に成ります）: ${知らん.join("・")}` : ""}${知らんランク ? `／知らないランク（等級は ${Recommender.rankGradeOrderJa().join("・")}）: ${知らんランク}` : ""}${日付の語 ? "\n日付は日本時間（JST）。月や日付の語は、締切の日付と「会期」の日付の両方に当たる（画面のてびきと同じ約束）ので、月で引いた時に見出しの月と違ふ日が出る行が在る。" : ""}`;
  if (!hit.length) {
    /* 畫面と同じ約束 – 案内は「素の當たりが 0」の時に出る物なので、絞り込みで 0 に成つた時は
     * 其の旨を書く（絞り込みを外せば出る事がある）。 */
    const 案内 = 素の.length ? [] : guidance(query, 0);
    return [
      頭,
      "",
      素の.length
        ? `語は当たりますが、既定の絞り込み（今後の投稿締切・推定を除く）で 0 件に成りました。include_past / include_estimated / kinds${ランク ? " / rank（いま " + ランク + "）" : ""} を試してください。`
        : "この語では 1 行も出ません。",
      ...案内.map((n) => `案内: ${n}`),
      ...(素の.length ? [] : 名乘りの案内(query, list)),
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
  const days = Math.min(Math.max(Number(args.days) || 30, 1), 400);
  const 引き = args.kind ?? (args as { kinds?: unknown }).kinds;
  const 名乗り = (Array.isArray(引き) ? 引き : 引き === undefined ? [] : [引き])
    .map((k) => String(k).trim())
    .filter((k) => k.length > 0);
  const 全部 = 名乗り.some((k) => k.toLowerCase() === "all");
  const kind = 全部 ? "" : 名乗り.join(" ");
  const { list, 名, 生成 } = pick(args.scope ?? "all");
  const 古さ = 古さの斷り(生成, now);
  const 限り = now + days * 86400000;
  const hit = sortRows(
    list.filter(
      (r) => r.t >= now && r.t <= 限り && (!kind || r.kind === kind || r.dl.kind === kind),
    ),
  );
  return [
    `今日から ${days} 日以内の締切: ${hit.length} 件（${名}・日本時間の早い順）`,
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
        r.conf.key.toLowerCase().includes(求);
  const hit = list.filter(的);
  if (!hit.length) {
    /* **「收錄に無い」と「收錄に在るが締切の行が 1 本も無い」を混同しない**（第 866 回）。
     * 畫面は其の二つを分けて居る（第 294 回の實測: 品書の會議 248 件のうち 74 件は締切が 1 本も
     * 無い）。行から引くと、締切を持たん會議は「收錄に無い」と答へてしまふ – 收錄その物から引く。 */
    const 求 = name.toLowerCase();
    const 收錄の會議 = snapshot().conferences ?? [];
    const 在る = 收錄の會議.find((c) => {
      const key = String(c.key ?? "").toLowerCase();
      const title = String(c.title ?? "").toLowerCase();
      const acronym = String(c.acronym ?? "").toLowerCase();
      return (
        Boolean(key) &&
        (key === 求 || title.includes(求) || acronym.includes(求) || key.includes(求))
      );
    });
    if (在る) {
      const 版々 = Array.isArray(在る.editions) ? 在る.editions : [];
      const 會期あり = 版々.some((e) =>
        String((e as { event_start?: unknown } | null)?.event_start ?? "").trim(),
      );
      const link = String(在る.link ?? "").trim();
      return [
        `その会議は収録に在りますが、**締切の行が 1 本もありません**（版 ${版々.length} 件）。` +
          (會期あり
            ? "会期は収録に在るので、直近の一覧（upcoming.md）とカレンダー（deadlines.ics）には「開催」として載ります。"
            : "会期も確認できていないので、どの一覧にも出ません。"),
        ...(link ? [`公式ページ: ${link}`] : []),
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
  return [
    斷り +
      `会議: ${一つ.conf.title}（key: ${一つ.conf.key}${一つ.conf.acronym ? `・${一つ.conf.acronym}` : ""}）`,
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
  const { list, 名, 生成 } = pick(args.scope);
  const 古さ = 古さの斷り(生成, now);
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(word, now), now);
  const 件數 = list.filter((r) => 照合(r.hay) === true).length;
  if (件數 > 0) {
    /* 行が出る時は**中身を少し見せる**（第 796 回 – 前は「search_deadlines で引けます」とだけ
     * 言つて居たので、語を調べた人がもう一往復する必要が在つた。AI も同じ）。行は
     * `search_deadlines` と同じ形（`line()`）で、3 行まで。 */
    const 素の行 = list.filter((r) => 照合(r.hay) === true);
    /* **兩方の數を言ふ**（第 797 回 – 素の照合と、画面の既定の絞り込みを通した數は違ふ。片方だけ
     * 言ふと「同じ語で違ふ數字」に成る – 第 796 回に實測: `ポスター` は素 9 行・絞り込み後 0 件）。*/
    const 畫面の行 = 畫面の既定(素の行, now, {});
    const 行 = sortRows(畫面の行).slice(0, 3);
    return [
      `「${word}」は素の照合で ${件數} 行・画面の既定の絞り込み（今後・投稿締切の種別・推定を除く）を通すと ${畫面の行.length} 行です（${名}）。`,
      ...行.map((r) => `- ${line(r, now)}`),
      ...(畫面の行.length > 行.length
        ? [`- …ほか ${畫面の行.length - 行.length} 行（search_deadlines で引けます）`]
        : []),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  const 案内 = guidance(word, 0);
  /* 打ち直しの見當も渡す（第 763 回 – `search_deadlines` と同じ扱ひに揃へる。語を調べる人が
   * 「では何と打てばよいか」まで一往復で分かる樣に）。件數は照合そのもので數へる（第 762 回）。 */
  const 手 = retypeTips(word, 畫面の既定(list, now, {}), now);
  return [
    `「${word}」は 0 行です。画面が此の時に出す案内:`,
    ...(案内.length ? 案内.map((n) => `- ${n}`) : ["- （案内は無し＝表の語では無い語）"]),
    /* 語が 0 行でも、**収録の會議の名前**に當たつて居れば其の旨を言ふ（第 867 回 –
     * `search_deadlines` と同じ扱ひに揃へる。「この語は知らない」と「此の會議は締切を持たん」
     * は別の事で、後者は次の一手（會期を見る・upcoming.md を見る）に繋がる）。 */
    ...名乘りの案内(word, list).map((n, i) => (i === 0 ? `- ${n}` : `  ${n}`)),
    ...手.map((t) => `- 打ち直すなら ${t}`),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

/** 收錄その物の數（第 769 回）。「何件を覆つて居るか」「どのファイルが在るか」を一往復で答へる –
 * AI が「この收錄は何か」を説明する時、人にファイルを渡す時に要る。**數字は llms.txt と同じ物**を
 * 同じ入口（`data/snapshot.json`）から數へる。`scope` は取らない（收錄の全體を數へるのが役目）。 */
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
  const ファイル = [
    "index.html（画面。絞り込みと検索）",
    "upcoming.md / upcoming.html（直近 180 日の表）",
    "data.csv（1 行 1 締切の平坦な表）",
    "deadlines.ics（カレンダー。1 日 1 件の終日）",
    "data.json（収録の全体。機械可読の正）",
    "llms.txt（機械向けの索引。何が何処に在るか）",
  ];
  return [
    `収録（${DATA_PATH.replace(`${ROOT}/`, "")}）: 会議 ${会議} 件 / 版 ${版} 件（生の収録。建てる時は同じ物を束ねるので、建てた表示とは少し違い得る）/ 締切の行 ${list.length} 行（日付の幅 ${日[0]} 〜 ${日[日.length - 1]}）`,
    `データ生成: ${生成の表示(元の生成)}（上の行と同じ出所。画面の右上と同じ書き方）`,
    ...(窓の生成 ? [`画面が最初に読む窓（public/catalog.json）のデータ生成: ${窓の生成}`] : []),
    `うち今後の締切: ${今後} 行（${new Date(now).toISOString().slice(0, 10)} 以降）`,
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
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  const lines = Recommender.parsePaperLines(paper);
  if (!lines.length)
    return "論文の題名を読み取れませんでした。題名を 1 行でください（`|` でキーワードと投稿先を添へられます）。";
  const 候補 = Recommender.venueRecommendations(索引.rows, lines, null, now, {
    fieldedLexical: true,
  }).filter((r) => r.fit.score >= 10);
  const 題 = lines
    .map((l) => String(l.title ?? "").trim())
    .filter(Boolean)
    .join(" / ");
  const 頭 = `「${題}」に合う投稿先: ${候補.length} 件（語の一致だけで評価 – 意味検索の埋め込みは読まないので、埋め込みを使へる画面とは点が少し動く事がある）`;
  if (!候補.length)
    return [
      頭,
      "",
      "この題名の語と重なる投稿先は見付かりませんでした。題名に加へて、分野の語やキーワード（`tsn, real-time, scheduling` の様に）を添へると当たりやすくなります。",
    ].join("\n");
  const 見本 = 候補.slice(0, limit);
  return [
    頭,
    `（一致評価の高い順。${limit} 件まで表示${候補.length > limit ? `・残り ${候補.length - limit} 件` : ""}）`,
    "",
    ...見本.map((r, i) => {
      const 評價 = `${String(r.fit.label ?? "評価保留")}（${Number(r.fit.score) || 0} 点）`;
      return `${i + 1}. 一致評価 ${評價}｜${line(r.row as unknown as Row, now)}`;
    }),
  ].join("\n");
}

const TOOLS = [
  {
    name: "search_deadlines",
    description:
      "**語を省いて `kind` / `kinds` だけでも引ける**（「登録締切を全部」の様な聞き方）。kamiyobi の収録（国際会議・国内研究会の締切と会期）を日本語で引く。会議名・分野・開催地・締切の語・相対日付（『今月』『30日以内』『来週』など）が使へる。**0 件の時は、画面と同じ案内（其の語が表に無い事）と、同じ「打ち直すなら」の次の一手を返す** – 其の一手の件数は、実際に引いた時に出る行数と一致する（その侭打ち直せる）。**0 件の時は、収録の会議の名前に当たっていないかも見る**（「締切の行が 1 本もありません」「会期は upcoming.md に『開催』として載ります」のように、収録に在る事と、何処を見ればよいかを言う – 「収録に無い」とは言わない）。**必須の引数は無い**。絞り込みは画面と同じ物が揃っている（`kinds`・`rank`・`domestic`・`online`・`include_past`・`include_estimated`）。行にはランク（`CCF A・CORE A*` の形。無い行は「ランク未確認」）・会期・確認の状態の札（`複数候補のため要確認` など。確認済みと未設定では付かない）と `延長後` も付く。収録が古ければ、末尾に画面と同じ断りが付く。",
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
      "今日から N 日以内の締切を日本時間の早い順に返す（**種別では絞らない** – 登録・カメラレディ・採否通知も混ざる。投稿の締切だけ見るなら search_deadlines を使ふ）。100 件を超える時は其の旨と残り件数を末尾に書く。行にはランク（`CCF A・CORE A*` の形。無い行は「ランク未確認」）・会期・確認の状態の札も付く。",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "何日先まで（既定 30・最大 400）" },
        kind: {
          type: "string",
          description: '種別のキー（例: paper / abstract / camera_ready。全部なら "all"）',
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "種別のキーの並び（search_deadlines と同じ名。どちらでも受ける）",
        },
        scope: { type: "string", enum: ["screen", "all"], description: "見る窓（既定 all）" },
      },
    },
  },
  {
    name: "venue_info",
    description:
      "1 つの会議の版・分野・締切・会期を返す。**key（識別子）・name（名前の一部）・略称の何れでも引ける**。締切は**今後の物から**並ぶ（同じ側では日の早い順）。今後の締切が無い会議では其の旨を先に言ふ。名乗りが割れた時は候補（名・key・公式 URL）を並べて決め打たない。**分野とランク（`CCF A・CORE A*` の形）も返す**。行には会期と確認の状態の札も付く。収録が古ければ、末尾に画面と同じ断りが付く。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会議の識別子（例: kdd）" },
        name: { type: "string", description: "会議名の一部（例: KDD）" },
        scope: { type: "string", enum: ["screen", "all"], description: "見る窓（既定 all）" },
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
      "投稿予定の論文（題名・キーワード・概要）に合う投稿先を、一致評価の高い順に返す（画面の「投稿先を探す」と同じ推薦核を使ふ）。**語の一致だけで評価する**ので、意味検索の埋め込みを使へる画面とは点が少し動く事がある（其の旨は返り値の頭に書く）。入力は画面と同じ `題名 | キーワード, キーワード | 投稿先` の形が一番よく当たる。候補は点の高い順で、切り詰めた時は残り件数を書く。",
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
      "1 つの語が収録に何行当たるか（**素の照合で数へるので、`search_deadlines` の絞り込みを通した数とは違ふ事が在る**。行が出る時は中身を 3 行まで見せる）と、0 行の時に画面が出す案内文を其の儘返す（人が見る説明と AI の説明を同じにする）。**0 行の時は「打ち直すなら」の次の一手も返す**（件数は実際に引いた時の行数と一致）。",
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
      reply({
        content: [{ type: "text", text: `道具の実行に失敗: ${String(error)}` }],
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
  };
  const 名 = 別名[tool] ?? tool;
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
          : { name: rest[0] };
  process.stdout.write(`${callTool(名, args, now)}\n`);
}

/* 直接起動された時だけ stdio を開く（import した検査では開かない）。 */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 2) main();
  else runStdio();
}
