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
/* 畫面が最初に讀む窓（180 日）と、收錄の全體。**數字を畫面と一致させる**のが肝なので、
 * 先づ畫面と同じ窓（`public/catalog.json`）を見る。無ければ（まだ建てて居ない・配付物を
 * 持たない手元）收錄の全體（`data/snapshot.json`）へ落ちて、其の旨を言ふ。 */
const CATALOG_PATH = join(ROOT, "public", "catalog.json");
const DATA_PATH = join(ROOT, "data", "snapshot.json");
const SERVER_NAME = "kamiyobi";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PROTOCOL = "2025-06-18";

/* 行の形（`Recommender.candidateRows` が返す物の內、此處で使ふ分だけ）。 */
interface Row {
  conf: { key: string; title: string; acronym?: string; categories?: string[]; rank?: unknown };
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

function 讀む(path: string): Row[] {
  return Recommender.candidateRows(
    JSON.parse(readFileSync(path, "utf8")) as never,
  ) as unknown as Row[];
}

/** 畫面が最初に讀む窓（`public/catalog.json`）。無ければ null。 */
function screenRows(): Row[] | null {
  if (screenCache) return screenCache;
  try {
    screenCache = 讀む(CATALOG_PATH);
    return screenCache;
  } catch {
    return null;
  }
}

/** 收錄の全體（`data/snapshot.json`）。1 度だけ讀む（5,069 行・約 9MB）。 */
function allRows(): Row[] {
  if (!allCache) allCache = 讀む(DATA_PATH);
  return allCache;
}

/** 使ふ窓を決める（既定は畫面と同じ。`scope: "all"` で收錄の全體）。 */
function pick(scope: unknown): { list: Row[]; 名: string } {
  if (String(scope ?? "") === "all") return { list: allRows(), 名: "收錄の全體" };
  const 窓 = screenRows();
  return 窓 ? { list: 窓, 名: "畫面が最初に讀む窓" } : { list: allRows(), 名: "收錄の全體" };
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

/** 締切の瞬間を日本時間で書く（畫面の日時欄と同じ読み）。 */
function jst(ms: number): string {
  const parts = JST.formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const 秒 = new Date(ms).getUTCSeconds();
  const 分 = get("minute");
  return `${get("year")}-${get("month")}-${get("day")}(${get("weekday")}) ${get("hour")}:${分}${
    秒 ? `:${String(秒).padStart(2, "0")}` : ""
  } JST`;
}

/** 1 行を 1 行の文字にする（畫面の列と同じ順・同じ語）。 */
function line(r: Row, now: number): string {
  const 日 = r.dateOnly ? `${r.localDate}（時刻未確認）` : jst(r.t);
  const 殘り = Math.floor((r.t - now) / 86400000);
  const 殘り文 = r.dateOnly ? "" : ` 殘り${殘り < 0 ? "（過ぎた）" : `${殘り}日`}`;
  const 種別 = String(Recommender.kindLabelJa(r.kind) ?? r.kind);
  const 回 = (r.dl.round ?? 1) > 1 ? ` R${r.dl.round}` : "";
  const 場所 = String(Recommender.placeJa(r.ed.place) ?? "").trim() || "未確認";
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
  return `${日}${殘り文}${元} | ${種別}${回}${推定} | ${r.conf.title}（${r.ed.id}）| ${場所}${出典}`;
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
  args: { include_past?: unknown; kinds?: unknown; include_estimated?: unknown },
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
  return list
    .filter((r) => {
      if (!過去も && r.t < now) return false;
      if (!推定も && r.est) return false;
      if (全部) return true;
      if (種別 && 種別.length) return 種別.includes(r.kind);
      return 投稿の種別.includes(r.kind);
    })
    .concat(知らん.length ? [] : []);
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
    scope?: unknown;
  },
  now: number,
): string {
  const query = String(args.query ?? "").trim();
  if (!query) return "検索語が空です。会議名・分野・開催地・締切の語をください。";
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
  const { list, 名 } = pick(args.scope);
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(query, now), now);
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
  /* 日付は日本時間で出す。**元の表記が別の日の事が在る**ので、月で引いた時に表示の月がずれる
   * 行が在る（實測 2026-10-06: `9月` で引いた行が「2026-10-16(金) 20:59 JST」と出る – 元の
   * 表記は AoE で 9 月 30 日）。AI が其のまま「10 月」と答へん樣に、頭で斷つて置く。*/
  /* 日付の斷りは**日付を聞いた時だけ**書く（第 749 回 – 初めは每回書いて居たので、`KDD` の樣な
   * 語の檢索にも關係無い斷りが付いて居た。雜音は、要る所でだけ言ふ）。*/
  const 日付の語 =
    /(?:\d+月|\d+日|今月|来月|先月|今週|来週|先週|今年|来年|年内|年度|以内|までに|以降)/.test(
      query,
    );
  const 頭 = `検索語「${query}」に當たる締切: ${hit.length} 件（${名} ${list.length} 行・畫面の既定と同じ絞り込み。絞る前は ${素の.length} 行）${知らん.length ? `／知らない種別（其の侭では 0 件に成ります）: ${知らん.join("・")}` : ""}${日付の語 ? "\n日付は日本時間（JST）。月や日付の語は、締切の日付と「会期」の日付の両方に當たる（畫面のてびきと同じ約束）ので、月で引いた時に見出しの月と違ふ日が出る行が在る。" : ""}`;
  if (!hit.length) {
    /* 畫面と同じ約束 – 案内は「素の當たりが 0」の時に出る物なので、絞り込みで 0 に成つた時は
     * 其の旨を書く（絞り込みを外せば出る事がある）。 */
    const 案内 = 素の.length ? [] : guidance(query, 0);
    return [
      頭,
      "",
      素の.length
        ? "語は當たりますが、既定の絞り込み（今後の投稿締切・推定を除く）で 0 件に成りました。include_past / include_estimated / kinds を試してください。"
        : "この語では 1 行も出ません。",
      ...案内.map((n) => `案内: ${n}`),
      ...(() => {
        if (素の.length) return [];
        const 手 = retypeTips(query, 畫面の既定(list, now, args), now);
        return 手.length ? [`打ち直すなら ${手.join(" / ")}`] : [];
      })(),
    ].join("\n");
  }
  const 見本 = hit.slice(0, limit).map((r) => line(r, now));
  return [
    頭,
    `（日本時間の早い順。${limit} 件まで表示${hit.length > limit ? `・殘り ${hit.length - limit} 件` : ""}）`,
    "",
    ...見本,
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
  const { list, 名 } = pick(args.scope ?? "all");
  const 限り = now + days * 86400000;
  const hit = sortRows(
    list.filter(
      (r) => r.t >= now && r.t <= 限り && (!kind || r.kind === kind || r.dl.kind === kind),
    ),
  );
  return [
    `今日から ${days} 日以內の締切: ${hit.length} 件（${名}・日本時間の早い順）`,
    "",
    ...hit.slice(0, 100).map((r) => line(r, now)),
    ...(hit.length > 100 ? ["", `（100 件まで表示・殘り ${hit.length - 100} 件）`] : []),
  ].join("\n");
}

function venueInfo(args: { key?: unknown; name?: unknown; scope?: unknown }, now: number): string {
  const key = String(args.key ?? "").trim();
  const name = String(args.name ?? "").trim();
  if (!key && !name) return "key（會議の識別子）か name（會議名の一部）をください。";
  const { list, 名 } = pick(args.scope ?? "all");
  /* 會議は**略稱で打たれる**のが普通（實測 2026-10-06: `KDD` `CCS` `AsiaCCS` は此の matching では
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
    const 會 = [...new Set(list.map((r) => r.conf.key))];
    return `その會議は收録に在りません（收録 ${會.length} 會議）。會議名の一部で試すか、search_deadlines で引いてください。`;
  }
  /* 曖昧な打ち方（`KDD` は kdd・sigkdd・pakdd・ecmlpkdd に當たる）では**一つの會議に決め打たない**。
   * 決め打つと、別の會議の版を一つに混ぜて返す（實測 2026-10-06 にそう成つた – 第 726 回）。
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
      `「${key || name}」には ${會々.length} の會議が當たりました。名を細く打つか、key で指してください:`,
      ...名乗り
        .slice(0, 20)
        .map(([k, t]) => `- ${t}（key: ${k}）${繋ぎ先.get(k) ? ` ${繋ぎ先.get(k)}` : ""}`),
      ...(名乗り.length > 20 ? [`- ほか ${名乗り.length - 20} 件`] : []),
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
  /* 今後の締切が無い會議では、**其の事を先に言ふ**（第 754 回 – 過ぎた行だけを並べると、
   * 讀む人（と AI）が「次はこれ」と取り違へる）。 */
  const 今後 = hit.filter((r) => r.t >= now).length;
  const 斷り = 今後 ? "" : "※ この會議の今後の締切は収録にありません（下の行は過ぎた物です）。\n";
  return [
    斷り +
      `會議: ${一つ.conf.title}（key: ${一つ.conf.key}${一つ.conf.acronym ? `・${一つ.conf.acronym}` : ""}）`,
    `版: ${版.join(" / ")}`,
    /* 分野は畫面と同じ日本語で出す（第 726 回 – 機械向けのキー（`ai`）の侭では、人が讀む時に
     * 畫面のチップと結び付かん。同じ入口（`categoryLabelJa`）から取る – 書き寫すとずれる）。*/
    `分野: ${
      (一つ.conf.categories ?? [])
        .map((key) => String(Recommender.categoryLabelJa(key) ?? key))
        .join("・") || "未確認"
    }`,
    "",
    /* 並びは第 751 回から「今後の物が先」に變はつたので、其れを書く（前に書いて居た
     * 「日本時間の早い順」は、版を跨ぐと過去が先に來る意味に讀めてしまふ）。切り詰めも
     * **默らない**（第 765 回 – 60 件で切れて居る事を言はないと、AI が「これで全部」と答へる）。*/
    `締切と會期（今後の物から、同じ側では日本時間の早い順）${見本.length > 60 ? `・${見本.length} 件のうち 60 件` : ""}:`,
    ...見本.slice(0, 60),
  ].join("\n");
}

function explainWord(args: { word?: unknown; scope?: unknown }, now: number): string {
  const word = String(args.word ?? "").trim();
  if (!word) return "語をください。";
  const { list, 名 } = pick(args.scope);
  const 照合 = Recommender.searchMatcher(Recommender.expandRelativeMonths(word, now), now);
  const 件數 = list.filter((r) => 照合(r.hay) === true).length;
  if (件數 > 0) {
    return `「${word}」は ${件數} 行に當たります（${名}・案内は出ません）。search_deadlines で其の儘引けます。`;
  }
  const 案内 = guidance(word, 0);
  /* 打ち直しの見當も渡す（第 763 回 – `search_deadlines` と同じ扱ひに揃へる。語を調べる人が
   * 「では何と打てばよいか」まで一往復で分かる樣に）。件數は照合そのもので數へる（第 762 回）。 */
  const 手 = retypeTips(word, 畫面の既定(list, now, {}), now);
  return [
    `「${word}」は 0 行です。畫面が此の時に出す案内:`,
    ...(案内.length ? 案内.map((n) => `- ${n}`) : ["- （案内は無し＝表の語では無い語）"]),
    ...手.map((t) => `- 打ち直すなら ${t}`),
  ].join("\n");
}

/** 收錄その物の數（第 769 回）。「何件を覆つて居るか」「どの檔案が在るか」を一往復で答へる –
 * AI が「この收錄は何か」を説明する時、人に檔案を渡す時に要る。**數字は llms.txt と同じ物**を
 * 同じ入口（`data/snapshot.json`）から數へる。`scope` は取らない（收錄の全體を數へるのが役目）。 */
function collectionStats(now: number): string {
  const list = allRows();
  /* 會議と版は**收錄その物**から數へる（行から數へると「締切を持つ物」だけに成り、建てた時の
   * 「696 會議 / 2,603 版」と食ひ違ふ – 第 769 回に一度其れを踏んだ）。行は締切の數へに使ふ。*/
  const 收錄 = JSON.parse(readFileSync(DATA_PATH, "utf8")) as {
    conferences?: Array<{ editions?: unknown[] }>;
  };
  const 會議 = (收錄.conferences ?? []).length;
  const 版 = (收錄.conferences ?? []).reduce(
    (n, c) => n + (Array.isArray(c.editions) ? c.editions.length : 0),
    0,
  );
  const 今後 = list.filter((r) => r.t >= now).length;
  const 日 = list.map((r) => r.localDate || new Date(r.t).toISOString().slice(0, 10)).sort();
  const 檔案 = [
    "index.html（畫面。絞り込みと検索）",
    "upcoming.md / upcoming.html（直近 180 日の表）",
    "data.csv（1 行 1 締切の平坦な表）",
    "deadlines.ics（カレンダー。1 日 1 件の終日）",
    "data.json（収録の全体。機械可読の正）",
    "llms.txt（機械向けの索引。何が何處に在るか）",
  ];
  return [
    `收錄（${DATA_PATH.replace(`${ROOT}/`, "")}）: 會議 ${會議} 件 / 版 ${版} 件（生の收錄。建てる時は同じ物を束ねるので、建てた表示とは少し違い得る）/ 締切の行 ${list.length} 行（日付の幅 ${日[0]} 〜 ${日[日.length - 1]}）`,
    `うち今後の締切: ${今後} 行（${new Date(now).toISOString().slice(0, 10)} 以降）`,
    "",
    "配付して居る檔案（サイトと同じ場所に在る）:",
    ...檔案.map((f) => `- ${f}`),
  ].join("\n");
}

const TOOLS = [
  {
    name: "search_deadlines",
    description:
      "kamiyobi の収録（国際会議・国內研究会の締切と会期）を日本語で引く。会議名・分野・開催地・締切の語・相対日付（『今月』『30日以内』『來週』など）が使へる。**0 件の時は、畫面と同じ案内（其の語が表に無い事）と、同じ「打ち直すなら」の次の一手を返す** – 其の一手の件數は、實際に引いた時に出る行數と一致する（その侭打ち直せる）。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "検索語（日本語。例: セキュリティ / 今月 / 海外開催）",
        },
        limit: { type: "number", description: "返す行數（既定 20・最大 100）" },
        include_past: {
          type: "boolean",
          description: "過ぎた締切も含める（既定 false＝畫面の既定と同じ）",
        },
        include_estimated: { type: "boolean", description: "推定の締切も含める（既定 false）" },
        kinds: {
          type: "array",
          items: { type: "string" },
          description: "種別のキーで絞る（既定は畫面と同じ abstract / paper / journal）",
        },
        scope: {
          type: "string",
          enum: ["screen", "all"],
          description:
            "見る窓。screen＝畫面が最初に讀む窓（180 日。catalog.json が在る時だけ）／all＝収録の全體（過去と先の締切も含む）",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_upcoming",
    description:
      "今日から N 日以內の締切を日本時間の早い順に返す（**種別では絞らない** – 登録・カメラレディ・採否通知も混ざる。投稿の締切だけ見るなら search_deadlines を使ふ）。100 件を超える時は其の旨と殘り件数を末尾に書く。",
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
      "1 つの会議の版・分野・締切・会期を返す。**key（識別子）・name（名前の一部）・略稱の何れでも引ける**。締切は**今後の物から**並ぶ（同じ側では日の早い順）。今後の締切が無い会議では其の旨を先に言ふ。名乘りが割れた時は候補（名・key・公式 URL）を並べて決め打たない。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "會議の識別子（例: kdd）" },
        name: { type: "string", description: "會議名の一部（例: KDD）" },
        scope: { type: "string", enum: ["screen", "all"], description: "見る窓（既定 all）" },
      },
    },
  },
  {
    name: "collection_stats",
    description:
      "この収録その物の規模（会議數・版數・締切の行數・日付の幅・今後の件數）と、配付して居る檔案の一覽を返す。「この収録は何か」「何件あるか」「人に渡すなら何を渡せばよいか」に答へる時に使ふ。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "explain_word",
    description:
      "1 つの語が収録に何行当たるかと、0 行の時に畫面が出す案内文を其の儘返す（人が見る說明と AI の說明を同じにする）。**0 行の時は「打ち直すなら」の次の一手も返す**（件數は實際に引いた時の行數と一致）。",
    inputSchema: {
      type: "object",
      properties: {
        word: { type: "string", description: "調べる語（例: 學生でも投稿できる）" },
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
    return; // 讀めない行は默つて捨てる（MCP の決まり – 返事の形が作れない）
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
        "  AI から: MCP の客户として此の檔案を起動する（`node src/mcp.ts`）。",
        "  人から: 道具の名を引數に書くと 1 回だけ走らせて文字を出す。",
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
  };
  const 名 = 別名[tool] ?? tool;
  const args: Record<string, unknown> =
    名 === "search_deadlines" || 名 === "explain_word"
      ? { query: rest[0], word: rest[0], limit: rest[1] }
      : 名 === "list_upcoming"
        ? { days: rest[0], kind: rest[1] }
        : { name: rest[0] };
  process.stdout.write(`${callTool(名, args, now)}\n`);
}

/* 直接起動された時だけ stdio を開く（import した檢査では開かない）。 */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 2) main();
  else runStdio();
}
