/**
 * カレンダー（RFC 5545）の組み立て（第 856 回）。
 *
 * **ビルドと画面の両方から使う** – 配付する `deadlines.ics`（収録の全部）と、画面の
 * 「この一覧の N 件をカレンダー（.ics）で」が書き出す 1 本（いまの絞り込み）は、同じ器と
 * 同じ折り方でなければならない。別々に書くと、片方だけ直したときにずれる
 * （第 803 回の「同じ入口から取る」と同じ理由）。
 *
 * ここは **Node に依らない** – `Buffer` を使わず `TextEncoder` でオクテット数を数える
 * （画面でも同じ関数をそのまま動かすため）。
 */

import Recommender from "./recommender.ts";

/** カレンダーアプリの棚に出る名前（`X-WR-CALNAME`）。 */
export const ICS_CAL_NAME_JA = "kamiyobi 締切一覧";

/** 1 行の上限（RFC 5545 §3.1 は 75 オクテット）。 */
const ICS_MAX_LINE_OCTETS = 75;

/** UTF-8 のオクテット長（`Buffer.byteLength` の代はり – 画面でも動く）。 */
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** RFC 5545 の TEXT 値で意味を持つ文字（バックスラッシュ・セミコロン・カンマ・改行）。 */
export function icsEscapeText(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * 1 行を 75 オクテット以内へ畳む（RFC 5545 §3.1 – 第 266 回）。
 * **文字数ではなくオクテット数**で見る。日本語の 1 文字は UTF-8 で 3 オクテットあるので、
 * 文字数で切ると相手のカレンダー側で文字化けする。続け字（surrogate pair など）の
 * 途中でも切らない – 1 文字単位で数える。
 *
 * **2 文字の転義（`\n`・`\,`・`\;`・`\\`）をまたいでも切らない**（§3.1 が禁じている）。
 * 以前は切れ目でバックスラッシュが前の行に残り、続きの行が `n…` で始まっていた
 * （2026-09-24 実測: 配信した `deadlines.ics` に 30 箇所）。開いてから解く受け手では
 * 元に戻るが、行ごとに扱う受け手では転義が解けず `\` がそのまま画面に出る。
 * 切れ目が転義の先頭になったときは **バックスラッシュを続きの行へ送る**
 * （前の行を短くする形で、75 オクテットの上限は保つ）。
 */
export function icsFoldLine(line: string): string {
  const value = String(line ?? "");
  if (utf8Length(value) <= ICS_MAX_LINE_OCTETS) return value;
  const chars = [...value];
  const sizes = chars.map((ch) => utf8Length(ch));
  const out: string[] = [];
  let start = 0;
  while (start < chars.length) {
    // 2 行目以降は、折り返しの半角スペース 1 オクテットを込めて数える（相手はそれを戻す）。
    let end = start;
    let used = start === 0 ? 0 : 1;
    while (end < chars.length && used + sizes[end] <= ICS_MAX_LINE_OCTETS) {
      used += sizes[end];
      end += 1;
    }
    // 転義の先頭で切らない（ただし 1 文字は必ず残す – さもないと前に進まない）。
    if (end > start + 1 && chars[end - 1] === "\\") end -= 1;
    out.push((start === 0 ? "" : " ") + chars.slice(start, end).join(""));
    start = end;
  }
  return out.join("\r\n");
}

/** JST の暦日（`YYYYMMDD`）と、人が読む形（`YYYY-MM-DD HH:MM`）をまとめて返す。 */
export function jstParts(at: Date | null | undefined): { day: string; human: string } | null {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;
  const iso = new Date(at.getTime() + 9 * 3_600_000).toISOString();
  return {
    day: iso.slice(0, 10).replace(/-/g, ""),
    human: `${iso.slice(0, 10)} ${iso.slice(11, 16)}`,
  };
}

/** JST の暦日を 1 日後ろへ（終日イベントの `DTEND` は「その日の終わり」ではないため）。 */
export function icsNextDay(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return day;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10).replace(/-/g, "");
}

/** `YYYYMMDD` を人が読む形に直す（カレンダーの申告文と画面の注記で同じ形を使う）。 */
export function icsDayIso(day: string): string {
  return /^\d{8}$/.test(day) ? `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}` : "";
}

/** UID に載せる語を作る（同じ締切が再購読で重複しないよう、ビルドをまたいで同じ値にする）。 */
export function icsUidSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

/** カレンダーに載せる分野（第 292 回）。語は画面の分野列と同じ入口から取り、書き写しでズレない。
 * 未知の語は画面と同じく原文のまま – 画面に無い語をカレンダーだけ作らない。 */
export function icsCategoryLabels(categories: readonly string[] | null | undefined): string[] {
  const raw = categories;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  raw.forEach((key) => {
    const label = String(Recommender.categoryLabelJa(key) ?? "").trim();
    if (label && out.indexOf(label) < 0) out.push(label);
  });
  return out;
}

/* `CATEGORIES` は値の区切りにカンマを使うので、`icsEscapeText`（カンマを \, に逃がす）を
 * そのまま使えない。値の中のセミコロンとバックスラッシュだけ逃がし、区切りは残す。 */
export function icsCategoryList(labels: string[]): string {
  return labels
    .map((label) => label.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,"))
    .join(",");
}

/** 配信する 1 件（`VEVENT` の行と、申告に使う日・締切かどうか）。 */
export type IcsRow = {
  day: string;
  at: number;
  body: string[];
  /** 日付の欄が「締切」の行か（第 300 回）。採否通知などは False で、申告の内訳に使う。 */
  deadline: boolean;
  /** 計畫の計畫（第 1082 囮）。同じ計畫の計畫が 2 つ在る時、消費者は見分けられない。 */
  kindNote?: string;
};

export type IcsCalendarMeta = {
  event_count: number;
  /** 配信行の内、日付の欄が「締切」の物（第 300 回）。採否通知などは数えない。 */
  deadline_count: number;
  first_day: string;
  last_day: string;
};

/** `DTSTAMP` の形（`YYYYMMDDTHHMMSSZ`）。 */
function icsStampUtc(at: Date): string {
  return at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** 1 件の `VEVENT` を組む。**器の形は此処だけに置く** – ビルドも画面も此れを呼ぶ。 */
export function icsEventBody(
  input: {
    uid: string;
    day: string;
    summary: string;
    description: string;
    link?: unknown;
    categories?: string[] | null;
    location?: unknown;
  },
  now: Date | null | undefined,
): string[] {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const link = String(input.link ?? "").trim();
  const location = String(input.location ?? "").trim();
  const catsJa = input.categories ?? [];
  return [
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `DTSTAMP:${icsStampUtc(safeNow)}`,
    `DTSTART;VALUE=DATE:${input.day}`,
    `DTEND;VALUE=DATE:${icsNextDay(input.day)}`,
    `SUMMARY:${icsEscapeText(input.summary)}`,
    `DESCRIPTION:${icsEscapeText(input.description)}`,
    link ? `URL:${link}` : "",
    // 並び替えは上の `SUMMARY`（本文の 6 行目）を見るので、挿れるのはうしろ側。
    catsJa.length ? `CATEGORIES:${icsCategoryList(catsJa)}` : "",
    location ? `LOCATION:${icsEscapeText(location)}` : "",
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ].filter(Boolean);
}

/* 購読先に申告する事実。行から導く – 別々に数えると、申告と中身がズレる
 * （「928 件」と書いて 927 件しか入っていない、が一番信用を失う）。 */
export function icsCalendarMeta(rows: IcsRow[] | null | undefined): IcsCalendarMeta {
  const safe = rows ?? [];
  const days = safe
    .map((r) => r.day)
    .filter((d) => /^\d{8}$/.test(d))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    event_count: safe.length,
    /* 中身の内訳を、書き出した行から数える（第 300 回）。第 299 回まで配信物は締切では無い日
       （採否通知・査読結果公開・反論期間の開始）も含むのに、画面も索引も「締切 N 件」と言って
       いた。欄名が「締切」の行だけを締切として数える – 数え方を 2 か所に持たない。 */
    deadline_count: safe.filter((r) => r.deadline).length,
    first_day: days.length ? icsDayIso(days[0]) : "",
    last_day: days.length ? icsDayIso(days[days.length - 1]) : "",
  };
}

/* カレンダーアプリの説明欄に出る文（収録の全部を配る時の既定）。ここだけは相手側が
 * 翻訳しないので日本語で書く。
 *
 * 以前は決まった文章の先頭を半角スペースで始めていた（`" kamiyobi が…"`）。RFC 5545 §3.1 は
 * 名前とコロンとの間に空白を置かないと定めており、相手はそれを値の一部に残す – カレンダーの
 * 情報欄が「 kamiyobi …」と頭が空いて出ていた（2026-09-24 実測）。
 * 「画面上の全件」とも書いていたが、カレンダー側に「上」は無い – 収録の**件数と期間**を
 * 実測の値で書く（2026-08-09 生成ビルドで 928 件・2026-08-09 〜 2028-03-30。画面の表示窓は
 * 生成から 180 日なので、同じ物を想像して取り込む人とズレる）。 */
export function icsCalendarDescriptionJa(
  meta: IcsCalendarMeta,
  stamp: { human: string } | null,
): string {
  const span =
    meta.event_count > 0
      ? `いま ${meta.event_count} 件（${meta.first_day} 〜 ${meta.last_day}）`
      : "いま 0 件";
  /* 内訳（第 300 回）。第 299 回まで、この説明は入る物を「締切」と呼んでいたが、実測で
     928 件のうち 167 件は採否通知・査読結果公開・反論期間の開始だった。カレンダーアプリは
     この文をカレンダーの情報欄に出すので、購読する人が最初に読む話になる。 */
  const mix =
    meta.deadline_count > 0 && meta.deadline_count < meta.event_count
      ? `うち締切は ${meta.deadline_count} 件で、残りは採否通知・査読結果公開・反論期間の開始の` +
        "ように、その日までに何かを出す必要の無い日（本文の日付の欄も「通知日」などになる）。"
      : "";
  return [
    "kamiyobi が収録した会議の日付。1 件 = 1 つの日で、その日（JST の暦日）を埋める形で出る。",
    `入るのは収録している今後の日付すべてで、${span}。${mix}画面の絞り込みと並び替えは引き継がれない。`,
    "収録の期間は画面の表示窓より長い（画面は指定した期間だけを出し、こちらには出ている締切が",
    "全て入る）。時刻が公式に出ていない締切は「時刻未確認」と書き、上流が推定としている日付には",
    "「推定」と付ける。過ぎた日は入れない。会議が開かれている日（会期）その物を並べる予定は" +
      "立てません – 終日が並ぶと締切が見えなくなるためで、会期は各予定の本文に書きます。",
    stamp ? `データ生成: ${stamp.human}（JST）。` : "",
  ]
    .filter(Boolean)
    .join("");
}

/** 一覧の行に付く**札**（延長・確認の状態）。語は畫面と同じ正本から取る。無ければ空の配列。
 *
 * **カレンダー（配付物と畫面の書き出し）と、`upcoming.md` の状態の列が同じ物を使ふ** –
 * 書き寫すと、出口ごとに言ひ方がずれる。
 *
 * 畫面だけが知つて居る事にしない – 購読した人はカレンダーしか見ないので、上流に候補が複数
 * ある締切（「複数候補のため要確認」）が、其の侭では確定の締切として予定表に並ぶ。**確認済みと
 * 未設定では何も返さない**（畫面も印を出さない – 默るのが正しい）。 */
export function statusMarksJa(dl: unknown): string[] {
  return [
    Recommender.isExtendedDeadline(dl) ? String(Recommender.extendedLabelJa() ?? "").trim() : "",
    String(
      Recommender.verificationStatusLabelJa(
        (dl as { verification?: unknown } | null | undefined)?.verification,
      ) ?? "",
    ).trim(),
  ].filter(Boolean);
}

/** カレンダー 1 本の文字（RFC 5545）。`description` を渡すと説明欄の文を差し替える。 */
export function icsCalendarText(
  rows: IcsRow[] | null | undefined,
  now: Date | null | undefined,
  options?: { calName?: string; description?: string },
): string {
  const safe = rows ?? [];
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const stamp = jstParts(safeNow);
  const calName = options?.calName ?? ICS_CAL_NAME_JA;
  const description =
    options?.description ?? icsCalendarDescriptionJa(icsCalendarMeta(safe), stamp);
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//kamiyobi//deadlines//JA",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscapeText(calName)}`,
    `X-WR-CALDESC:${icsEscapeText(description)}`,
    "X-WR-TIMEZONE:Asia/Tokyo",
    "X-PUBLISHED-TTL:P1D",
    "REFRESH-INTERVAL;VALUE=DURATION:P1D",
    ...safe.flatMap((r) => r.body),
    "END:VCALENDAR",
    "",
  ]
    .map(icsFoldLine)
    .join("\r\n");
}

/* ------------------------------------------------------------------ 画面の一覧を書き出す */

/** 書き出す 1 本の見出し（カレンダーアプリの棚に出る名前）。配付物と取り違えないよう、
 * 「画面で絞り込んだ写し」である事を名前に入れる。 */
export const ICS_VIEW_CAL_NAME_JA = "kamiyobi 締切一覧（この一覧の写し）";

/** 画面の 1 行を、カレンダーの 1 件に組むための材料。**画面の表示と同じ値**を渡す
 * （会議名は年を添えた形、種別・日付欄・会期・開催地は画面と同じ入口から取った物）。 */
export interface ScreenDeadlineInput {
  /** 会議の識別子（UID の種。版の識別子が無いときの代はり）。 */
  key: string;
  /** 版の識別子（UID の種）。 */
  editionId: string;
  /** 年（会議名に添へる）。 */
  year?: number | null;
  /** 会議名（年を添へる前）。 */
  title: string;
  /** 種別の鍵（UID に入れる。ASCII の `paper` など）。 */
  kind: string;
  /** 種別の日本語（画面と同じ語）。 */
  kindWord: string;
  /** 計畫の計畫（第 1082 囮）。同じ計畫の計畫が 2 つ在る時、消費者は見分けられない。 */
  kindNote?: string;
  /** 日付の欄の名前（「締切」「通知日」など。画面と同じ入口から取った物）。 */
  dateField: string;
  /** JST の暦日（`YYYYMMDD`）。 */
  day: string;
  /** 日付の表示（`2026-10-11（時刻未確認）` の形）。 */
  whenText: string;
  /** 並び順の瞬間（ms）。 */
  at: number;
  estimated?: boolean;
  categories?: readonly string[] | null;
  place?: unknown;
  link?: unknown;
  /** 会期の表示（画面と同じ式で組んだ物）。 */
  session?: unknown;
  /** 締切の記録その物（確認の状態と延長の判定に使う。畫面が持つ `dl` をそのまま渡す）。 */
  dl?: unknown;
}

/** 画面の行から、カレンダーの行を組む。**見えている物だけ**を入れる（過ぎた締切を表示して
 * いればそれも入る – 画面と食い違わせない）。UID の組み方は配付物と同じにしてある
 * （同じ締切は同じ物として扱はれ、購読と併用しても二重に並ばない）。 */
export function icsRowsFromScreen(
  items: readonly ScreenDeadlineInput[] | null | undefined,
  now: Date | null | undefined,
): IcsRow[] {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const rows: IcsRow[] = [];
  const used = new Map<string, number>();
  for (const item of items ?? []) {
    const day = String(item.day ?? "")
      .replace(/-/g, "")
      .slice(0, 8);
    if (!/^\d{8}$/.test(day)) continue;
    const title = String(item.title ?? "").trim();
    const kindWord = String(item.kindWord ?? "").trim() || "締切";
    /* 計畫の計畫を足す（第 1082 囮）– CLOSER の 2 つは別の募集なのに摘要が同じだつた。 */
    const kindNote = String(item.kindNote ?? "").trim();
    const kindShown = kindNote ? `${kindWord}（${kindNote}）` : kindWord;
    const summary = item.estimated ? `${title}：${kindShown}（推定）` : `${title}：${kindShown}`;
    const catsJa = icsCategoryLabels(item.categories ?? null);
    const placeJa = String(
      Recommender.placeJa(Recommender.placeWithPrefectureJa(item.place)) ?? "",
    ).trim();
    const link = String(item.link ?? "").trim();
    const desc = [
      `会議: ${title}`,
      /* **本文も計畫の計畫を出す**（第 1096 囮 – 實測 2026-11-19: 摘要は第 1082 囮で
       * `kindShown` に直したが、此方（本文）は `kindWord` のままだつた。同じ會議の
       * 計畫の計畫が摘要にしか出ず、**カレンダーの情報欄を讀む人には見えなかった** –
       * 「摘要と本文が食ひ違ふ」状態。摘要と同じ `kindShown` を使ふ。 */
      `種別: ${kindShown}`,
      catsJa.length ? `分野: ${catsJa.join("・")}` : "",
      `${String(item.dateField ?? "").trim() || "日付"}: ${String(item.whenText ?? "")}`,
      `会期: ${String(item.session ?? "").trim() || Recommender.unconfirmedLabelJa()}`,
      ...(() => {
        const 札 = statusMarksJa(item.dl);
        return 札.length ? [`状態: ${札.join("・")}`] : [];
      })(),
      `開催地: ${placeJa || Recommender.unconfirmedLabelJa()}`,
      item.estimated ? "この日付は上流が推定として出したもので、公式で裏を取れていません" : "",
      link ? `詳細: ${link}` : "",
      `収録: ${ICS_VIEW_CAL_NAME_JA}（データ生成: ${stampHumanJa(safeNow)}）`,
    ].filter(Boolean);
    const base = [
      "kamiyobi",
      icsUidSafe(item.editionId || `${item.key ?? "conf"}-${item.year ?? ""}`),
      icsUidSafe(item.kind),
    ]
      .filter(Boolean)
      .join("-");
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    rows.push({
      day,
      at: Number(item.at) || 0,
      deadline: String(item.dateField ?? "").trim() === "締切",
      body: icsEventBody(
        {
          uid: `${base}${n === 0 ? "" : `-${n + 1}`}@kamiyobi`,
          day,
          summary,
          description: desc.join("\n"),
          link,
          categories: catsJa,
          location: placeJa,
        },
        safeNow,
      ),
    });
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

/** 「データ生成: …（JST）」の値。渡された瞬間を JST で書く（読めなければ「未確認」）。 */
function stampHumanJa(at: Date): string {
  const parts = jstParts(at);
  return parts ? `${parts.human}（JST）` : "未確認";
}

/** 書き出した 1 本の説明欄（配付物の説明と違い、**画面の写し**である事を言う）。
 * `scopeJa` は何の写しか（既定は「絞り込んだ」。推薦の候補を書き出す時は其方を渡す）。 */
export function icsViewDescriptionJa(
  rows: IcsRow[],
  generatedAt: Date | null | undefined,
  scopeJa = "絞り込んだ",
): string {
  const days = rows
    .map((r) => r.day)
    .filter((d) => /^\d{8}$/.test(d))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const span = days.length ? `${icsDayIso(days[0])} 〜 ${icsDayIso(days[days.length - 1])}` : "";
  return [
    `kamiyobi の画面で${scopeJa} ${rows.length} 件をそのまま入れたもの${span ? `（${span}）` : ""}。`,
    "1 件 = 1 つの日で、その日（JST の暦日）を埋める形で出る。",
    "これは購読ではなく、いまの一覧の写しです – 一覧が変わったら、もう一度この画面から",
    "書き出してください。収録の全部を購読するなら、同じ場所にある deadlines.ics を",
    "カレンダーアプリの購読先に指定します（毎日入れ替わります）。",
    generatedAt && !Number.isNaN(generatedAt.getTime())
      ? `データ生成: ${stampHumanJa(generatedAt)}。`
      : "",
  ]
    .filter(Boolean)
    .join("");
}

/** 画面の一覧 1 本ぶんの文字（RFC 5545）。 */
export function icsViewText(
  items: readonly ScreenDeadlineInput[] | null | undefined,
  now: Date | null | undefined,
  generatedAt?: Date | null,
  options?: { scopeJa?: string },
): string {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const rows = icsRowsFromScreen(items, safeNow);
  return icsCalendarText(rows, safeNow, {
    calName: ICS_VIEW_CAL_NAME_JA,
    description: icsViewDescriptionJa(rows, generatedAt ?? null, options?.scopeJa),
  });
}
