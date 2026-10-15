#!/usr/bin/env node

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Recommender from "../site/recommendation.ts";
import {
  isRecommendationAxes,
  recommendationAxes,
  venueEvidenceLineJa,
} from "../site/recommendation-core.ts";
import { isValidRerankerModel } from "../site/recommender.ts";
import {
  consolidateReviewedSubmissions,
  type SubmissionDisplay,
} from "../site/submission-identity.ts";
import type { SemanticModelError } from "./semantic-model-error.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/* 画面が最初に読む窓（180 日）と、収録の全体。**数字を画面と一致させる**のが肝なので、
 * 先づ画面と同じ窓（`public/catalog.json`）を見る。無ければ（まだ建てて居ない・配付物を
 * 持たない手元）収録の全体（`data/snapshot.json`）へ落ちて、その旨を言う。 */
const CATALOG_PATH = join(ROOT, "public", "catalog.json");
const DATA_PATH = join(ROOT, "data", "snapshot.json");
/* 投稿先推薦の索引（建てた物）。**画面が読むのと同じファイル**を使う – 別の索引を持つと、
 * AI が擧げる候補と画面の候補が違ふ。 */
const RECOMMENDATION_PATH = join(ROOT, "public", "recommendation-index.json");
const SERVER_NAME = "kamiyobi";
const SERVER_VERSION = "1.0.0";
const EVENT_ONLY_NOTICE_JA =
  "会期は収録にあります。全開催回の日程は venue_info で確認できます。直近一覧（list_upcoming / upcoming.md）は対象期間内の開催だけを扱います。購読カレンダー（deadlines.ics）は締切のみです。";
const DEFAULT_PROTOCOL = "2025-06-18";

/* 行の形（`Recommender.candidateRows` が返す物の内、ここで使う分だけ）。 */
interface Row {
  conf: {
    key: string;
    title: string;
    acronym?: string;

    full_name?: string;
    link?: string;
    categories?: string[];
    rank?: unknown;
    /** 主題のタグ（`machine-learning` など）。畫面の行の詳細の「主題」と同じ正本から組む。 */
    tags?: string[];
  };
  /** ランクの対（`ccf:A`・`core:A*` の形）。画面のランク列と同じ正本から組む。 */
  rankPairs?: string[];
  /** 会議のタグ（`domestic-jp` など）。画面の「国内研究会…のみ」と同じ判定に使う。 */
  tags?: string[];
  ed: {
    id: string;
    year?: number;
    place?: string;
    link?: string;
    event_start?: string;
    event_end?: string;
    /** 上流が書いた會期の原文（`March 18-21, 2024` のやうな自由文）。 */
    date_text?: string;
    event_date_precision?: unknown;
    event_segments?: Array<{ start?: unknown; end?: unknown; label?: unknown }>;
    event_review?: unknown;
    estimate?: unknown;
  };
  dl: {
    kind: string;
    label?: string;
    round?: number;
    precision?: string;
    tz_raw?: string;
    utc?: string;
    track?: string;
    earliest_utc?: string;
    latest_utc?: string;
    /** 確認の状態（上流が付けた印。オブジェクトの事と文字列の事がある – 語は画面と同じ正本）。 */
    verification?: { status?: string } | string;
  };
  submission?: SubmissionDisplay;
  kind: string;
  est: boolean;
  t: number;
  /** 画面が「表示している暦日」として出す時刻（`t` と 1 日ずれる行がある – 窓と果てはこちらを見る）。 */
  tShown?: number;
  localDate: string;
  dateOnly: boolean;
  hay: string;
}

let screenCache: Row[] | null = null;
let allCache: Row[] | null = null;

/* 元のファイルを一度だけ読んで憶える（行と**生成時刻**を同じ物から取る）。画面は右上に
 * 「データ生成」を常に出しているので、MCP がそれを言はないと、人が見た日付と AI の答へが
 * 違ふ（人が見る物と AI が言う物を同じにする、がこの計画の決まり）。 */
interface SnapshotFile {
  conferences?: Array<{
    key?: unknown;
    title?: unknown;
    acronym?: unknown;
    full_name?: unknown;
    link?: unknown;
    categories?: string[];
    rank?: unknown;
    tags?: string[];
    editions?: unknown[];
  }>;
  snapshot_metadata?: { generated_at?: unknown };
}
let snapshotCache: SnapshotFile | null = null;
let catalogCache: Record<string, unknown> | null | undefined;

/** 収録全体を保存した `data/snapshot.json`。 */
function snapshot(): SnapshotFile {
  if (!snapshotCache) snapshotCache = JSON.parse(readFileSync(DATA_PATH, "utf8")) as SnapshotFile;
  return snapshotCache;
}

/** 画面が最初に読む窓。有効な会議配列がなければ null。 */
function catalog(): Record<string, unknown> | null {
  if (catalogCache === undefined) {
    try {
      const value: unknown = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
      const conferences =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).conferences
          : undefined;
      catalogCache =
        Array.isArray(conferences) &&
        conferences.every((conf) => conf && typeof conf === "object" && !Array.isArray(conf))
          ? (value as Record<string, unknown>)
          : null;
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

/** 収録の全体の行。 */
function allRows(): Row[] {
  if (!allCache) allCache = Recommender.candidateRows(snapshot() as never) as unknown as Row[];
  return allCache;
}

/** 使う窓を決める（既定は画面と同じ。`scope: "all"` で収録の全体）。
 * **生成時刻も一緒に返す** – 窓に依って出所のファイルが違ふので、古さの斷りもそれに合わせる。 */

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

function displayRows(list: Row[]): Row[] {
  return consolidateReviewedSubmissions(
    list,
    (row) => `${row.conf.key}|${row.ed.year ?? ""}|${row.kind}|${Math.trunc(row.t)}`,
  );
}

function pick(scope: unknown): { list: Row[]; 名: string; 生成: unknown; 窓が無い: boolean } {
  scopeErr = "";

  if (String(scope ?? "") !== "" && scopeValue(scope) === "")
    scopeErr =
      `知らない scope「${String(scope)}」です（screen＝画面の窓／all＝収録の全体。` +
      "collection・full・window・catalog も受ける）。そのままの窓で出しました。";
  if (scopeValue(scope) === "all")
    return {
      list: displayRows(allRows()),
      名: "収録の全体",
      生成: snapshot().snapshot_metadata?.generated_at,
      窓が無い: false,
    };
  const 窓 = screenRows();
  return 窓
    ? {
        list: displayRows(窓),
        名: "画面が最初に読む窓",
        生成: catalog()?.generated_at,
        窓が無い: false,
      }
    : {
        list: displayRows(allRows()),
        名: "収録の全体",
        生成: snapshot().snapshot_metadata?.generated_at,
        窓が無い: true,
      };
}

/** 窓が無い時の斷り（一覽を返す道具の頭に付ける）。空文字の時は何も足さない。 */
function 窓が無いの斷り(窓が無い: boolean): string {
  if (!窓が無い) return "";
  return (
    "※ 画面が最初に読む窓（public/catalog.json）がないか、有効な会議一覧を読み取れないため、収録の全体を読んでいます。" +
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

/** 瞬間を日本時間で書く（画面の日時欄と同じ読み）。`秒も` は締切の行だけ –
 * 画面の「データ生成」は分までしか書かないので、同じ物は同じ書き方で出す。 */
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

/** 画面の右上の「データ生成」と同じ書き方（分まで）。読めない値は原文のまま返す
 * （画面と同じ扱ひ – 勝手に日付を作らない）。 */
function 生成の表示(生成: unknown): string {
  /* 未確認の札は**正本から取る**。 */
  const raw = typeof 生成 === "string" ? 生成.trim() : "";
  if (!raw) return String(Recommender.unconfirmedLabelJa() ?? "未確認");
  const at = Date.parse(raw);
  return Number.isFinite(at) ? jst書(at, false) : raw;
}

/** 画面と同じ「データは N 日前」の斷り（生成から 3 日以上の時だけ）。**同じ関数から取る**ので、
 * 閾値も日数の数へ方も画面と必ず一致する。 */

function ソースの狀態(): string[] {
  const 更新 = (catalog() as { source_updates?: unknown } | null)?.source_updates;
  if (!Array.isArray(更新) || !更新.length) return [];

  const 語: Record<string, string> = {
    fresh: "今回あたって取得",
    success: "今回あたって取得",
    "cache-fallback": "前回の取得データを使用",
    "snapshot-fallback": "保存済みの収録データを使用",
    failed: "上流から取得できませんでした（そのソースの会議は収録にない）",
  };
  const 一覧 = (更新 as Array<{ name?: unknown; status?: unknown; fetched_at?: unknown }>)
    .map((u) => {
      const 名 = String(u.name ?? "?");
      const 狀態 = String(u.status ?? "");
      const 見た = Date.parse(String(u.fetched_at ?? ""));
      const 日 = Number.isFinite(見た) ? new Date(見た).toISOString().slice(0, 10) : "";
      const 説 = 語[狀態] ?? `解釈できない状態（${狀態}）`;
      return `${名}: ${説}${日 ? `（${日} に取得）` : ""}`;
    })
    .join("・");
  return [`上流のソース: ${一覧}`];
}

function 古さの斷り(生成: unknown, now: number): string {
  return String(Recommender.dataAgeNoteJa(生成, now) ?? "").trim();
}

/** ランクの語（画面のランク列と同じ入口・同じ語）。無い行は画面と同じく「ランク未確認」と
 * 書く – **書かないと、AI が「ランクが無い」と読むか「こちらの抜け」と読むか決まらない**。 */
function ランクJa(r: Pick<Row, "rankPairs">): string {
  return (
    (r.rankPairs ?? [])
      .map((pair) => String(Recommender.rankPairLabelJa(pair) ?? "").trim())
      .filter(Boolean)
      .join("・") || `ランク${String(Recommender.unconfirmedLabelJa() ?? "未確認")}`
  );
}

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

function officialLink(editionLink: unknown, venueLink?: unknown): string | null {
  for (const value of [editionLink, venueLink]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function placeDisplayJa(value: unknown): string {
  return String(Recommender.placeJa(Recommender.placeWithPrefectureJa(value)) ?? "").trim();
}

/** 1 行を 1 行の文字にする。**語は画面の列と同じ入口から取る**（日時・種別・会議・ランク・
 * 会期・開催地）。並びはこちらの都合（日時 → 種別 → 会議 → ランク → 会期 → 開催地）で、
 * 画面の列の順その侭ではない。 */
function line(r: Row, now: number): string {
  const 常時受付 = r.kind === "journal" && !r.dl.utc && !r.dateOnly;
  const 締切未確認 = !常時受付 && !Number.isFinite(r.t);
  const 日 = 常時受付
    ? "常時受付（締切なし）"
    : 締切未確認
      ? "投稿締切未確認"
      : r.dateOnly
        ? r.localDate
        : jst(r.t);
  const 日の狀態 = Recommender.dateOnlyStateJa(r, now);
  /* 残りの語は**画面の「残り」欄と同じ入口**（`Recommender.remainingLabelJa` –
   * app.ts の `remain()` と同じ語・同じ JST の暦日差）。此処で 24 時間の floor を
   * 自分で数へて居たため、畫面と AI の答へが違ふ日に成って居た（實測 2026-10-15: CHES の
   * 2026-10-15 20:59 JST は MCP が「残り0日」・畫面が「あと 18 時間」。過去の行は
   * 「殘り（過ぎた）」と言ふ、意味の通らない文が出て居た）。 */
  const 殘り文 =
    常時受付 || 締切未確認
      ? ""
      : r.dateOnly
        ? 日の狀態 === "definitely-past"
          ? "（時刻未確認。締切日経過）"
          : 日の狀態 === "uncertain-on-date"
            ? "（時刻未確認。すでに終了している可能性があります）"
            : ""
        : ` ${Recommender.remainingLabelJa(r.t, now).text}`;

  const トラック = String((r.dl as { track?: unknown }).track ?? "").trim();
  const 種別 =
    String(Recommender.kindLabelJa(r.kind) ?? r.kind) + (トラック ? `（${トラック}）` : "");
  const 回 = (r.dl.round ?? 1) > 1 ? ` R${r.dl.round}` : "";
  /* 場所の「未確認」も**正本から取る**と同じべた書きだつた。書き寫すとずれる）。 */
  const 場所 = placeDisplayJa(r.ed.place) || String(Recommender.unconfirmedLabelJa() ?? "未確認");
  const ランク = ランクJa(r);
  /* 一覧の行に付く**札**も入れる（画面の列の外にある印 – 語も入口も画面と同じ。
   * `app.ts` が札を並べる順と同じ：①延長②検証状態③締切を過ぎた事④国内）。 */
  const 差し替え = String(Recommender.deadlineShiftLineJa(r.dl) ?? "").trim();
  /* 過ぎた行の札。畫面は「締切済み」の外に、**會期がこれからの行**と**同じ会議の次回が
   * 確認できる行**を別の札で出す（`pastDeadlineTagJa` – 行の詳細の「今後の会期」と同じ
   * 入口）。此を言はないと、AI が「もう出せない會議」として片付けて了ひ、
   * 會期がまだ先の行を見落とす（實測 2026-10-16: ICDE の過去 18 行のうち 17 行は
   * 會期がこれから – MCP は「N 日前に終了」とだけ言つて居た）。 */
  const 過ぎた札 = String(Recommender.pastDeadlineTagJa(r, now) ?? "").trim();
  /* 国内の札。畫面は列の外に「国内」を出す（`domestic-jp` は構造のタグなので主題欄には
   * 出さない）。此を言はないと、**日本で開催される國際会議**（CSFW 2027 の東京など）と
   * 國內の學會を區別できない（實測 2026-10-16: 畫面は 38 行に出して居た）。
   * 語も判定も recommender の正本から取る（此処に寫かない）。 */
  const 國內の札 = String(Recommender.domesticTagLabelJa(r.tags) ?? "").trim();
  const 印 = [
    Recommender.isExtendedDeadline(r.dl) ? String(Recommender.extendedLabelJa() ?? "").trim() : "",
    String(Recommender.verificationStatusLabelJa(r.dl?.verification) ?? "").trim(),
    過ぎた札,
    國內の札,
  ].filter(Boolean);
  if (差し替え) 印.push(差し替え);
  /* **会期も入れる**（画面の「会期」列と同じ入口 `eventCellJa`）。出張の段取りはこれで決める
   * ので、締切だけ言へても足りん。決まって居ない行は画面と同じ語（常時受付の期刊行は
   * 「該当なし」、それ以外は「未確認」）で書く – 黙ると「無い」と読まれる。 */
  const 會期 =
    String(Recommender.eventCellJa(r) ?? "").trim() ||
    String(
      Recommender.fieldNotApplicableJa(r)
        ? Recommender.notApplicableLabelJa()
        : Recommender.unconfirmedLabelJa(),
    );

  const 會期の文 = 會期 + eventAnnotationsJa(r.ed, 會期);

  const 幅 = String(Recommender.estimateWindowJa(r.ed) ?? "").trim();
  const 推定 = r.est ? "（推定）" : "";

  const 幅の但し = 幅 ? "（残りは点推定点の分）" : "";
  const sourceUrl = officialLink(r.ed.link, r.conf.link);
  const 出典 = sourceUrl ? ` ${sourceUrl}` : "";
  const 募集言語 = r.submission ? `（募集言語: ${r.submission.language}）` : "";
  /* 画面の日時欄は「日本時間の読み」と「元の日時」の二段で出す。**日本時間で無い宣言**の行は、
   * 宣言した時間帯と瞬間（UTC）を添へる（実測 2026-10-06: `dl.tz_raw` は AoE・UTC-7・PDT・
   * JST など。`dl.aoe` は**何れの行にもある派生値**なので、宣言を言うには使へない）。*/
  const tz = String(r.dl.tz_raw ?? "").trim();
  const utc = String(r.dl.utc ?? "");
  const 元 =
    tz && utc && !/^JST$/i.test(tz)
      ? `（元の宣言 ${tz}／${utc.replace("T", " ").replace("Z", " UTC")}）`
      : "";
  return `${幅 ? 幅 : 日}${幅の但し}${殘り文}${元} | ${種別}${回}${推定}${募集言語}${印.length ? ` | ${印.join("・")}` : ""} | ${r.conf.title}（${r.ed.id}）| ${ランク} | ${會期 === "会期未発表" ? 會期の文 : `会期 ${會期の文}`} | ${場所}${出典}`;
}

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
  /* 欄の名前（`分野` `種別` `会場` など）を打たれた人。値ではないので、語を
   * 短くしても増えない – 値の例を名指して送る。 */
  const column = String(
    Recommender.columnQueryNoteJa(query, (語: string) =>
      list.some((r) => 照合を組む(語)(r.hay) === true),
    ) ?? "",
  ).trim();
  if (column) out.push(column);

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

function 日數幅の案内(
  query: string,
  list: Row[],
  now: number,
  args: Parameters<typeof 畫面の既定>[2],
): string[] {
  if (!String(Recommender.dayRangeNoteJa(query) ?? "").trim()) return [];
  const 日數 = Recommender.dayRangeDaysJa(query);
  /* 幅の終はりが書かれて居ない言ひ方（「3日前まで」）は、過去の幅なので絞らん。 */
  if (日數 === null)
    return [
      "幅の終わりが書かれていない言い方（過去の幅）なので、検索語では絞りません。その範囲は過ぎています – include_past: true を付けると並びます。",
    ];

  const 件數 = 畫面の既定(list, now, { ...args, within_days: 日數 }).length;
  /* 時間・分の幅は日で丸める（この表は締切を日単位で持つ – 画面の同じ斷りと同じ事）。
   * 「3時間以内」に「同じ幅」と言うと、丸めた事が傳はらん。 */
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

/** 一覧の中で一番遠い締切の日（JST の暦日。画面の `farthestRowDayJa` と同じ物を、
 * こちらの行の形で数へる）。時刻を持たん行は数へない。 */
function 一番遠い日(list: Row[]): string {
  let best = Number.NEGATIVE_INFINITY;
  for (const r of list) {
    const shown = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
    if (typeof shown !== "number" || !Number.isFinite(shown)) continue;
    if (shown > best) best = shown;
  }
  if (!Number.isFinite(best)) return "";
  /* JST の暦日（オフセットはここに置く – 画面と同じ数へ方）。 */
  const jst = new Date(best + 9 * 3600000);
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())}`;
}

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

const 語の截 = 400;
function 調べる語(語: string): { 使ふ: string; 切つた: boolean } {
  if (語.length <= 語の截) return { 使ふ: 語, 切つた: false };
  return { 使ふ: 語.slice(0, 語の截), 切つた: true };
}

function 文字として讀む(值: unknown): string {
  if (值 === undefined || 值 === null) return "";
  const t = typeof 值;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") {
    return String(值).trim();
  }
  return "";
}

function 名乘りとして讀む(引き: unknown): string[] {
  if (引き === undefined || 引き === null) return [];
  const 列 = Array.isArray(引き) ? 引き.flat(Number.POSITIVE_INFINITY) : [引き];
  return 列
    .map((k) => 文字として讀む(k))
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

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
      斷り: `／${名} は ${最小} 以上の数で指定してください（いま ${JSON.stringify(値)}）。その値は使わず、未指定として扱います`,
      省かれた: false,
    };

  const 讀み替へ = typeof 値 !== "number";
  return {
    使ふ: n,
    斷り: 讀み替へ
      ? `／${名} は数で指定してください（いま ${JSON.stringify(値)} – 数値に変換しました）`
      : "",
    省かれた: false,
  };
}

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
    斷り: `／${名} は true か false で指定してください（いま ${JSON.stringify(値)}）。その値は使わず、既定の設定を使います`,
  };
}

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
    /** 「締切まで N 日」の窓（画面の同じ名前の選擇欄。第 872 回）。 */
    within_days?: unknown;
  },
): Row[] {
  const 過去も = args.include_past === true;
  const 窓の日數 = Number(args.within_days);
  const 窓あり = Number.isFinite(窓の日數) && 窓の日數 > 0;
  const 推定も = args.include_estimated === true;
  const 引き = args.kinds ?? (args as { kind?: unknown }).kind;

  const 種別 = Array.isArray(引き)
    ? 引き.map((k) => 種別の英語(String(k)))
    : typeof 引き === "string"
      ? [種別の英語(引き)]
      : null;

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

  const ランク = Recommender.rankGradeJa((args as { rank?: unknown }).rank);

  const 國內だけ = args.domestic === true;
  const オンラインだけ = args.online === true;

  const 窓の上限 = 窓あり ? Recommender.withinDaysLimitMs(窓の日數, now) : 0;
  const 窓の下限 = 窓あり && 過去も ? Recommender.withinDaysFloorMs(窓の日數, now) : 0;
  return list
    .filter((r) => {
      if (!過去も && Recommender.deadlineRowIsPast(r, now)) return false;
      if (!推定も && r.est) return false;
      if (窓あり) {
        const 日 = typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
        if (日 >= 窓の上限) return false;
        if (窓の下限 && 日 < 窓の下限) return false;
      }
      if (ランク && !Recommender.rankMatches(r.rankPairs ?? [], ランク)) return false;
      /* 国内は**主催の區分**（日本で開かれる会議ではない）。判定は画面と同じタグ一本。 */
      if (國內だけ && (r.tags ?? []).indexOf("domestic-jp") < 0) return false;
      /* オンラインは会場の表記から画面と同じ関数で見る。 */
      if (オンラインだけ && !Recommender.placeOffersOnline(r.ed.place)) return false;
      if (全部) return true;
      if (種別?.length) return 種別.includes(r.kind);
      return 投稿の種別.includes(r.kind);
    })
    .concat(知らん.length ? [] : []);
}

function 窓の外の件數(照合: (hay: string) => boolean, 名: string): number {
  if (名 !== "画面が最初に読む窓") return 0;
  return allRows().filter((r) => 照合(r.hay) === true).length;
}

/** 名前の殼の中で、語が**獨立に立つ**か（英数字は前後が區切りの事を要求する – `sc` が
 * `science` や `isca` に当たらない。画面の `nameOnlyConferenceMatch` と同じ規則）。 */
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

function 語ごとの案號(query: string, list: Row[], now: number, 全部の收錄?: Row[]): string[] {
  if (Recommender.looksLikeUrlQuery(query)) return [];
  /* 上の第 1033 回の注 – **収録の全体**で数へる（窓だけで数へると「収録に見当たらない」
   * が噓に成る）。収録の全体を渡して居ない時（窓がそのまま全部の時）はそのまま。 */
  const 數へる對照 = 全部の收錄 ?? list;
  const 件數 = Recommender.queryTermCounts(
    Recommender.expandRelativeMonths(query, now),
    數へる對照.map((r) => r.hay),
    now,
  );
  if (件數.length < 2) return []; // 語が一つの時は他の家（打ち直し・種別の話）が受持ちを持つ。
  const 死んだ語 = 件數.filter((t) => t.count === 0).map((t) => t.term);
  const 殘り = 件數.filter((t) => t.count > 0);
  if (死んだ語.length) {
    /* 總ての語が死語なら「外すと増えます」とは言はない（外した残りは空に成る）。 */
    const 外しても = 死んだ語.length === 件數.length ? "" : "その語を外すと増えます。";

    const 殘りの死語 = 死んだ語.length - 2;
    return [
      `検索語のうち${死んだ語
        .slice(0, 2)
        .map((w) => `「${w}」`)
        .join(
          "・",
        )}は収録データにも見当たりません。${殘りの死語 > 0 ? `（ほか ${殘りの死語} 語も） ` : ""}${外しても}`,
    ];
  }
  /* どれも収録にあるのに「全部を含む行」が無い時 – 語ごとの件数を出して、どれを外すか選ばせる。 */
  if (殘り.length === 件數.length)
    return [
      `語をすべて含む行はありません（${件數
        .slice(0, 3)
        .map((t) => `「${t.term}」${t.count}件`)
        .join(
          "・",
        )}${件數.length > 3 ? `・ほか ${件數.length - 3} 語` : ""}）。いずれかの語を外すと増えます。`,
    ];
  return [];
}

function 隱れた種別の語(query: string): string[] {
  const table = Recommender.kindLabelTable();
  const 表に出さん種別 = Object.keys(table)
    .filter((kind) => 投稿の種別.indexOf(kind) < 0 && kind !== "all")
    .map((kind) => String(table[kind] || ""));
  return Recommender.queryHiddenKindMatches(query, 表に出さん種別);
}

function 受皿の案內(): string[] {
  /* 品書が持つ分野の地圖（`catalog.json` の `categories`）を、**画面のと同じ順・同じ札**で
   * 並べる（品書はそれを見てチツプを出す – こちらが別に拾ふと增えた分野が落ちる）。 */
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
      ? `分野の欄は${分野.join("・")}の${分野.length}種だけで、他の分野の言葉でもその語を行に持つ締切なら当たります。`
      : "") +
    "この表が出すのは催し物の名前・締切の日・分野・種別・開催地・参加形式で、くわしくは画面の『見方のてびき』に書いています";
  return [受皿];
}

function URLの案内(query: string): string[] {
  if (!Recommender.looksLikeUrlQuery(query)) return [];
  return [
    "検索語の URL の会議は収録に見当たりません。収録の中心はランク付けの一覧に載る会議と国内研究会です。公式ページのアドレスではなく会議名（「ICDE」など）で試してください。",
  ];
}

function 知らない値の文(ラベル: string, 知らん: string[]): string {
  if (!知らん.length) return "";
  const 例 = 知らん.slice(0, 3).join("・");
  const 殘り = 知らん.length - 3;
  return 殘り > 0 ? `${ラベル}${例}・**ほか ${殘り} 個**` : `${ラベル}${例}`;
}

function 端數と上限の斷り(使ふ値: number | null | undefined, 上限: number): string {
  if (使ふ値 === null || 使ふ値 === undefined || !Number.isFinite(使ふ値)) return "";
  const 端數を切つた後 = Math.floor(使ふ値);
  const 端數の文 = Number.isInteger(使ふ値)
    ? ""
    : `（${使ふ値} は端数なので、${端數を切つた後} として切りました）`;
  const 上限の文 =
    端數を切つた後 > 上限 ? `（上限 ${上限} を超えたので ${上限} として切りました）` : "";
  return 端數の文 + 上限の文;
}

function 種別の英語(k: string): string {
  const key = Recommender.kindKeyJa(k);
  return key !== "" && key !== k ? key : k;
}

function 種別の報べ(
  query: string,
  list: Row[],
  now: number,
  args: Record<string, unknown> | undefined,
  // 素で当たつた行（無ければその窓の行）の中から、その種別だけの行で数へる。
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

function 推定の未来(key: string, now: number): string {
  let 最早 = "";
  let 最早ms = Number.POSITIVE_INFINITY;
  for (const r of allRows()) {
    if (String(r.conf.key ?? "") !== key || r.est !== true) continue;
    const 日 = r.dateOnly
      ? Recommender.jstNoonMs(String(r.tShown ?? r.t ?? ""), Number.NaN)
      : Number(r.t);
    if (!Number.isFinite(日) || 日 < now) continue;
    if (日 >= 最早ms) continue;
    最早ms = 日;
    最早 = r.dateOnly
      ? String(r.tShown ?? "").slice(0, 10)
      : new Date(r.t + 9 * 3600000).toISOString().slice(0, 10);
  }
  return 最早;
}

function 名乘りの案内(query: string, list: Row[], now: number): string[] {
  if (Recommender.looksLikeUrlQuery(query)) return [];
  /* 打たれた形を憶えて置く（名簿の案内に、打つた通りの字で出す – 小致しにして示さない）。 */
  const 原の語々 = query
    .split(/[\s、。，,・/|（）()「」『』【】]+/)
    .map((w) => w.trim())
    .filter((w) => [...w].length >= 2);
  const 語々 = 原の語々.map((w) => w.toLowerCase());
  if (!語々.length) return [];

  const 名前の語 = 語々.filter((w) => !(/\d/u.test(w) && /^[\d\s./\-年月日時分秒週周]+$/u.test(w)));
  if (!名前の語.length) return [];
  const 行の鍵 = new Set(list.map((r) => String(r.conf.key ?? "")));

  const 收錄の鍵 = new Set(allRows().map((r) => String(r.conf.key ?? "")));

  const 品書の會議 = new Map(
    ((catalog() as { conferences?: unknown[] } | null)?.conferences ?? []).map((c) => [
      String((c as { key?: unknown }).key ?? ""),
      c as Record<string, unknown>,
    ]),
  );
  const 會議々 = snapshot().conferences ?? [];
  const 名前の殼 = (c: Record<string, unknown>): string =>
    [String(c.key ?? ""), String(c.title ?? ""), String(c.acronym ?? ""), String(c.full_name ?? "")]
      .join(" ")
      .toLowerCase();
  const 当たる = 會議々.filter((c) => 名前の語.every((w) => 名前に立つ(w, 名前の殼(c))));
  if (!当たる.length) {
    const 見える語 = 名前の語.filter((w) => 會議々.some((c) => 名前に立つ(w, 名前の殼(c))));
    if (!見える語.length) return [];
    /* 打たれた形で示す（小致しにすると、別の言ひ方をしている樣に見える）。 */
    const 原に戻す = (w: string): string => 原の語々.find((x) => x.toLowerCase() === w) ?? w;
    return [
      `収録の名簿に、その語に似た名前の会議は在ります（${見える語
        .map((w) => `「${原に戻す(w)}」`)
        .join("・")}）。`,
    ];
  }
  const 見本 = 当たる.slice(0, 3).map((c) => {
    const key = String(c.key ?? "");
    const 版々 = Array.isArray(c.editions) ? c.editions : [];

    /* 推定の未來の締切（第 930・964 回 – SOSP は「収録にあるのは過ぎた締切だけ」に添へたが、
     * TrustCom の樣に**この窓に行がある**会議では添へて居なかつた。推定しか未來が無い会議は
     * 「絞り込みを外すと出ます」だけでは、AI がその日を言へない）。 */
    const 推定の次 = 推定の未来(key, now);
    const 推定の文 = 推定の次
      ? `推定なら ${推定の次} も在ります（include_estimated で出ます – 確約ではない）`
      : "";
    /* 三段で書く: 絞り込みの内 → **収録の全体** → 会期だけ / 何も無い。 */
    const 狀態 = 行の鍵.has(key)
      ? `締切の行はありますが、現在の絞り込みで 0 件になっています（絞り込みを外すと出ます）${推定の文 ? `。${推定の文}` : ""}`
      : 收錄の鍵.has(key)
        ? (() => {
            /* 収録にあるのは**何の日か**まで言う（画面の同じ言葉 – 第 929 回）。 */
            const 品書 = 品書の會議.get(key) ?? {};
            const 最後 =
              typeof 品書.record_deadline_last === "string" ? 品書.record_deadline_last : "";
            const 次 =
              typeof 品書.record_deadline_next === "string" ? 品書.record_deadline_next : "";
            const 推定 = 推定の未来(key, now);
            if (次)
              return `この窓には締切の行がありませんが、**収録には ${次} の締切が在ります**（scope: "all" で引けます）`;
            if (最後)
              return (
                `この窓には締切の行がありませんが、**収録にあるのは過ぎた締切（${最後}）だけ**です` +
                (推定
                  ? `。推定なら ${推定} も在ります（include_estimated で出ます – 確約ではない）`
                  : "") +
                '（scope: "all" と include_past で読めます）'
              );
            if (推定)
              return `この窓には締切の行がありませんが、**推定なら ${推定} に締切が在ります**（include_estimated で出ます – 確約ではない）`;
            return 'この窓には締切の行がありませんが、**収録には在ります**（scope: "all" で過去の分行が出せます）';
          })()
        : `締切の行が 1 本もありません（${eventAvailabilityNoticeJa(版々)}）`;
    return `- ${String(c.title ?? key)}（key: ${key}・版 ${版々.length} 件）: ${狀態}`;
  });
  return [
    `収録の会議の名前には ${当たる.length} 件当たります:`,
    ...見本,
    ...(当たる.length > 見本.length ? [`- ほか ${当たる.length - 見本.length} 件`] : []),
  ];
}

function 表示の刻み(r: Row): number {
  return typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
}

function sortRows(list: Row[]): Row[] {
  return list
    .slice()
    .sort(
      (a, b) => 表示の刻み(a) - 表示の刻み(b) || a.conf.title.localeCompare(b.conf.title, "ja"),
    );
}

/* ---- 道具 ---- */

function 見えて居る注(query: string, 行數: number): string {
  if (行數 <= 0) return "";
  const 類語 = Recommender.querySynonymNotes(query)
    .map((n) => String(n).trim())
    .filter((n) => n.length > 0);
  const 常時 = String(Recommender.uiWordAlwaysNoteJa(query) ?? "").trim();
  const 全部 = [...類語, ...(常時 ? [常時] : [])].filter((n) => n.length > 0);
  if (!全部.length) return "";
  /* この道具を使う AI に配付物の名を添える（画面の UI の名は此では使へない – 第 942 回）。 */
  const 添 = 常時
    ? "この道具が出せるのは行だけです。カレンダーのファイルは deadlines.ics、購読 URL はページ（README の購読手順）に在ります"
    : "";
  return `\n${全部.join("\n")}${添 ? `\n${添}` : ""}`;
}

function eventAvailabilityNoticeJa(editions: unknown[]): string {
  const records = editions.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const ed = value as Record<string, unknown>;
    return ed.estimated === true ? [] : [ed];
  });
  const hasDates = records.some((ed) => {
    if (ed.event_date_precision === "not-announced") return false;
    const parts =
      Array.isArray(ed.event_segments) && ed.event_segments.length
        ? ed.event_segments
        : [{ start: ed.event_start, end: ed.event_end }];
    return parts.some((value) => {
      if (!value || typeof value !== "object") return false;
      const part = value as { start?: unknown; end?: unknown };
      return Boolean(Recommender.eventDateBoundsMs(part.start, part.end, ed.event_date_precision));
    });
  });
  if (hasDates) return EVENT_ONLY_NOTICE_JA;
  if (records.some((ed) => ed.event_date_precision === "not-announced"))
    return "会期は未発表です。開催日は公式案内で確認してください。購読カレンダー（deadlines.ics）は締切のみです。";
  return "会期も確認できていないため、開催日で絞る一覧には出ません。";
}

function eventAnnotationsJa(
  ed: { date_text?: unknown; event_review?: unknown },
  display: string,
): string {
  const review = ed.event_review as { note?: unknown } | null | undefined;
  const note = String(review?.note ?? "").trim();
  const raw = String(ed.date_text ?? "").trim();
  return [note ? `（${note}）` : "", raw && raw !== display ? `（原表記: ${raw}）` : ""].join("");
}

function eventMetadata(ed: {
  date_text?: unknown;
  event_date_precision?: unknown;
  event_segments?: unknown;
  event_review?: unknown;
}) {
  return {
    date_text: ed.date_text ?? null,
    event_date_precision:
      typeof ed.event_date_precision === "string" ? ed.event_date_precision : null,
    event_segments: Array.isArray(ed.event_segments) ? ed.event_segments : [],
    event_review:
      ed.event_review && typeof ed.event_review === "object" && !Array.isArray(ed.event_review)
        ? (ed.event_review as Record<string, unknown>)
        : null,
  };
}

/** Keep date-only and estimated deadlines separate from confirmed instants. */
export function structuredDeadline(r: Row, now: number): Record<string, unknown> {
  return {
    venue_key: r.conf.key,
    title: r.conf.title,
    /* 正式名。畫面の一覧は會議名の下に（正式名が略稱と違ふ時だけ）出す – 實測
     * 2026-10-16: 收録 5,069 行のうち 5,039 行が正式名を持つのに、MCP は一句も
     * 出して居なかつた。「ICDE と何の略？」に AI が答えられない狀態だつた。
     * 行の文字は 7 欄の形を崩さない侭、此方で機械が讀める形で持つ。 */
    full_name: r.conf.full_name ?? null,
    edition_id: r.ed.id,
    year: r.ed.year ?? null,
    kind: r.kind,
    kind_label: Recommender.kindLabelJa(r.kind),
    round: r.dl.round ?? 1,
    track: r.dl.track ?? null,
    label: r.dl.label ?? null,
    official_url: officialLink(r.ed.link, r.conf.link),
    place: r.ed.place ?? null,
    place_ja: placeDisplayJa(r.ed.place) || null,
    /* 國內の學會か（畫面が列の外に「国内」の札を出すのと同じ判定）。**開催地が日本**とは
     * 別物 – 日本で開かれる國際会議は國內ではない。日本人研究者が「國內の研究会」を
     * 聞いた時に AI が見分けを付けられるやうに、機械可読でも持つ。 */
    domestic: Recommender.isDomesticTag(r.tags),
    rank: r.conf.rank ?? null,
    estimated: r.est,
    estimate: r.est ? (r.ed.estimate ?? null) : null,
    precision: r.dateOnly ? "date-only" : "exact",
    utc: r.dateOnly ? null : (r.dl.utc ?? new Date(r.t).toISOString()),
    jst: r.dateOnly ? null : jst(r.t),
    local_date: r.dateOnly ? r.localDate : null,
    timezone: r.dl.tz_raw ?? null,
    uncertainty: r.dateOnly
      ? {
          earliest_utc: r.dl.earliest_utc ?? null,
          latest_utc: r.dl.latest_utc ?? null,
          state: Recommender.dateOnlyStateJa(r, now),
        }
      : null,
    /* 公式確認の**日本語**（畫面の行の詳細が同じ部品を HTML に並べる – 正本は
     * `Recommender.verificationSummaryJa`）。內部の鍵名（`source_class`・
     * `verified_fields`）をそのまま醫に渡すと、日本人研究者が讀めない
     * （實測 2026-10-16: MCP は内部表記のまま出して居た）。記録が無い行は null。 */
    verification_ja: Recommender.verificationSummaryJa(r.dl),
    verification: r.dl.verification ?? null,
    event_start: r.ed.event_start ?? null,
    event_end: r.ed.event_end ?? null,
    /* 上流が書いた會期の原文（畫面の行の詳細が「原表記: 」で出すのと同じ値）。 */
    ...eventMetadata(r.ed),
    submission: r.submission
      ? {
          issue_label: r.submission.issueLabel,
          language: r.submission.language,
          source_records: r.submission.sourceRecords,
        }
      : null,
    display: line(r, now),
  };
}

function searchDeadlines(
  args: {
    query?: unknown;
    limit?: unknown;
    offset?: unknown;
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
  receive?: (result: Record<string, unknown>) => void,
): string {
  const 真偽 = {
    include_past: 真偽の引數("include_past", args.include_past),
    include_estimated: 真偽の引數("include_estimated", args.include_estimated),
    domestic: 真偽の引數("domestic", args.domestic),
    online: 真偽の引數("online", args.online),
  };
  /* 絞り込みは**正規化した引数**で見る（下の判定は `=== true` だけ – 一箇所で直す）。
   * **在った引数だけ**書き戻す（省いた物を false にしてしまうと、「絞り込みを指定した」判定が
   *  – 語も絞り込みも無ければ「検索語が空です」と返す筈が、行を返していた）。 */
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
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("offset は 0 以上の整数で指定してください。");
  const 打たれた検索語 = 文字として讀む(args.query);

  const 檢索語の截 = 800;
  const query =
    打たれた検索語.length <= 檢索語の截 ? 打たれた検索語 : 打たれた検索語.slice(0, 檢索語の截);
  const 檢索語を切つた = 打たれた検索語.length > 檢索語の截;

  const 絞り込みだけ =
    !query &&
    (args.kind !== undefined ||
      args.kinds !== undefined ||
      args.rank !== undefined ||
      args.domestic !== undefined ||
      args.online !== undefined ||
      args.within_days !== undefined);
  if (!query && !絞り込みだけ)
    return "検索語が空です。会議名・分野・開催地・締切の語をください（語を省くなら kind / kinds / rank / domestic / online / within_days のいずれかを指定してください）。";
  const 限り = 數の引數("limit", args.limit, 1);

  const limit = Math.max(1, Math.floor(Math.min(限り.使ふ ?? 20, 100)));
  const limit端數 = 端數と上限の斷り(限り.使ふ, 100);

  const 窓の引數 = 數の引數("within_days", args.within_days, 1);

  const 窓の端数の斷り =
    窓の引數.使ふ !== null && !Number.isInteger(窓の引數.使ふ)
      ? `（${窓の引數.使ふ} 日は端数なので、${Math.floor(窓の引數.使ふ)} 日として切りました）`
      : "";
  const 窓の日數 = 窓の引數.使ふ !== null ? Math.floor(窓の引數.使ふ) : null;
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

  const 引く種別 = args.kinds ?? args.kind;
  const 空の種別 = Array.isArray(引く種別) && 引く種別.length === 0;
  const 種別一種 = args.kinds !== undefined && args.kinds !== null && args.kind !== undefined;
  const 古さ = 古さの斷り(生成, now);
  /* 語が空（種別だけの時）は**全部に当たる**目にする。 */
  const 照合 = 絞り込みだけ
    ? () => true
    : Recommender.searchMatcher(Recommender.expandRelativeMonths(query, now), now);
  const 素の = list.filter((r) => 照合(r.hay) === true);
  const 窓の外 = 素の.length ? 0 : 窓の外の件數(照合, 名);

  const 絞り込みが効く = !Recommender.searchMatcher(query, now)("・ー()");
  const 記号だけの文 =
    絞り込みが効く || 絞り込みだけ
      ? ""
      : `絞り込みとして効く語がありません（「${query}」は記号だけなので、すべての行を表示しています）。会議名・分野・開催地・日付を指定してください`;
  const hit = sortRows(畫面の既定(素の, now, args));
  const page = hit.slice(offset, offset + limit);
  const nextOffset = offset + page.length < hit.length ? offset + page.length : null;
  receive?.({
    query,
    total: hit.length,
    offset,
    limit,
    returned: page.length,
    next_offset: nextOffset,
    scope: 窓が無い || scopeValue(args.scope) === "all" ? "all" : "screen",
    catalog_fallback: 窓が無い,
    generated_at: 生成 ?? null,
    evaluated_at: new Date(now).toISOString(),
    rows: page.map((r) => structuredDeadline(r, now)),
  });
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

  const 名乘り全部 = 名乘りとして讀む(引く種別).map((k) => 種別の英語(k));
  const 知らん = 名乘り全部.filter((k) => !知って居る種別.includes(k));

  const ランク = Recommender.rankGradeJa(args.rank);
  const 知らんランク = ランク && !Recommender.rankGradeOrderJa().includes(ランク) ? ランク : "";
  /* 日付は日本時間で出す。**元の表記が別の日の事がある**ので、月で引いた時に表示の月がずれる
   * 行がある（実測 2026-10-06: `9月` で引いた行が「2026-10-16(金) 20:59 JST」と出る – 元の
   * 表記は AoE で 9 月 30 日）。AI がそのまま「10 月」と答へん樣に、頭で斷つて置く。*/
  /* 日付の斷りは**日付を聞いた時だけ**書く。*/
  const 日付の語 =
    /(?:\d+月|\d+日|今月|来月|先月|今週|来週|先週|今年|来年|年内|年度|以内|までに|以降)/.test(
      query,
    );

  const 相対の解決 = Recommender.relativeDayNotes(Recommender.expandRelativeMonths(query, now), now)
    .map((n) => String(n).trim())
    .filter((n) => n.length > 0);
  const 解決の文 = 相対の解決.length ? `\n${相対の解決.map((n) => `判定: ${n}`).join(" / ")}` : "";

  /* 行が見えている時に出す注（類語・曖昧さ – 第 942・948 回）。 */
  const 見えて居る文 = 見えて居る注(query, hit.length);
  const 頭 = `${絞り込みだけ ? "語を指定せず、絞り込みだけ" : `検索語「${query}」に当たる締切`}: ${hit.length} 件（${名} ${list.length} 行・画面の既定と同じ絞り込み。絞る前は ${素の.length} 行${ランク ? `／ランク ${ランク}` : ""}${args.domestic === true ? "／国内のみ" : ""}${args.online === true ? "／オンライン参加可のみ" : ""}${窓あり ? `／締切まで ${窓の日數} 日以内${窓の端数の斷り}` : ""}${讀めない引數}）${limit端數}${檢索語を切つた ? `（${打たれた検索語.length} 字のうち、最初の ${檢索語の截} 字で調べました – 残りの語は参考にしていません）` : ""}${知らん.length ? `／知らない種別: ${知らない値の文("", 知らん)}` : ""}${空の種別 ? `／kinds が空なので既定の投稿締切（概要・論文・常時受付）を対象にしています` : ""}${種別一種 ? `／kind は kinds と共に与えられたので見ていません` : ""}${知らんランク ? `／知らないランク（等級は ${Recommender.rankGradeOrderJa().join("・")}）: ${知らんランク}${limit端數}` : ""}${日付の語 ? "\n日付は日本時間（JST）。月や日付の語は、締切の日付と「会期」の日付の両方に当たる（画面のてびきと同じ約束）ので、月で引いた時に見出しの月と違う日が出る行がある。" : ""}${窓が無い ? `\n${窓が無いの斷り(true)}` : ""}${scopeErr ? `\n${scopeErr}` : ""}${解決の文}${記号だけの文 ? `\n${記号だけの文}` : ""}${見えて居る文}`;
  if (!hit.length) {
    /* 画面と同じ約束 – 案内は「素の当たりが 0」の時に出る物なので、絞り込みで 0 に成つた時は
     * その旨を書く（絞り込みを外せば出る事がある）。 */
    const 案内 = 素の.length ? [] : guidance(query, 0, list, now);
    /* 収録の果てより先の日付を打たれた時は「無い」と言はない。
     * 窓の外に行がある時はその案内が同じ事を言うので、重ねない。 */
    const 果て = 素の.length || 窓の外 ? "" : 果ての案内(query, list, 名);
    return [
      頭,
      "",
      素の.length
        ? `語は当たりますが、既定の絞り込み（今後の投稿締切・推定を除く）で 0 件になりました。include_past / include_estimated / kinds${ランク ? ` / rank（いま ${ランク}）` : ""} を試してください。`
        : 窓の外
          ? `この語は画面が最初に読む窓（${list.length} 行）には 1 行もありませんが、**収録の全体には ${窓の外} 行あります**（scope: "all" で引けます）。`
          : (果て ?? "この語では 1 行も出ません。"),
      /* 表に出さん種別の語が打たれていたら、その種別がある事を言う。
       * 打ち直す手が `kinds` なので、何を選べばいいかがそのまま分かる。 */
      ...(() => {
        /* 見える結果が 0 の時に出す（画面の `kindNote` は raw の当たりを条件にしない –
         * `hiddenKindQueryWords` は語だけで決まる）。このブロツクは既に `!hit.length` の中。 */
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
        /* **その指定で何件出るか**を実際に数へる。
         * 素で当たつた行を、その種別だけにした画面の既定へ通す。 */
        const 件數 = 畫面の既定(素の, now, { ...args, kinds: 鍵々 }).length;
        return [
          `検索語は${選べる}の種別に当たります（表には投稿締切だけを出します）。kinds: ${JSON.stringify(鍵々)} で引けます（${件數} 件当たります）。`,
        ];
      })(),
      ...語ごとの案號(query, list, now, 窓の外 > 0 ? allRows() : undefined),
      ...(素の.length ? [] : URLの案内(query)),
      ...案内.map((n) => `案内: ${n}`),
      /* 日数の幅（「1か月以内」）は画面の「締切まで」と同じ引数（`within_days`・第 872 回）を
       * 件数つきで言う。 */
      ...(素の.length ? [] : 日數幅の案内(query, list, now, args)),
      /* どの案内にも当たらなかつた問（画面の「別の語で試す」に落ちる打ち手）には、
       * この表が何を出す画面なのかと、分野の欄の名前を言う。 */
      ...(() => {
        if (案内.length || 日數幅の案内(query, list, now, args).length) return [];
        if (窓の外 || 果て) return [];
        if (名乘りの案内(query, list, now).length) return [];
        if (URLの案内(query).length) return [];
        if (隱れた種別の語(query).length) return [];
        if (語ごとの案號(query, list, now, 窓の外 > 0 ? allRows() : undefined).length) return [];

        if (hit.length && !素の.length) {
          const 常時 = String(Recommender.uiWordAlwaysNoteJa(query) ?? "").trim();
          if (常時) return [常時];
        }
        const 手 = retypeTips(query, 畫面の既定(list, now, args), now);
        if (手.length) return []; // 「打ち直すなら」が立つ時はそちらに讓る（重ねて二度言はない）。
        return 受皿の案內();
      })(),
      /* 名簿の案内は**見える結果が 0 の時**に出す（画面と同じ – 画面は raw の当たりが在つても、
       * 既定の絞り込みで 0 件に成つた時に名簿を名指す。実測 2026-10-11: `情報処理学会 HPC 研究会` は
       * 窓に 4 行当たるが、既定の絞り込みで 0 件 – MCP は「include_past を試して」だけを返していた）。 */
      ...名乘りの案内(query, list, now),
      ...(() => {
        if (素の.length) return [];
        const 手 = retypeTips(query, 畫面の既定(list, now, args), now);
        return 手.length ? [`打ち直すなら ${手.join(" / ")}`] : [];
      })(),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  const 見本 = page.map((r) => line(r, now));
  if (offset >= hit.length)
    return `${頭}\nこの位置には結果がありません（offset: ${offset}／全 ${hit.length} 件）。`;
  return [
    頭,
    /* 打ち切って無い時は **limit を言わない**。 */
    `（日本時間の早い順${offset > 0 ? `。${offset + 1}〜${offset + page.length} 件目・残り ${Math.max(0, hit.length - offset - page.length)} 件` : hit.length > limit ? `。${limit} 件まで表示・残り ${hit.length - limit} 件` : ""}）`,
    "",
    ...見本,
    ...(nextOffset !== null
      ? [`次の結果: 同じ条件で offset: ${nextOffset} を指定してください。`]
      : []),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

interface UpcomingEventRow extends ReturnType<typeof eventMetadata> {
  開始: number;
  終了: number;
  会議: string;
  key: string;
  版: string;
  開催地: string;
  link: string;

  year: number | null;
  segment_label: string | null;
  place: string | null;
}

export function 開催の行(days: number, now: number): UpcomingEventRow[] {
  const 限り = Recommender.withinDaysLimitMs(days, now);
  const today = Date.parse(new Date(now + 9 * 3600000).toISOString().slice(0, 10));
  const 出: UpcomingEventRow[] = [];
  for (const c of snapshot().conferences ?? []) {
    const 会議 = c as {
      key?: unknown;
      title?: unknown;
      acronym?: unknown;
      link?: unknown;
      editions?: unknown[];
    };
    const 略稱 = String(会議.acronym ?? "");
    for (const e of 会議.editions ?? []) {
      const ed = e as {
        id?: unknown;
        year?: unknown;
        estimated?: unknown;
        event_start?: unknown;
        event_end?: unknown;
        event_segments?: unknown;
        event_date_precision?: unknown;
        date_text?: unknown;
        event_review?: unknown;
        place?: unknown;
        link?: unknown;
      };
      /* 推定の版は入れない（画面の表と同じ規則 – 第 299 回）。 */
      if (ed.estimated === true || ed.event_date_precision === "not-announced") continue;

      const 区分: Array<{ start?: unknown; end?: unknown; label?: unknown }> =
        Array.isArray(ed.event_segments) && ed.event_segments.length
          ? (ed.event_segments as Array<{ start?: unknown; end?: unknown; label?: unknown }>)
          : ed.event_start
            ? [{ start: ed.event_start, end: ed.event_end ?? ed.event_start }]
            : [];
      for (const seg of 区分) {
        const 開始 = Date.parse(String(seg.start ?? ""));
        if (!Number.isFinite(開始)) continue;
        const 終了 = Date.parse(String(seg.end ?? seg.start ?? "")) || 開始;
        const bounds = Recommender.eventDateBoundsMs(seg.start, seg.end, ed.event_date_precision);
        if (!bounds || bounds[1] < today || bounds[0] >= 限り) continue;
        /* 會議名は**年を添えた形**（`titleWithYearJa` – 畫面の行の詳細と upcoming.md の
         * 正本）。略稱を先に出すと「SEC」のやうに一會社の別の名が出て、upcoming.md の
         * 「USENIX Security 2026」と別物になる。版の識別子は後に續ける（省かない）。
         * 開催地も**日本語化した表記**（`placeJa`）。實測 2026-10-16: 生のまま出すと
         * 2,378 版が「Karlsruhe, Germany」の儘で、締切の行（「Karlsruhe, ドイツ」）と
         * **MCP の中で違ふ表記**に成って居た。空でも「未確認」を出す（空欄にすると
         * 公式が出て居ないのと收録漏れが區別できない – upcoming.md と同じ決まり）。 */
        const 會議名 = Recommender.titleWithYearJa(
          String(会議.title ?? 会議.key ?? ""),
          typeof ed.year === "number" ? ed.year : null,
        );
        出.push({
          開始,
          終了,
          会議: 會議名 || 略稱 || String(会議.key ?? ""),
          key: String(会議.key ?? ""),
          版: String(ed.id ?? ""),
          year: typeof ed.year === "number" ? ed.year : null,
          ...eventMetadata(ed),
          segment_label: typeof seg.label === "string" ? seg.label : null,
          place: typeof ed.place === "string" && ed.place.trim() ? ed.place : null,
          開催地: placeDisplayJa(ed.place) || String(Recommender.unconfirmedLabelJa() ?? "未確認"),
          link: officialLink(ed.link, 会議.link) ?? "",
        });
      }
    }
  }
  return 出.sort((a, b) => a.開始 - b.開始 || a.会議.localeCompare(b.会議, "ja"));
}

function listUpcoming(
  args: {
    days?: unknown;
    kind?: unknown;
    kinds?: unknown;
    scope?: unknown;
    limit?: unknown;
    offset?: unknown;
  },
  now: number,
  receive?: (result: Record<string, unknown>) => void,
): string {
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("offset は 0 以上の整数で指定してください。");
  const limitInput = 數の引數("limit", args.limit, 1);
  const limit = Math.max(1, Math.floor(Math.min(limitInput.使ふ ?? 100, 100)));
  const 日數の引數 = 數の引數("days", args.days, 1);
  const 使ふ日數 = 日數の引數.使ふ;

  const 端数の斷り =
    使ふ日數 !== null && !Number.isInteger(使ふ日數)
      ? `（${使ふ日數} 日は端数なので、${Math.floor(使ふ日數)} 日として切りました）`
      : "";

  const 上限の斷り =
    使ふ日數 !== null && Number.isFinite(使ふ日數) && Math.floor(使ふ日數) > 400
      ? `（上限 400 を超えたので 400 日として切りました）`
      : "";
  const days = Math.floor(Math.min(使ふ日數 ?? 30, 400));
  const 讀めない引數 = 日數の引數.斷り;
  /* 使へない値を貰つた時は「既定の N 日」と書く（黙つて 30 日を假定しない）。省かれた時は
   * そのまま「N 日以内」（省略した人に「既定」と囘りくどく言はない）。 */
  const 日數の表現 =
    使ふ日數 === null && !日數の引數.省かれた ? `${days} 日（既定）` : `${days} 日以内`;
  const 引き = args.kind ?? (args as { kinds?: unknown }).kinds;
  const 名乘り = 名乘りとして讀む(引き)
    /* **日本語の名も受ける**。 */
    .map((k) => 種別の英語(k));
  const 全部 = 名乘り.some((k) => k.toLowerCase() === "all");

  const 選ぶ = new Set(名乘り.map((k) => k.toLowerCase()));
  /* 未知の種別は名指す。既知の種別と併用された場合は、既知の種別の結果が残る。 */
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

  const 空の種別 = Array.isArray(引き) && 引き.length === 0;
  const { list, 名, 生成, 窓が無い } = pick(args.scope ?? "all");
  const 古さ = 古さの斷り(生成, now);

  const 限り = Recommender.withinDaysLimitMs(days, now);
  /* 表示している暦日で比べる（`tShown`。無ければ `t`）。 */
  const 暦日 = (r: Row): number =>
    typeof r.tShown === "number" && Number.isFinite(r.tShown) ? r.tShown : r.t;
  const hit = sortRows(
    list.filter(
      (r) =>
        !Recommender.deadlineRowIsPast(r, now) &&
        暦日(r) < 限り &&
        (全部 || 選ぶ.size === 0 || 選ぶ.has(r.kind) || 選ぶ.has(r.dl.kind)),
    ),
  );
  const events = 開催の行(days, now);
  const date = (value: number): string => new Date(value).toISOString().slice(0, 10);
  const timeline: Array<{
    at: number;
    item: Record<string, unknown>;
    row?: Row;
    event?: UpcomingEventRow;
  }> = [
    ...hit.map((row) => ({
      at: 表示の刻み(row),
      row,
      item: { type: "deadline", ...structuredDeadline(row, now) },
    })),
    ...events.map((event) => ({
      at: event.開始,
      event,
      item: {
        type: "event",
        venue_key: event.key,
        title: event.会議,
        edition_id: event.版,
        year: event.year,
        event_start: date(event.開始),
        event_end: date(event.終了),
        ...eventMetadata(event),
        segment_label: event.segment_label,
        place: event.place,
        place_ja: event.開催地,
        official_url: event.link || null,
      },
    })),
  ];
  timeline.sort((a, b) => a.at - b.at);
  const page = timeline.slice(offset, offset + limit);
  const nextOffset = offset + page.length < timeline.length ? offset + page.length : null;
  const deadlinePage = page.flatMap((item) => (item.row ? [item.row] : []));
  const eventPage = page.flatMap((item) => (item.event ? [item.event] : []));
  const remaining = timeline.slice(offset + page.length);
  const deadlineRemaining = remaining.filter((item) => item.row).length;
  receive?.({
    total: timeline.length,
    deadline_total: hit.length,
    event_total: events.length,
    days,
    offset,
    limit,
    returned: page.length,
    next_offset: nextOffset,
    scope: 窓が無い || scopeValue(args.scope ?? "all") === "all" ? "all" : "screen",
    event_scope: "all",
    catalog_fallback: 窓が無い,
    generated_at: 生成 ?? null,
    event_generated_at: snapshot().snapshot_metadata?.generated_at ?? null,
    evaluated_at: new Date(now).toISOString(),
    items: page.map((item) => item.item),
  });
  const 知らんの斷り = 知らん.length ? `／知らない種別: ${知らない値の文("", 知らん)}` : "";
  const pageNotice = !timeline.length
    ? "指定した条件に当たる収録済みの締切・会期はありません。"
    : !page.length
      ? `この位置には結果がありません（offset: ${offset}／全 ${timeline.length} 件）。` +
        "同じ条件で offset: 0 を指定すると、先頭から取得できます。"
      : `全 ${timeline.length} 件中 ${offset + 1}〜${offset + page.length} 件目` +
        `（このページ: 締切 ${deadlinePage.length} 件・会期 ${eventPage.length} 件）。`;
  return [
    `今日から ${日數の表現}（JST の暦日で数える）の締切: ${hit.length} 件（${名}・日本時間の早い順）${讀めない引數}${知らんの斷り}${端数の斷り}${上限の斷り}${limitInput.斷り}${端數と上限の斷り(limitInput.使ふ, 100)}${空の種別 ? `／kinds が空なので種別では絞り込んでいません` : ""}`,
    ...(scopeErr ? [scopeErr] : []),
    ...(窓が無いの斷り(窓が無い) ? [窓が無いの斷り(窓が無い)] : []),
    pageNotice,
    "",
    ...deadlinePage.map((row) => line(row, now)),
    ...(deadlineRemaining
      ? ["", `（締切はこのページ ${deadlinePage.length} 件まで表示・残り ${deadlineRemaining} 件）`]
      : []),
    ...開催の節(events, eventPage, remaining.filter((item) => item.event).length),
    ...(nextOffset !== null
      ? ["", `次の結果: 同じ条件で offset: ${nextOffset} を指定してください。`]
      : []),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

function 開催の節(行: UpcomingEventRow[], page: UpcomingEventRow[], remaining: number): string[] {
  if (!行.length) return [];
  const 日 = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  return [
    "",
    `開催（会期の行）: ${行.length} 件（会期は収録全体から指定期間に重なる開催を表示します。upcoming.md の対象期間とは異なる場合があります。購読カレンダー deadlines.ics は締切のみです）`,
    ...page.flatMap((r) => {
      const span =
        Recommender.eventCellJa({
          ed: {
            event_start: 日(r.開始),
            event_end: 日(r.終了),
            event_date_precision: r.event_date_precision,
          },
        }) + (r.segment_label ? `（${r.segment_label}）` : "");
      const annotations = eventAnnotationsJa(r, span);
      return [
        `- ${span} | ${r.会議}（key: ${r.key}${r.版 ? `・${r.版}` : ""}）${r.開催地 ? ` | ${r.開催地}` : ""}${r.link ? ` ${r.link}` : ""}`,
        ...(annotations ? [`  会期の注記: ${annotations}`] : []),
      ];
    }),
    ...(remaining ? [`- ほか ${remaining} 件`] : []),
  ];
}

function venueLookupText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim();
}

function venueClassification(conf: NonNullable<SnapshotFile["conferences"]>[number]) {
  return {
    categories: conf.categories ?? [],
    rank: conf.rank ?? null,
    tags: conf.tags ?? [],
    domestic: Recommender.isDomesticTag(conf.tags),
  };
}

function venueClassificationLines(
  conf: NonNullable<SnapshotFile["conferences"]>[number],
): string[] {
  const metadata = venueClassification(conf);
  const rankPairs = Object.entries(metadata.rank ?? {})
    .filter(([, grade]) => Boolean(grade))
    .map(([source, grade]) => `${source}:${grade}`);
  const topics = Recommender.topicTagsJa(metadata.tags);
  return [
    `分野: ${metadata.categories.map((key) => Recommender.categoryLabelJa(key)).join("・") || Recommender.unconfirmedLabelJa()}`,
    `ランク: ${ランクJa({ rankPairs })}`,
    ...(topics.length ? [`主題: ${topics.join("・")}`] : []),
    ...(metadata.domestic ? ["区分: 国内"] : []),
  ];
}

function venueIdentity(conf: NonNullable<SnapshotFile["conferences"]>[number]) {
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value : null;
  return {
    venue_key: String(conf.key ?? ""),
    title: text(conf.title),
    full_name: text(conf.full_name),
    acronym: text(conf.acronym),
    official_url: officialLink(conf.link),
  };
}

function venueEditionCounts(conf: Parameters<typeof venueIdentity>[0], nonEstimatedCount: number) {
  const estimatedCount = (conf.editions ?? []).filter(
    (value) =>
      value && typeof value === "object" && (value as { estimated?: unknown }).estimated === true,
  ).length;
  return {
    edition_total: nonEstimatedCount + estimatedCount,
    non_estimated_edition_total: nonEstimatedCount,
    estimated_edition_total: estimatedCount,
  };
}

function venueSchedules(conf: { key?: unknown; editions?: unknown[] }) {
  return (conf.editions ?? []).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const ed = value as Record<string, unknown>;
    if (ed.estimated === true) return [];
    const text = (value: unknown): string | null =>
      typeof value === "string" && value.trim() ? value : null;
    return [
      {
        edition_id: text(ed.id),
        year: typeof ed.year === "number" ? ed.year : null,
        event_start: text(ed.event_start),
        event_end: text(ed.event_end),
        ...eventMetadata(ed),
        event_display:
          Recommender.eventCellJa({ ed }) ||
          (ed.event_date_precision === "not-announced" ? "会期未発表" : "会期未確認"),
        place: text(ed.place),
        place_ja: placeDisplayJa(ed.place) || "未確認",
        official_url: officialLink(ed.link),
      },
    ];
  });
}

function venueScheduleLines(editions: ReturnType<typeof venueSchedules>): string[] {
  if (!editions.length) return [];
  return [
    "開催回の会期（推定を除く・過去の開催回も含む）:",
    ...editions.map((ed) => {
      const annotations = eventAnnotationsJa(ed, ed.event_display);
      return `- ${ed.year ?? "年未確認"}（${ed.edition_id ?? "識別子未確認"}） | ${ed.event_display}${annotations} | ${ed.place_ja}${ed.official_url ? ` ${ed.official_url}` : ""}`;
    }),
  ];
}

function latestDeadlineLinks(rows: Row[]) {
  const links = new Map<string, { url: string; at: number }>();
  for (const row of rows) {
    const url = String(row.ed.link ?? "").trim();
    if (!url) continue;
    const key = venueLookupText(row.conf.key);
    const previous = links.get(key);
    if (!previous || row.t >= previous.at) links.set(key, { url, at: row.t });
  }
  return links;
}

function venueInfo(
  args: { key?: unknown; name?: unknown; scope?: unknown },
  now: number,
  receive?: (result: Record<string, unknown>) => void,
): string {
  const key = 文字として讀む(args.key);
  const name = 文字として讀む(args.name);
  if (!key && !name) return "key（会議の識別子）か name（会議名の一部）をください。";
  /* `名` は使はない（この道具は会議の名を自分で組み立てる）ので受け取らない。 */
  const { list, 生成, 名, 窓が無い } = pick(args.scope ?? "all");
  const context = {
    scope: 名 === "収録の全体" ? "all" : "screen",
    catalog_fallback: 窓が無い,
    generated_at: 生成 ?? null,
    event_scope: "all",
    event_generated_at: snapshot().snapshot_metadata?.generated_at ?? null,
    evaluated_at: new Date(now).toISOString(),
  };
  const 古さ = 古さの斷り(生成, now);

  const 求 = venueLookupText(name);
  const requestedKey = venueLookupText(key);
  const venues = snapshot().conferences ?? [];
  const notifyAmbiguity = (
    candidates: Array<Parameters<typeof venueIdentity>[0]>,
    matchedBy: "name" | "legacy_key" | "source_record" | "edition_key",
  ) => {
    receive?.({
      lookup_status: "ambiguous",
      matched_by: matchedBy,
      query: key || name,
      scope: "all",
      generated_at: snapshot().snapshot_metadata?.generated_at ?? null,
      evaluated_at: new Date(now).toISOString(),
      candidate_count: candidates.length,
      candidates: candidates.map(venueIdentity),
    });
  };
  const namedVenues = key
    ? []
    : venues.filter((conf) =>
        [conf.key, conf.title, conf.acronym, conf.full_name].some((value) =>
          venueLookupText(value).includes(求),
        ),
      );
  if (namedVenues.length > 1) {
    notifyAmbiguity(namedVenues, "name");
    const latestLinks = latestDeadlineLinks(allRows());
    return [
      `「${name}」には ${namedVenues.length} の会議が当たりました。key を指定してください:`,
      ...(scopeErr ? [scopeErr] : []),
      ...namedVenues.map((conf) => {
        const latestEdition = (conf.editions ?? [])
          .filter((value): value is Record<string, unknown> =>
            Boolean(
              value &&
                typeof value === "object" &&
                (value as Record<string, unknown>).estimated !== true &&
                (value as Record<string, unknown>).link,
            ),
          )
          .sort((a, b) => Number(b.year || 0) - Number(a.year || 0))[0];
        const url =
          latestLinks.get(venueLookupText(conf.key))?.url ||
          String(latestEdition?.link || conf.link || "").trim();
        return `- ${String(conf.title || conf.key)}（key: ${String(conf.key)}）${url ? ` ${url}` : ""}`;
      }),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  const current = key ? venues.find((c) => venueLookupText(c.key) === requestedKey) : undefined;
  const aliases =
    key && !current
      ? venues.filter((c) => {
          const legacy = (c as { legacy_keys?: unknown }).legacy_keys;
          return (
            Array.isArray(legacy) && legacy.some((old) => venueLookupText(old) === requestedKey)
          );
        })
      : [];
  const resolvedVenue =
    current ??
    (aliases.length === 1 ? aliases[0] : undefined) ??
    (namedVenues.length === 1 ? namedVenues[0] : undefined);
  const lookupKey = current
    ? venueLookupText(current.key)
    : aliases.length === 1
      ? venueLookupText(aliases[0].key)
      : requestedKey;
  const 的 = (r: Row): boolean =>
    key
      ? venueLookupText(r.conf.key) === lookupKey
      : venueLookupText(r.conf.title).includes(求) ||
        venueLookupText(r.conf.acronym).includes(求) ||
        venueLookupText(r.conf.full_name).includes(求) ||
        venueLookupText(r.conf.key).includes(求);
  const matchesRow = (row: Row): boolean => {
    if (的(row)) return true;
    return (
      row.submission?.sourceRecords.some((record) => {
        if (key) return venueLookupText(record.venueKey) === lookupKey;
        const source = venues.find((conf) => conf.key === record.venueKey);
        return [source?.title, source?.acronym, source?.full_name, record.venueKey].some(
          (value) => typeof value === "string" && venueLookupText(value).includes(求),
        );
      }) ?? false
    );
  };
  const hit = aliases.length > 1 ? [] : list.filter(matchesRow);
  if (!hit.length) {
    const outside =
      名 !== "収録の全体" && aliases.length < 2 ? displayRows(allRows()).filter(matchesRow) : [];
    if (outside.length) {
      const candidates = resolvedVenue
        ? [resolvedVenue]
        : [...new Map(outside.map((row) => [row.conf.key, row.conf])).values()];
      receive?.({
        lookup_status: "out_of_scope",
        query: key || name,
        ...context,
        available_scope: "all",
        available_generated_at: snapshot().snapshot_metadata?.generated_at ?? null,
        available_deadline_total: outside.length,
        candidate_count: candidates.length,
        candidates: candidates.map(venueIdentity),
        ...(candidates.length === 1
          ? { retry_arguments: { key: String(candidates[0].key), scope: "all" } }
          : {}),
      });
      return [
        `「${key || name}」の締切はこの表示範囲にはありません。収録全体には ${outside.length} 件あります。scope: "all" で取得してください。`,
        ...candidates.map((conf) => `- ${conf.title}（key: ${conf.key}）`),
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }
    const 收錄の會議 = snapshot().conferences ?? [];
    /* key を指定されている時は**その key で**名簿を引く。名が空の儘名前で探すと、
     * `title.includes("")` がどれにも当たつて**先頭の会議**を返してしまふ – 実測 2026-10-12:
     * `venue_info({key: "sc"})`（窓に行が無い）が、全く別の会議（jornadas-dl2）の情報を
     * 「その会議は収録に在りますが…」と返していた。問はた会議の事を言うのがこの道具の役目。 */

    const 問はた全部 = key ? (current ? [current] : aliases) : [];
    const 問はた候補 = key && 問はた全部.length > 1 ? 問はた全部 : [];
    if (問はた候補.length > 1) {
      notifyAmbiguity(問はた候補, "legacy_key");
      return [
        `「${String(key).trim()}」は ${問はた候補.length} つの会議の古い key です（改名・統合前の識別子）。` +
          `一覧から選び、key を指定して検索し直してください:`,
        ...問はた候補.map(
          (c) =>
            `- ${String(c.acronym || c.title || c.key)}（key: ${String(c.key)}）` +
            `${String(c.link ?? "") ? ` ${String(c.link)}` : ""}`,
        ),
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }
    const 在る候補 = key ? 問はた全部 : namedVenues;
    const 在る = 在る候補[0];
    if (在る) {
      const 版々 = Array.isArray(在る.editions) ? 在る.editions : [];
      const link = String(在る.link ?? "").trim();
      const editions = venueSchedules(在る);
      const identity = venueIdentity(在る);
      const editionCounts = venueEditionCounts(在る, editions.length);
      receive?.({
        ...identity,
        ...venueClassification(在る),
        ...editionCounts,
        deadline_total: 0,
        upcoming_deadline_total: 0,
        past_deadline_total: 0,
        next_submission: null,
        next_estimated_submission: null,
        latest_past_submission: null,
        rows: [],
        editions,
        ...context,
      });
      return [
        `会議（${String(在る.acronym || 在る.title || 在る.key)}・key: ${String(在る.key)}）は収録されていますが、締切の行が 1 本もありません（版 ${editionCounts.edition_total} 件${editionCounts.estimated_edition_total ? `、うち推定 ${editionCounts.estimated_edition_total} 件` : ""}）。` +
          eventAvailabilityNoticeJa(版々),
        ...(identity.full_name &&
        identity.full_name !== identity.title &&
        identity.full_name !== identity.acronym
          ? [`正式名: ${identity.full_name}`]
          : []),
        ...venueClassificationLines(在る),
        ...venueScheduleLines(editions),
        ...(link ? [`公式ページ: ${link}`] : []),
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }

    const editionVenues = key
      ? 收錄の會議.filter((c) =>
          (Array.isArray(c.editions) ? c.editions : []).some(
            (e) => venueLookupText((e as { id?: unknown } | null)?.id) === requestedKey,
          ),
        )
      : [];
    if (editionVenues.length > 1) {
      notifyAmbiguity(editionVenues, "edition_key");
      return [
        `「${key}」は ${editionVenues.length} 会議の開催回に使われている識別子です。会議を選び、key を指定して照会してください:`,
        ...editionVenues.map(
          (conf) => `- ${String(conf.title || conf.key)}（key: ${String(conf.key)}）`,
        ),
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }
    const 版の會議 = editionVenues[0];
    if (版の會議) {
      const 本の會議 = String(版の會議.key ?? "");
      receive?.({
        lookup_status: "edition_key",
        query: key,
        scope: "all",
        generated_at: snapshot().snapshot_metadata?.generated_at ?? null,
        evaluated_at: new Date(now).toISOString(),
        ...venueIdentity(版の會議),
        retry_arguments: { key: 本の會議, scope: "all" },
      });
      return [
        `「${key}」は**版（edition）の識別子**で、会議その物の key ではありません。` +
          `会議の key は \`${本の會議}\` です（key で引き直すと、この会議の全ての版と締切が出ます）。`,
        ...(古さ ? ["", 古さ] : []),
      ].join("\n");
    }

    const 大文字の問 = String(key ?? "").trim();
    const 略稱で当たる =
      大文字の問.length > 0
        ? 收錄の會議.filter((c) => {
            const 題 = String(c.acronym || c.title || "").trim();
            return 題.length > 0 && venueLookupText(題) === venueLookupText(大文字の問);
          })
        : [];

    const 打たれた語 = 大文字の問 || String(name ?? "").trim();
    receive?.({
      lookup_status: "not_found",
      query: 打たれた語,
      scope: "all",
      generated_at: snapshot().snapshot_metadata?.generated_at ?? null,
      evaluated_at: new Date(now).toISOString(),
      venue_total: 收錄の會議.length,
      candidate_count: 略稱で当たる.length,
      candidates: 略稱で当たる.map(venueIdentity),
      ...(略稱で当たる.length === 1
        ? { retry_arguments: { key: String(略稱で当たる[0].key), scope: "all" } }
        : {}),
    });
    return [
      `その会議（${key ? "key" : "name"}: \`${打たれた語}\`）は収録に在りません（収録 ${收錄の會議.length} 会議）。`,
      ...(略稱で当たる.length > 0
        ? [
            `\`key\` は小文字の識別子です。**略称で引く時は \`name\` に「${大文字の問}」を渡してください**` +
              `（${略稱で当たる.map((c) => `\`${String(c.key)}\``).join("・")} が当たります）。`,
          ]
        : [`会議名の一部を \`name\` に渡すか、search_deadlines で引いてください。`]),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }

  const 會々 = [...new Set(hit.map((r) => r.conf.key))];
  if (會々.length > 1 && !resolvedVenue) {
    const candidateRows = allRows().filter(matchesRow);
    const candidates = [
      ...new Map(
        candidateRows.map((row) => [
          row.conf.key,
          venues.find((conf) => conf.key === row.conf.key) ?? row.conf,
        ]),
      ).values(),
    ];
    notifyAmbiguity(candidates, key ? "source_record" : "name");
    const 名乗り = candidates.map((conf) => [String(conf.key), String(conf.title)]);
    const 繋ぎ先 = latestDeadlineLinks(candidateRows);
    return [
      `「${key || name}」には ${candidates.length} の会議が当たりました。名を細く打つか、key で指してください:`,
      ...(scopeErr ? [scopeErr] : []),
      ...名乗り.map(([k, t]) => {
        const 先 = 繋ぎ先.get(venueLookupText(k));
        return `- ${t}（key: ${k}）${先 ? ` ${先.url}` : ""}`;
      }),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  const 一つ =
    hit.find(
      (row) =>
        resolvedVenue && venueLookupText(row.conf.key) === venueLookupText(resolvedVenue.key),
    ) ?? hit[0];

  const 會議の版 =
    resolvedVenue ??
    (snapshot().conferences ?? []).find(
      (c: { key?: unknown }) => venueLookupText(c.key) === venueLookupText(一つ.conf.key),
    );
  const schedules = venueSchedules(會議の版 ?? { editions: [] });
  const editionCounts = venueEditionCounts(會議の版 ?? 一つ.conf, schedules.length);
  const estimatedEditionIds = new Set(
    (會議の版?.editions ?? []).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const ed = value as { id?: unknown; estimated?: unknown };
      return ed.estimated === true && typeof ed.id === "string" ? [ed.id] : [];
    }),
  );
  const 行を持つ版 = new Set(hit.map((r) => r.ed.id));
  const venueKey = venueLookupText(會議の版?.key ?? 一つ.conf.key);
  const deadlineEditionIds = (rows: Row[]): Set<string> =>
    new Set(
      rows.flatMap((row) => [
        ...(venueLookupText(row.conf.key) === venueKey ? [row.ed.id] : []),
        ...(row.submission?.sourceRecords ?? [])
          .filter((record) => venueLookupText(record.venueKey) === venueKey)
          .map((record) => record.editionId),
      ]),
    );
  const displayedDeadlineEditions = deadlineEditionIds(hit);
  const allDeadlineEditions = deadlineEditionIds(allRows().filter(matchesRow));
  const 版 = [
    ...new Set([
      ...((會議の版?.editions ?? []) as Array<{ id?: unknown }>).map((e) => String(e.id ?? "")),
      ...displayedDeadlineEditions,
    ]),
  ]
    .filter((id) => id.length > 0)
    .sort();

  const ordered = sortRows(hit).sort(
    (a, b) =>
      Number(Recommender.deadlineRowIsPast(a, now)) -
        Number(Recommender.deadlineRowIsPast(b, now)) ||
      表示の刻み(a) - 表示の刻み(b) ||
      a.conf.title.localeCompare(b.conf.title, "ja"),
  );
  const 見本 = ordered.map((r) => line(r, now));
  /* 今後の締切が無い会議では、**その事を先に言う**が「次はこれ」と取り違へる）。 */
  const 今後 = hit.filter((r) => !Recommender.deadlineRowIsPast(r, now)).length;
  const 斷り = 今後 ? "" : "※ この会議の今後の締切は収録にありません（以下は過去の締切です）。\n";

  const 投稿の行 = ordered.filter((r) => 投稿の種別.includes(r.kind));
  const 次の投稿 = 投稿の行.find((r) => !r.est && !Recommender.deadlineRowIsPast(r, now));
  const 推定の次の投稿 = 投稿の行.find((r) => r.est && !Recommender.deadlineRowIsPast(r, now));
  /* 過ぎた分の「直近」は**一番遲い過去**（投稿の締切が今年の分まで出たならそれを言う –
   * 一番古い過去を出すと「5 年前に終はつた会議」と読めてしまふ）。 */
  const 直近の過去 = 投稿の行
    .filter((r) => !r.est && Recommender.deadlineRowIsPast(r, now))
    .reduce<(typeof 投稿の行)[number] | null>(
      (a, b) => (!a || 表示の刻み(b) > 表示の刻み(a) ? b : a),
      null,
    );
  const 投稿の案內 = 次の投稿
    ? `次の投稿締切: ${line(次の投稿, now)}`
    : 直近の過去
      ? `次の投稿締切: 今後の収録にありません（推定を除く。直近では ${line(直近の過去, now)}）。`
      : "次の投稿締切: 推定を除く投稿締切は収録にありません。";

  /* 過去の件数（下の頭で言う – 何件が過ぎたかを AI が自分で数へなくて済むやうに – 第 961 回）。 */
  const 過ぎた件數 = hit.filter((r) => Recommender.deadlineRowIsPast(r, now)).length;
  // 共有募集の行には統合先の属性が入るため、照会した会議の属性を使う。
  const venue = 會議の版 ?? 一つ.conf;
  const identity = venueIdentity(venue);
  receive?.({
    ...identity,
    ...venueClassification(venue),
    ...editionCounts,
    deadline_total: hit.length,
    upcoming_deadline_total: 今後,
    past_deadline_total: 過ぎた件數,
    next_submission: 次の投稿 ? structuredDeadline(次の投稿, now) : null,
    next_estimated_submission: 推定の次の投稿 ? structuredDeadline(推定の次の投稿, now) : null,
    latest_past_submission: 直近の過去 ? structuredDeadline(直近の過去, now) : null,
    rows: ordered.map((row) => structuredDeadline(row, now)),
    editions: schedules,
    ...context,
  });
  return [
    斷り +
      `（${名}・${list.length} 行から）` +
      (key && name ? "\n注: name は key と共に与えられたので見ていません" : ""),
    `会議: ${identity.title || identity.venue_key}（key: ${identity.venue_key}${identity.acronym ? `・${identity.acronym}` : ""}）`,
    /* 正式名も言ふ（**會議名のすぐ下** – 畫面の一覧のセルと行の詳細がどちらも
     * 略稱の下に正式名を出すその順）。實測 2026-10-16: 收録 5,039 行が正式名を持つ
     * のに、MCP は一句も出して居なかつた – 「ICDE と何の略？」に AI が答えられない。
     * 略稱と正式名が同じ行では出さない（畫面と同じ – 重ねて書かない）。 */
    ...(() => {
      const 正式名 = identity.full_name;
      if (!正式名 || 正式名 === identity.title) return [];
      return [`正式名: ${正式名}`];
    })(),
    ...(scopeErr ? [scopeErr] : []),
    `版: ${版
      .map((id) => {
        const notes = [
          ...(estimatedEditionIds.has(id) ? ["推定"] : []),
          ...(!displayedDeadlineEditions.has(id)
            ? [allDeadlineEditions.has(id) ? "締切は表示範囲外" : "締切未収録"]
            : []),
        ];
        return notes.length ? `${id}(${notes.join("・")})` : id;
      })
      .join(" / ")}`,

    ...venueClassificationLines(venue),
    /* その会議の締切が、どの位確かめられているか（行ごとの札だけでは、全体の偏りが分からん）。 */
    `確認: ${確認の內譯(hit)}`,
    投稿の案內,
    ...(推定の次の投稿 ? [`次の投稿締切（推定）: ${line(推定の次の投稿, now)}`] : []),
    ...venueScheduleLines(schedules.filter((ed) => !行を持つ版.has(ed.edition_id || ""))),
    "",

    /* 丸括弧の締めと件數がくつつく（「…早い順）過去は 18 件」）と讀みにくいので、
     * 間を空ける（第 1100 回 – 實測 2026-10-15 の venue_info の頭）。 */
    ...(() => {
      const 件數の註 = [
        見本.length > 60 ? `${見本.length} 件のうち 60 件` : "",
        過ぎた件數 > 0 ? `過去は ${過ぎた件數} 件` : "",
      ]
        .filter((t) => t.length > 0)
        .join("・");
      return [
        `締切と会期（今後の物から、同じ側では日本時間の早い順）${件數の註 ? ` ${件數の註}` : ""}:`,
      ];
    })(),
    ...見本.slice(0, 60),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

function explainWord(args: { word?: unknown; scope?: unknown }, now: number): string {
  const 打たれた語 = 文字として讀む(args.word);
  if (!打たれた語) return "語をください。";
  const { 使ふ: word, 切つた: 語を切つた } = 調べる語(打たれた語);
  const 語の截りの文 = 語を切つた
    ? `（${打たれた語.length} 字のうち、最初の ${語の截} 字（1 つの語として）で調べました – 残りは参考にしていません）`
    : "";
  const { list, 名, 生成, 窓が無い } = pick(args.scope);
  const 古さ = 古さの斷り(生成, now);
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(word, now), now);
  const 件數 = list.filter((r) => 照合(r.hay) === true).length;

  const 窓の外 = 窓の外の件數(照合, 名);
  const 案内 = guidance(word, 0, list, now);
  const 果て = 窓の外 ? "" : 果ての案内(word, list, 名);
  const 日數 = 日數幅の案内(word, list, now, {});
  const 種別の報 = 種別の報べ(word, list, now, {});
  const 語ごと = 語ごとの案號(word, list, now);
  const URLの報 = URLの案内(word);
  const 名簿 = 名乘りの案内(word, list, now);
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
    /* 行が出る時は**中身を少し見せる**。行は `search_deadlines` と同じ形
     * （`line()`）で、3 行まで。 */
    const 素の行 = list.filter((r) => 照合(r.hay) === true);
    /* **両方の数を言う**。 */
    const 畫面の行 = 畫面の既定(素の行, now, {});
    const 行 = sortRows(畫面の行).slice(0, 3);

    const 切替 = 畫面の行.length > 行.length ? `・このうち ${行.length} 行を出します` : "";

    const 見えて居る文 = 見えて居る注(word, 畫面の行.length);

    /* 番兵（分離子だけの文）に一致する = 語が 1 つも無い = 絞り込みが效いて居ない。 */
    const 記号だけの文 = Recommender.searchMatcher(word, now)("・ー()")
      ? `この語は記号だけなので、絞り込みとして効く語がありません（すべての行を表示しています）。`
      : "";
    return [
      `「${word}」は素の照合で ${件數} 行・画面の既定の絞り込み（今後・投稿締切の種別・推定を除く）を通すと ${畫面の行.length} 行です（${名}${切替}${語の截りの文}）。`,
      ...(記号だけの文 ? [記号だけの文] : []),
      ...(見えて居る文 ? [見えて居る文.trim()] : []),
      ...行.map((r) => `- ${line(r, now)}`),
      ...(畫面の行.length > 行.length
        ? [`- …ほか ${畫面の行.length - 行.length} 行（search_deadlines で引けます）`]
        : []),
      /* 画面の既定で 0 件に成る時は、その**理由**を添える。 */
      ...(畫面の行.length === 0 && (指南.length || 受皿.length)
        ? ["画面の既定の絞り込みで 0 件になる理由:", ...指南, ...受皿].map((n) =>
            n === "" ? "" : `- ${n}`,
          )
        : []),
      ...(古さ ? ["", 古さ] : []),
    ].join("\n");
  }
  return [
    `「${word}」は 0 行です${語の截りの文}。画面がこの時に出す案内:`,
    ...(scopeErr ? [scopeErr] : []),
    ...(窓が無いの斷り(窓が無い) ? [窓が無いの斷り(窓が無い)] : []),
    ...(窓の外
      ? [
          `- 画面が最初に読む窓（${list.length} 行）には 1 行もありませんが、**収録の全体には ${窓の外} 行あります**（scope: "all" で引けます）`,
        ]
      : []),
    /* 「案内は無し」は**何も立たなんだ時だけ**。 */
    ...(指南.length || 受皿.length
      ? [...指南, ...受皿].map((n) => `- ${n}`)
      : ["- （案内は無し＝表の語ではない語）"]),
    ...手.map((t) => `- 打ち直すなら ${t}`),
    ...(古さ ? ["", 古さ] : []),
  ].join("\n");
}

/** 容量を MiB / KB で示す（画面の `bytesJa` と同じ式 – 両方で単位が違ふと読めない）。 */
function 容量の文(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `約 ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `約 ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const 千の桁の文 = (n: number): string => String(n).replace(/(\d)(?=(\d{3})+(?!\d))/g, "$1,");

function collectionStats(args: Record<string, unknown> = {}, now: number): string {
  const 無視した引數 = Object.keys(args ?? {}).filter(
    (k) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== "",
  );
  const list = allRows();

  const 收錄 = snapshot();
  const 会議 = (收錄.conferences ?? []).length;
  const 版 = (收錄.conferences ?? []).reduce(
    (n, c) => n + (Array.isArray(c.editions) ? c.editions.length : 0),
    0,
  );
  const 今後 = list.filter((r) => !Recommender.deadlineRowIsPast(r, now)).length;
  const 日 = list.map((r) => r.localDate || new Date(r.t).toISOString().slice(0, 10)).sort();
  /* 生成時刻は**同じファイル**から取る（画面の右上の「データ生成」と同じ書き方・同じ関数）。
   * 画面が最初に読む窓は別のファイルなので、そちらの生成時刻も添へる（古さの斷りは窓ごとに違ふ）。 */
  const 元の生成 = 收錄.snapshot_metadata?.generated_at;
  const 窓の生成 = catalog() ? 生成の表示(catalog()?.generated_at) : "";
  const 古さ = 古さの斷り(元の生成, now);

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
    "llms.txt（機械向けの索引。何が何処にあるか）",
  ];
  return [
    ...(無視した引數.length
      ? [
          `注: 無視した絞り込み ${無視した引數.join("・")} はこの道具では効きません – 収録の全体を数えます`,
        ]
      : []),
    `収録（${DATA_PATH.replace(`${ROOT}/`, "")}）: 会議 ${会議} 件 / 版 ${版} 件（元の収録データ。生成時に重複をまとめるため、表示件数と異なる場合があります）/ 締切の行 ${千の桁の文(list.length)} 行（${日.length ? `日付の幅 ${日[0]} 〜 ${日[日.length - 1]}` : "締切の日付は未収録"}）`,
    `データ生成: ${生成の表示(元の生成)}（上の行と同じ出所。画面の右上と同じ書き方）`,
    ...(窓の生成 ? [`画面が最初に読む窓（public/catalog.json）のデータ生成: ${窓の生成}`] : []),
    `うち今後の締切: ${千の桁の文(今後)} 行（${new Date(now).toISOString().slice(0, 10)} 以降）`,
    `確認の状態: ${確認の內譯(list)}`,

    ...((): string[] => {
      const 数 = new Map<string, number>();
      for (const c of 收錄.conferences ?? []) {
        const 会議 = c as { categories?: unknown };
        for (const key of Array.isArray(会議.categories) ? 会議.categories : []) {
          const k = String(key);
          数.set(k, (数.get(k) ?? 0) + 1);
        }
      }
      if (!数.size) return [];
      const 並び = [...数.entries()]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "ja"))
        .map(([k, n]) => `${Recommender.categoryLabelJa(k) ?? k} ${n}`);
      return [`分野別の会議数（多い順・会議 1 件は複数の分野に数える）: ${並び.join("・")}`];
    })(),
    ...ソースの狀態(),
    ...(古さ ? ["", 古さ] : []),
    "",
    "配付しているファイル（サイトと同じ場所にある）:",
    ...ファイル.map((f) => `- ${f}`),
  ].join("\n");
}

/* ---- 投稿先の推薦---- */

/* 投稿先の検索・推薦は、語彙検索または明示的に指定した実モデルで評価する。 */
interface RecommendationIndex {
  rows: Row[];
  conferences: unknown[];
  generated_at: unknown;
  uses_reranker: boolean;
  categories: Record<string, string>;
}
let recommendationCache: RecommendationIndex | null | undefined;

let dataFileVersions = "";
function refreshDataCaches(): void {
  const versions = [CATALOG_PATH, DATA_PATH, RECOMMENDATION_PATH]
    .map((path) => {
      try {
        const stat = statSync(path, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      } catch {
        return "unavailable";
      }
    })
    .join("|");
  if (versions === dataFileVersions) return;
  dataFileVersions = versions;
  snapshotCache = null;
  catalogCache = undefined;
  screenCache = null;
  allCache = null;
  軸の索引 = undefined;
  recommendationCache = undefined;
}

/** 索引の更新時に読み直し、名前の IDF と reranker を設定して候補行を作る。 */
function recommendation(): RecommendationIndex | null {
  if (recommendationCache !== undefined) return recommendationCache;
  try {
    const 品書 = JSON.parse(readFileSync(RECOMMENDATION_PATH, "utf8")) as {
      conferences?: unknown[];
      reranker?: unknown;
      generated_at?: unknown;
      categories?: Record<string, string>;
    };
    const conferences = Array.isArray(品書.conferences) ? 品書.conferences : [];
    if (!conferences.length) throw new Error("conferences が空");
    Recommender.setNameIdf(Recommender.buildNameIdf(conferences));
    Recommender.setReranker(品書.reranker ?? null);
    recommendationCache = {
      rows: displayRows(Recommender.candidateRows(品書 as never) as unknown as Row[]),
      conferences,
      generated_at: 品書.generated_at ?? null,
      uses_reranker: isValidRerankerModel(品書.reranker),
      categories: 品書.categories ?? {},
    };
  } catch {
    recommendationCache = null;
  }
  return recommendationCache;
}

async function recommendVenues(
  args: Record<string, unknown> & { paper?: unknown; limit?: unknown; offset?: unknown },
  now: number,
  receive?: (result: Record<string, unknown>) => void,
  search = false,
): Promise<string> {
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("offset は 0 以上の整数で指定してください。");
  if (args.paper !== undefined && typeof args.paper !== "string")
    throw new Error(
      "paper は文字列で指定してください。論文のJSONも、文字列にして paper に指定してください。",
    );
  const paper = 文字として讀む(args.paper);
  if (!paper)
    return [
      "論文の題名か概要をください。",
      "画面の入力と同じ形（`題名 | キーワード, キーワード | 投稿先`）が一番よく当たります（1 行だけでも構いません）。",
    ].join("\n");
  const 索引 = recommendation();
  if (!索引)
    return `推薦の索引（${RECOMMENDATION_PATH.replace(`${ROOT}/`, "")}）が読めません。このリポジトリで \`npm run build\` を実行してからお試しください。`;

  const 無視した = [
    "scope",
    "within_days",
    "include_past",
    "include_estimated",
    "kinds",
    "kind",
    "rank",
    "domestic",
    "online",
  ].filter((k) => args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== "");
  const 無視の斷り = 無視した.length
    ? `（無視した絞り込み ${無視した.join("・")} はこの道具では効きません – 順位と点で選びます）`
    : "";
  /* 長い論文は**最初の 20 行だけ**を見る（上の截り – 切つたことを言う）。 */
  const 限り = 數の引數("limit", args.limit, 1);

  const limit = Math.max(1, Math.floor(Math.min(限り.使ふ ?? 10, 30)));
  const limit端數 = 端數と上限の斷り(限り.使ふ, 30);
  const 全部の行 = Recommender.parsePaperLines(paper);

  const 行の截 = 20;
  const lines = 全部の行.slice(0, 行の截);

  const 行數の截 = 20;
  const 論文ごとの行 = lines.map((p) => {
    const 割つた = String(p.title ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (割つた.length <= 行數の截) return p;
    return { ...p, title: 割つた.slice(0, 行數の截).join("\n") };
  });
  const 一番長い論文 = Math.max(
    0,
    ...全部の行.map(
      (p) =>
        String(p.title ?? "")
          .split("\n")
          .filter((l) => l.trim()).length,
    ),
  );

  const 截りの文 =
    全部の行.length > 行の截
      ? `（${全部の行.length} 行のうち、最初の ${行の截} 行（題名・概要）で調べました – 残りは参考にしていません）`
      : 一番長い論文 > 行數の截
        ? `（論文の中の ${一番長い論文} 行のうち、最初の ${行數の截} 行で調べました – 残りの行は参考にしていません）`
        : "";
  if (!論文ごとの行.length)
    return "論文の題名を読み取れませんでした。題名を 1 行でください（`|` でキーワードと投稿先を添えられます）。";

  // Recommendation profiles retain past editions that the deadline-screen window omits.
  const 行 = 索引.rows;
  const 會議 = 索引.conferences;
  const pool = Recommender.candidatePool(行 as never, 會議, now) as unknown as Row[];

  if (args.retrieval !== undefined && !["lexical", "semantic"].includes(String(args.retrieval)))
    throw new Error("retrieval は lexical または semantic を指定してください。");
  const semantic =
    args.retrieval === "semantic"
      ? await (await import("./mcp-semantic.ts")).semanticVenueScores(
          ROOT,
          會議,
          索引.categories,
          論文ごとの行,
        )
      : null;
  if (!semantic) Recommender.setTopicVecs(null);
  const 候補 = Recommender.venueRecommendations(pool, 論文ごとの行, semantic?.scores ?? null, now, {
    fieldedLexical: true,
    ...(semantic
      ? {
          semanticSimilarities: semantic.similarities,
          venueCats: Recommender.autoDetectCats(論文ごとの行),
        }
      : {}),
  }).filter((r) => r.fit.score >= 10);
  if (search && semantic)
    候補.sort(
      (a, b) => (semantic.similarities[b.venueKey] ?? 0) - (semantic.similarities[a.venueKey] ?? 0),
    );

  const 題々 = 論文ごとの行
    .map((l) =>
      String(l.title || l.abstract || "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  const 題 = 題々[0] ?? "";
  const 餘 = 題々.length > 1 ? `（ほか ${題々.length - 1} 行の入力も使っています）` : "";

  const 題の切り詰め =
    題.length > 40 ? `（見出しは 40 字に切り詰めた物です。調べたのは全文です）` : "";
  const 題の見出し = `「${題.length > 40 ? `${題.slice(0, 39)}…` : 題}${餘}」${題の切り詰め}`;

  const 過ぎた件數 = 候補.filter((r) => r.availability.status === "past").length;
  const 頭 =
    `${題の見出し}に合う投稿先: ${候補.length} 件（${semantic ? "実モデルの意味検索を基に評価" : "語の一致を基に評価"}${無視の斷り}${截りの文}${limit端數} – ` +
    `${semantic ? "英語・日本語のモデルで全収録会議を評価しました" : "意味検索の埋め込みは読まないので、埋め込みを使える画面とは点が動く事があります"}${限り.斷り}）` +
    /* 過ぎた候補は「次回の開催に向けた参考」として件数を分けて書く（黙っていると AI が
     * 今出せるように勧めてしまふ – 画面の「締切済み」と同じ出し分け）。 */
    (過ぎた件數 > 0
      ? `（うち ${過ぎた件數} 件は締切が過ぎた会議です – 次回の開催に向けた参考に載せています）`
      : "");
  const 見本 = 候補.slice(offset, offset + limit);
  const axesFor = (r: (typeof 候補)[number]) => {
    const stored = 品書の軸().get(String(r.row.conf.key ?? ""));
    return isRecommendationAxes(stored)
      ? {
          ...stored,
          deadline_trust: {
            ...stored.deadline_trust,
            sourceFreshness: recommendationAxes(
              r.row.conf as unknown as Record<string, unknown>,
              null,
              now,
            ).deadline_trust.sourceFreshness,
          },
          research_fit: { ...stored.research_fit, score: r.fit.score },
        }
      : recommendationAxes(r.row.conf as unknown as Record<string, unknown>, r.fit.score, now);
  };
  receive?.({
    total: 候補.length,
    candidate_venues: new Set(
      pool.flatMap((row) => [
        row.conf.key,
        ...(row.submission?.sourceRecords ?? []).map((record) => record.venueKey),
      ]),
    ).size,
    offset,
    limit,
    returned: 見本.length,
    next_offset: offset + 見本.length < 候補.length ? offset + 見本.length : null,
    evaluated_at: new Date(now).toISOString(),
    generated_at: 索引.generated_at,
    uses_embeddings: Boolean(semantic),
    embedding_model: semantic ? { id: semantic.model, revision: semantic.revision } : null,
    uses_reranker: 索引.uses_reranker,
    ignored_filters: 無視した,
    input: {
      received: 全部の行.length,
      used: 論文ごとの行.length,
      truncated: 全部の行.length > 行の截 || 一番長い論文 > 行數の截,
    },
    rows: 見本.map((r, index) => ({
      rank: offset + index + 1,
      venue_key: r.venueKey,
      title: r.row.conf.title,
      official_url: officialLink(r.row.ed.link, r.row.conf.link),
      /* 正式名。畫面の推薦カードは會議名の下に正式名を出す（一覧のセルと同じ）– 締切の
       * 行が null の候補（締切不明・常時受付）でも正式名が讀めるやうに、此に持つ。 */
      full_name: r.row.conf.full_name ?? null,
      fit: {
        score: r.fit.score,
        confidence: r.fit.confidence,
        label: r.fit.label,
        lexical_score: r.fit.lexicalScore,
        evidence: r.fit.evidence,
      },
      availability:
        r.availability.status === "ongoing"
          ? { ...r.availability, timestamp: null }
          : r.availability,
      deadline:
        r.availability.status === "ongoing" || !Number.isFinite(r.row.t)
          ? null
          : structuredDeadline(r.row as unknown as Row, now),
      axes: axesFor(r),
    })),
  });
  if (!候補.length)
    return [
      頭,
      "",
      "この題名の語と重なる投稿先は見つかりませんでした。題名に加えて、分野の語やキーワード（`tsn, real-time, scheduling` のように）を添えると当たりやすくなります。",
    ].join("\n");
  if (offset >= 候補.length)
    return `${頭}\nこの位置には結果がありません（offset: ${offset}／全 ${候補.length} 件）。`;
  /* pool に過去の代表が入っていることを黙らない（AI が「これから締め切る会報」として
   * 過去の行を埋めないように – 頭で件数を分けて言う）。 */
  return [
    頭,

    "評価の「候補」はいちばん近い会議との差が小さいこと、「重なりうすい」は言葉の重なりが弱いことを示します（画面の『見方のてびき』と同じ）。数値は並べるための目安で、採択の予測ではありません。",
    `（${search && semantic ? "意味検索の類似度が高い順" : "一致評価の高い順"}${offset > 0 ? `。${offset + 1} 件目から ${見本.length} 件表示・残り ${Math.max(0, 候補.length - offset - 見本.length)} 件` : 候補.length > limit ? `。${limit} 件まで表示・残り ${候補.length - limit} 件` : ""}）`,
    "",
    ...見本.map((r, i) => {
      const 評價 = `${String(r.fit.label ?? "評価保留")}（${Number(r.fit.score) || 0} 点）`;
      /* **選定理由** – 画面のカードと同じ言ひ回し・同じ要素（`site/app.ts` の `reasonSignals`
       * と同じ 5 つ + 過去掲載先）。実測 2026-10-28: AI が「何でこの会報か」を根拠付きで
       * 言へなかつた（点と札だけ）。画面が持つ物を黙つて落とすと、推薦の強さが分からん。 */
      /* **締切の確認状況** – 画面のカードと同じ 4 つの軸（`site/app.ts` の
       * `deadlineTrust`。軸その物は `recommendation-core.ts` の共有計算）。実測
       * 2026-10-29: MCP の推薦行は日付と種別だけを出して、**その締切が公式確認できているか**
       * を言はなかつた（AI が「次は 2027-01-29 です」と言へても、推定の日付なのか分からん）。 */

      const 軸 = axesFor(r);
      const 信賴の札: Record<string, string> = {
        official: "公式確認",
        publisher: "出版社確認",
        "curated-manual": "手動確認",
        aggregator: "集約情報",
        assumption: "推定",
        unverified: "未確認",
      };
      const 締切の信賴 = 軸.deadline_trust;
      const 収録情報 = venueEvidenceLineJa(軸.venue_evidence);
      const 確認狀況 =
        `締切の確認状況: 日付 ${信賴の札[締切の信賴.date] ?? String(締切の信賴.date)}` +
        ` ／ 時刻 ${信賴の札[締切の信賴.time] ?? String(締切の信賴.time)}` +
        ` ／ タイムゾーン ${信賴の札[締切の信賴.timezone] ?? String(締切の信賴.timezone)}` +
        ` ／ 種別 ${信賴の札[締切の信賴.kind] ?? String(締切の信賴.kind)}`;

      const 新しい狀態: Record<string, string> = {
        fresh: "取得時に上流へアクセス",
        unknown: "取得履歴なし",
        "cache-fallback": "前回の取得データを使用",
        "snapshot-fallback": "保存済みの収録データを使用",
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
        `${offset + i + 1}. 一致評価 ${評價}｜${line(r.row as unknown as Row, now)}｜${収録情報}｜${確認狀況}` +
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
      "日本語で投稿締切を検索する。語を省いて kind / kinds / rank / domestic / online / within_days だけでも絞れる。既定は今後の abstract / paper / journal、推定は除外。scope は screen（初期一覧）または all（収録全体）。structuredContent に total・rows・next_offset を返す。続きは同じ条件と next_offset を offset に指定する。日付のみの行の utc・jst は null。推定期間、投稿トラック、確認状態を別に返す。公式確認（いつ・どこで・何を確かめたか）は verification_ja に画面の行の詳細と同じ日本語で返します（内部の鍵名は verification に残します）。前に出ていた締切も表示する。日付語は別ラウンドや会期にも当たるため、締切だけの期間指定には within_days を使う。会期の欄には、上流が書いた原文（`March 18-21, 2024` のやうな自由文）を「原表記」として添えます（画面の行の詳細と同じ）。0 件のときは画面と同じ案内と「打ち直すなら」の候補を返す。返す行の形: 日時 | 種別 | 確認状態（ある場合）| 会議名（版の識別子）| ランク | 会期 | 開催地 URL。テキストは `| ` で切り、構造化結果を優先する。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索語（日本語。例: セキュリティ / 今月 / 海外開催）",
        },
        limit: { type: "number", description: "返す行数（既定 20・最大 100）" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "取得開始位置（既定 0）。次ページは返却値 next_offset を同じ検索条件で指定",
        },
        include_past: {
          type: "boolean",
          description: "過ぎた締切も含める（既定 false＝画面の既定と同じ）",
        },
        include_estimated: { type: "boolean", description: "推定の締切も含める（既定 false）" },
        kinds: {
          type: "array",
          description:
            "種別のキーで絞る（既定は画面と同じ abstract / paper / journal）。**日本語の種別名でも受けます**（論文締切＝paper・採否通知＝notification のように – 行に出す言葉と同じ）",
        },
        kind: {
          type: "string",
          description:
            "種別のキーを一つだけ絞る（`kinds` の単数の書き方。同じ物を受ける）。**日本語の種別名でも受けます**",
        },
        rank: {
          type: "string",
          description:
            "ランクの等級で絞る（`A*` / `A` / `B` / `C` / `N`。画面のランク欄と同じ**厳密比較**（大文字小文字も違う – `a` は効かない） – `A` は `core:A*` を巻き込まない）。**行の出し方（`CCF A`・`CORE A*`）でも受けます** – 後ろの等級だけを見ます",
        },
        domestic: {
          type: "boolean",
          description:
            "国内研究会・国内シンポジウムだけに絞る（画面の同じ名前のチェック欄と同じ判定。**日本で開かれる国際会議は入らない** – それは開催地の語「東京」「日本」で引く）",
        },
        online: {
          type: "boolean",
          description:
            "オンライン参加可の行だけに絞る（画面の同じ名前のチェック欄と同じ判定。会場の表記にオンライン・ハイブリッドなどの記述がある行だけ – 記述がない行を対面と決めつけない）",
        },
        within_days: {
          type: "number",
          description:
            "「締切まで N 日」の窓（画面の同じ名前の選択欄と同じ判定。JST の暦日で切り、`include_past: true` の時は同じ日数の過去側も含める）。語を省いてこれだけでも引ける",
        },
        scope: {
          type: "string",
          enum: ["screen", "all", "collection", "full", "window", "catalog"],
          description:
            "見る窓。screen＝画面が最初に読む窓（180 日。catalog.json がある時だけ）／all＝収録の全体（過去と先の締切も含む）。**collection・full＝all／window・catalog＝screen**（他の三つの道具と同じエイリアス）。省いた時は screen",
        },
      },
    },
  },
  {
    name: "list_upcoming",
    description:
      "今日から days 日以内の締切と開催日程を返す。両方を合わせて時系列に1ページ最大100件。structuredContent.items の type は deadline または event。total・next_offset を返し、続きは同じ条件で offset に next_offset を指定する。scope と kind/kinds は締切の条件で、会期は収録全体の同期間から選ぶ。既定は種別では絞らない（全部）、推定も含む。kind / kinds は日本語の種別名と配列も受ける。推定期間・トラック・前に出ていた締切も表示する。範囲は JST の暦日で判定する。within_days と境目の切り方は同じ。search_deadlines と件数を比べる場合は種別・推定・scope を揃える。既定の条件では件数はそのままでは違う。返す行の形: 締切は日時 | 種別 | 確認状態（ある場合）| 会議名（版の識別子）| ランク | 会期 | 開催地 URL。会期の行は別の形で、開催の節に - 開始日〜終了日 | 会議名（key: 識別子・版）| 開催地 URL。会期の行の会議名は年を添えた形、開催地は締切の行と同じ日本語表記です（空でも「未確認」を出します）。",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "何日先まで（既定 30・最大 400）" },
        limit: {
          type: "number",
          description: "締切と会期を合わせた1ページの件数（既定100・最大100）",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "取得開始位置。続きは同じ条件と next_offset を指定",
        },
        kind: {
          type: "string",
          description:
            '種別のキー（例: paper / abstract / camera_ready。**日本語の種別名でも受けます** – 論文締切＝paper・採否通知＝notification のように、行に出す言葉と同じ。全部なら "all"。複数を配列で渡すとどれかに当たる行を選ぶ。大文字は小文字に直して受ける）',
        },
        kinds: {
          type: "array",
          items: { type: "string" },
          description:
            "種別のキーの並び（search_deadlines と同じ名。どちらでも受ける）。**日本語の種別名でも受けます**",
        },
        scope: {
          type: "string",
          enum: ["screen", "all", "collection", "full", "window", "catalog"],
          description:
            "見る窓（既定 all）。collection・full＝all／window・catalog＝screen – **同じエイリアス**（省いた時は all）",
        },
      },
    },
  },
  {
    name: "venue_info",
    description:
      "会議の開催回、締切、会期、ランク、主題、正式名を返す。structuredContent の editions に推定を除く全開催回の会期・確かさ・公式URL、rows に締切を返す。key は小文字の識別子、name は略称・正式名・名前の一部。開催回の識別子は lookup_status: edition_key と retry_arguments で関連会議へ案内する。見つからない識別子は lookup_status: not_found と略称の候補を返す。曖昧な名前や古いkeyは lookup_status: ambiguous と candidates を返す。候補の venue_key を key に指定して再照会する。表示範囲外の締切は lookup_status: out_of_scope と再照会用の retry_arguments で案内する。scope の既定は all で、過ぎた分も全部出る。今後の物から並べ、推定以外の次の投稿締切を next_submission、推定の見込みを next_estimated_submission で分けて返す。主題は分野より詳しい札で、収録にある会議だけに出します（画面の行の詳細の「主題」と同じ）。返す行の形: 会議の要約に続いて、日時 | 種別 | 確認状態（ある場合）| 会議名（版の識別子）| ランク | 会期 | 開催地 URL。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "会議の識別子（例: sigkdd）" },
        name: { type: "string", description: "会議名の一部（例: KDD）" },
        scope: {
          type: "string",
          enum: ["screen", "all", "collection", "full", "window", "catalog"],
          description:
            "見る窓（既定 all）。collection・full＝all／window・catalog＝screen – **同じエイリアス**",
        },
      },
    },
  },
  {
    name: "collection_stats",
    description:
      "収録件数、分野別の会議数、データ生成時刻、締切の確認状態、データ源の取得状態、配布ファイルを返す。返る文の形: 収録全体と初期一覧の件数を分けた日本語の要約。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_venues",
    description:
      "全収録の投稿先プロフィールから、研究テーマ・論文の題名・概要に合う会議や論文誌を検索する。締切不明や締切済みの会議も候補に含む。retrieval: semantic で実モデル、lexical で語彙と公式トピックを用いる。締切日時を探す場合は search_deadlines を使う。構造化結果の candidate_venues は検索した収録会議数、total は一致した候補数。limit と offset でページ送りできる。",
    inputSchema: {
      type: "object",
      properties: {
        retrieval: {
          type: "string",
          enum: ["lexical", "semantic"],
          description:
            "既定はlexical。semanticはローカルの実モデルで全収録会議を意味検索。モデル未準備時はエラーを返す。",
        },
        query: {
          type: "string",
          description: "研究テーマ、題名、概要、または title・abstract を持つJSON文字列",
        },
        limit: { type: "number", description: "返す候補の数（既定10・最大30）" },
        offset: { type: "integer", minimum: 0, description: "取得開始位置（既定0）" },
      },
      required: ["query"],
    },
  },
  {
    name: "recommend_venues",
    description:
      "論文情報に合う投稿先を語彙の一致で探す。学習済みの並べ替えモデルがある場合は併用する。retrieval: semantic を指定すると実モデルを使う。候補の範囲は画面と共通。順位表に入るのは実質的な一致がある候補だけで、証拠がない会議を分野だけの一致で推薦しない。長い入力は最初の 20 行と各行の長さ制限で切り、切った旨を返す。返す行の形: 順位と一致評価、選定理由、締切の確認状況に続いて締切行。1ページ最大30件。structuredContent に順位・一致評価・受付状態・締切・確認情報を返す。続きは同じ論文情報と next_offset を offset に指定する。",
    inputSchema: {
      type: "object",
      properties: {
        retrieval: {
          type: "string",
          enum: ["lexical", "semantic"],
          description:
            "既定はlexical。semanticはローカルの実モデルで全収録会議を意味検索。モデル未準備時はエラーを返す。",
        },
        paper: {
          type: "string",
          description:
            "投稿予定の論文。題名 | キーワード | 投稿先、Title/Abstract や タイトル/概要 の項目付きテキスト、title・abstract・keywords・venue を持つ JSON 文字列を受ける。概要のみの JSON も使える。",
        },
        limit: { type: "number", description: "返す候補の数（既定 10・最大 30）" },
        offset: {
          type: "integer",
          minimum: 0,
          description: "取得開始位置（既定0）。続きは同じ論文情報と next_offset を指定",
        },
      },
      required: ["paper"],
    },
  },
  {
    name: "explain_word",
    description:
      "検索語に当たる行数と、0 件のときの案内を返す。件数は絞り込み前の素の照合で数えるため、search_deadlines の結果と異なる場合がある。返す行の形: 行数と案内、代表的な締切を最大3行。0 件では「打ち直すなら」の候補を示す。",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "調べる語（例: 学生でも投稿できる）" },
        scope: {
          type: "string",
          enum: ["screen", "all", "collection", "full", "window", "catalog"],
          description:
            "見る窓（既定 screen）。collection・full＝all／window・catalog＝screen – **同じエイリアス**",
        },
      },
      required: ["word"],
    },
  },
] as const;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  now: number,
  receive?: (result: Record<string, unknown>) => void,
): Promise<string> {
  refreshDataCaches();
  if (name === "search_deadlines") return searchDeadlines(args, now, receive);
  if (name === "list_upcoming") return listUpcoming(args, now, receive);
  if (name === "venue_info") return venueInfo(args, now, receive);
  if (name === "explain_word") return explainWord(args, now);
  if (name === "recommend_venues") return recommendVenues(args, now, receive);
  if (name === "search_venues") {
    if (typeof args.query !== "string" || !args.query.trim())
      throw new Error("query に研究テーマ・題名・概要を指定してください。");
    return recommendVenues({ ...args, paper: args.query }, now, receive, true);
  }
  if (name === "collection_stats") return collectionStats(args, now);
  throw new Error(`知らないツール: ${name}`);
}

/* ---- stdio の MCP（1 行 = 1 つの JSON-RPC）---- */

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(raw: string, now: number): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSONを読み取れません。" } });
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    send({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "要求はJSONオブジェクトで指定してください。" },
    });
    return;
  }
  const request = value as Record<string, unknown>;
  const { id, method } = request;
  const validId = typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id));
  if (request.jsonrpc !== "2.0" || typeof method !== "string" || (id !== undefined && !validId)) {
    send({
      jsonrpc: "2.0",
      id: validId ? id : null,
      error: { code: -32600, message: "jsonrpc、method、id の形式を確認してください。" },
    });
    return;
  }
  if (id === undefined) return;
  if (
    request.params !== undefined &&
    (!request.params || typeof request.params !== "object" || Array.isArray(request.params))
  ) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: "params はJSONオブジェクトで指定してください。" },
    });
    return;
  }
  const params = (request.params ?? {}) as Record<string, unknown>;
  const reply = (result: unknown): void => send({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    if (typeof params.protocolVersion !== "string") {
      fail(-32602, "protocolVersion は対応する通信版の文字列で指定してください。");
      return;
    }
    const capabilities = params.capabilities;
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      fail(-32602, "capabilities はクライアントの機能を示すJSONオブジェクトで指定してください。");
      return;
    }
    const clientInfo = params.clientInfo as Record<string, unknown> | null | undefined;
    if (
      !clientInfo ||
      typeof clientInfo !== "object" ||
      Array.isArray(clientInfo) ||
      typeof clientInfo.name !== "string" ||
      typeof clientInfo.version !== "string"
    ) {
      fail(-32602, "clientInfo には name と version を文字列で指定してください。");
      return;
    }
    reply({
      protocolVersion: DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
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
    try {
      const supplied = params.arguments;
      if (
        supplied !== undefined &&
        (supplied === null || typeof supplied !== "object" || Array.isArray(supplied))
      )
        throw new Error(
          'arguments はオブジェクトで指定してください（例: {"paper":"論文の題名"}）。',
        );
      const args = (supplied ?? {}) as Record<string, unknown>;
      const 此の道具 = TOOLS.find((t) => t.name === name);
      const 未宣言 = Object.keys(args).filter(
        (k) => !Object.keys(此の道具?.inputSchema?.properties ?? {}).includes(k),
      );
      let structuredContent: Record<string, unknown> | undefined;
      const text = await callTool(name, args, now, (value) => {
        structuredContent = value;
      });
      reply({
        content: [
          {
            type: "text",
            text:
              未宣言.length && !text.startsWith("道具の実行に失敗")
                ? `${text}\n注: この道具にない引数 ${未宣言.join("・")} は効きません（schema にない物です）`
                : text,
          },
          ...(structuredContent ? [{ type: "text", text: JSON.stringify(structuredContent) }] : []),
        ],
        ...(structuredContent ? { structuredContent } : {}),
      });
    } catch (error) {
      const 文 = String(error instanceof Error ? error.message : error).trim();
      reply({
        content: [{ type: "text", text: `道具の実行に失敗: ${文 || "不明な失敗"}` }],
        ...(error instanceof Error && error.name === "SemanticModelError" && "diagnostic" in error
          ? { structuredContent: { error: (error as SemanticModelError).diagnostic } }
          : {}),
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) fail(-32601, `知らない呼び出し: ${String(method)}`);
}

export function runStdio(now?: number): void {
  let buffer = "";
  let queue = Promise.resolve();
  const enqueue = (raw: string) => {
    queue = queue.then(() => handle(raw, now ?? Date.now()));
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const raw = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (raw) enqueue(raw);
      at = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    const raw = buffer.trim();
    buffer = "";
    if (raw) enqueue(raw);
  });
}

/* 人が確かめる道（`node src/mcp.ts search "セキュリティ" 5`）。 */
function cliNumber(value: string | undefined): string | number | undefined {
  if (!value?.trim()) return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

async function main(): Promise<void> {
  const [tool, ...rawArgs] = process.argv.slice(2);
  const rest = [...rawArgs];
  if (!tool || tool === "--help" || tool === "-h") {
    process.stdout.write(
      `${[
        "kamiyobi の MCP サーバ（読み取り専用・stdio）。",
        "  AI から: MCP クライアントからこのファイルを起動します（`node src/mcp.ts`）。",
        "  手元で確認: ツール名と引数を指定すると、1 回分の結果を表示します。",
        `  ツール: ${TOOLS.map((t) => t.name).join(" / ")}`,
        "  論文の入力: --input ファイル名でUTF-8テキスト・JSONを読む。--input - は標準入力。",
        "  件数: --limit N で指定すると、題名末尾の数字も題名として扱います。",
        "  投稿先検索・推薦: --retrieval semantic で実モデル、lexical で語彙検索（既定）。",
        "  検索・推薦・直近一覧: --json で構造化結果を出力。--offset で続きの取得位置を指定。",
        '  例: node src/mcp.ts search "セキュリティ" 5',
        '  続き: node src/mcp.ts search "セキュリティ" 5 --offset 5',
        '  推薦の続き: node src/mcp.ts recommend "分散システム" 5 --offset 5',
        '  例: node src/mcp.ts explain_word "学生でも投稿できる"',
        "  例: node src/mcp.ts list_upcoming 30",
        "  例: node src/mcp.ts venue_info kdd",
        '  例: node src/mcp.ts recommend "分散システム"',
        '  例: node src/mcp.ts search_venues "機械学習" 5',
        "  例: node src/mcp.ts stats",
      ].join("\n")}\n`,
    );
    return;
  }
  const now = Date.now();
  /* 人の打ちやすい短い名も受ける（AI は MCP の名をそのまま使う）。 */
  const 別名: Record<string, string> = {
    search: "search_deadlines",
    search_venues: "search_venues",
    upcoming: "list_upcoming",
    venue: "venue_info",
    explain: "explain_word",
    recommend: "recommend_venues",
    /* 残りの一つにも読みやすい短い別名。 */
    stats: "collection_stats",
  };
  const 名 = 別名[tool] ?? tool;

  if (!TOOLS.some((t) => t.name === 名)) {
    const 一覧 = [
      `知らない道具「${tool}」です。道具は次の${TOOLS.length}種類です（--help でもこれが出ます）。`,
      ...TOOLS.map((t) => `  ${t.name}${別名[tool] === t.name ? `（別名 ${tool}）` : ""}`),
      "",
    ].join("\n");
    process.stderr.write(`${一覧}\n`);
    process.exitCode = 1;
    return;
  }
  let retrieval: string | undefined;
  const retrievalAt = rest.indexOf("--retrieval");
  if (retrievalAt >= 0) {
    const value = rest[retrievalAt + 1];
    if (
      !["search_venues", "recommend_venues"].includes(名) ||
      rest.lastIndexOf("--retrieval") !== retrievalAt ||
      !["lexical", "semantic"].includes(value ?? "")
    ) {
      process.stderr.write(
        "--retrieval は投稿先検索・推薦で lexical または semantic を1つ指定してください。\n",
      );
      process.exitCode = 1;
      return;
    }
    retrieval = value;
    rest.splice(retrievalAt, 2);
  }
  const jsonAt = rest.indexOf("--json");
  const json = jsonAt >= 0;
  if (json) {
    if (
      !["search_deadlines", "search_venues", "recommend_venues", "list_upcoming"].includes(名) ||
      rest.lastIndexOf("--json") !== jsonAt
    ) {
      process.stderr.write("--json は検索・推薦・直近一覧で1つ指定してください。\n");
      process.exitCode = 1;
      return;
    }
    rest.splice(jsonAt, 1);
  }
  let offset: number | undefined;
  const offsetAt = rest.indexOf("--offset");
  if (offsetAt >= 0) {
    const value = rest[offsetAt + 1];
    if (
      !["search_deadlines", "search_venues", "recommend_venues", "list_upcoming"].includes(名) ||
      rest.lastIndexOf("--offset") !== offsetAt ||
      value === undefined ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    ) {
      (json ? process.stderr : process.stdout).write(
        "--offset は検索・推薦・直近一覧の取得開始位置です。0 以上の整数を1つ指定してください。\n",
      );
      process.exitCode = 1;
      return;
    }
    offset = Number(value);
    rest.splice(offsetAt, 2);
  }
  let explicitLimit: number | undefined;
  const limitAt = rest.indexOf("--limit");
  if (limitAt >= 0) {
    const value = rest[limitAt + 1];
    if (
      !["search_deadlines", "search_venues", "recommend_venues", "list_upcoming"].includes(名) ||
      rest.lastIndexOf("--limit") !== limitAt ||
      !/^\d+$/.test(value ?? "") ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1
    ) {
      throw new Error("--limit は検索・推薦・直近一覧で1以上の整数を1つ指定してください。");
    }
    explicitLimit = Number(value);
    rest.splice(limitAt, 2);
  }
  let inputText: string | undefined;
  const inputAt = rest.indexOf("--input");
  if (inputAt >= 0) {
    const value = rest[inputAt + 1];
    if (
      !["search_venues", "recommend_venues"].includes(名) ||
      rest.lastIndexOf("--input") !== inputAt ||
      !value ||
      value.startsWith("--")
    )
      throw new Error("--input は投稿先検索・推薦でファイル名または - を1つ指定してください。");
    rest.splice(inputAt, 2);
    if (rest.length && !(explicitLimit === undefined && rest.length === 1 && /^\d+$/.test(rest[0])))
      throw new Error("--input と題名の直接入力は同時に指定できません。");
    let bytes: Buffer;
    try {
      bytes = readFileSync(value === "-" ? 0 : value);
    } catch (cause) {
      throw new Error(
        `入力${value === "-" ? "（標準入力）" : `ファイル「${value}」`}を読めません。`,
        { cause },
      );
    }
    if (
      bytes.subarray(0, 5).toString() === "%PDF-" ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4)
    )
      throw new Error(
        "--input はUTF-8のテキスト・JSON用です。PDFは画面の論文入力から読み込めます。Wordファイルはテキスト・JSONへ変換してください。",
      );
    try {
      inputText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new Error("入力はUTF-8のテキスト・JSONで保存してください。", { cause });
    }
    if (!inputText.trim()) throw new Error("入力に論文の題名または概要を指定してください。");
  }
  /* 人の道では、題名が空白で割れて渡つて來る。**末尾が数の時だけ**件数として扱ふ
   * （題名の語に数字が混ざる事がある – 全部を件数と読むと、題名が削られる）。 */
  const 尾が數 =
    explicitLimit === undefined &&
    rest.length > 1 &&
    /^\d+$/.test(String(rest[rest.length - 1] ?? ""));
  const args: Record<string, unknown> =
    名 === "search_deadlines" || 名 === "explain_word"
      ? { query: rest[0], word: rest[0], limit: cliNumber(rest[1]) }
      : 名 === "search_venues"
        ? {
            query: (尾が數 ? rest.slice(0, -1) : rest).join(" "),
            limit: 尾が數 ? cliNumber(rest[rest.length - 1]) : undefined,
          }
        : 名 === "recommend_venues"
          ? {
              paper: (尾が數 ? rest.slice(0, -1) : rest).join(" "),
              limit: 尾が數 ? cliNumber(rest[rest.length - 1]) : undefined,
            }
          : 名 === "list_upcoming"
            ? { days: cliNumber(rest[0]), kind: rest[1] }
            : (() => {
                /* 打たれた語が**そのまま key** にある時は key として扱ふ。名の一部として引くと、
                 * `sc` の様に 42 件の候補に割れてしまふ（実測 2026-10-12 – その語の会議を
                 * 一意に指しているのに、候補の一覽を返していた）。 */
                const 語 = String(rest[0] ?? "").trim();

                const 其の儘 =
                  Boolean(語) &&
                  (snapshot().conferences ?? []).some((c) => {
                    if (venueLookupText(c.key) === venueLookupText(語)) return true;
                    const 古い = (c as { legacy_keys?: unknown }).legacy_keys;
                    return (Array.isArray(古い) ? 古い : []).some(
                      (l: unknown) => venueLookupText(l) === venueLookupText(語),
                    );
                  });
                return 其の儘 ? { key: 語 } : { name: 語 };
              })();
  if (inputText !== undefined) {
    if (名 === "search_venues") args.query = inputText;
    else args.paper = inputText;
    args.limit = explicitLimit ?? (rest.length ? cliNumber(rest[0]) : undefined);
  } else if (explicitLimit !== undefined) args.limit = explicitLimit;
  if (offset !== undefined) args.offset = offset;
  if (retrieval !== undefined) args.retrieval = retrieval;
  let page: Record<string, unknown> | undefined;
  const result = await callTool(名, args, now, (value) => {
    page = value;
  });
  if (json) {
    /* 構造化を伴はない結果（空の検索語・論文が讀めない等の**案内**）でも、其の侭の案内を
     * 出す。汎用の断りにすり替へると、直し方の書いてある文が消える – 實測 2026-10-15:
     * `search "" --json` は「検索語が空です…（省せる引数の列挙）」を出さず、
     * 「構造化結果を取得できませんでした」だけを出して居た。 */
    if (!page) {
      process.stdout.write(`${result}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(page)}\n`);
    return;
  }
  const nextOffset = page?.next_offset;
  const text = result.replace(/次の結果: 同じ条件で offset: \d+ を指定してください。/g, "");
  process.stdout.write(`${text}\n`);
  if (typeof nextOffset === "number")
    process.stdout.write(`続きの取得: 同じ引数に --offset ${nextOffset} を指定してください。\n`);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

/* 直接起動された時だけ stdio を開く（import した検査では開かない）。 */
if (isDirectExecution()) {
  if (process.argv.length > 2)
    void main().catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  else runStdio();
}
