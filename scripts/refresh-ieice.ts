/**
 * 電子情報通信学会 研究会発表申込システム (ken.ieice.org) の開催スケジュール表から
 * data/manual.yaml の国内研究会の会期と発表申込締切を更新する保守スクリプト。
 *
 *   node scripts/refresh-ieice.ts                      # 差分を表示するだけ (dry-run)
 *   node scripts/refresh-ieice.ts --apply              # data/manual.yaml へ書き込む
 *   node scripts/refresh-ieice.ts --cache-dir /tmp/c   # 取得済み HTML から読む（オフライン）
 *   node scripts/refresh-ieice.ts --only NS,IN --interval 15000
 *
 * 公式ページの項目は「発表申込締切日」で**日付しか書かれていない**。したがって締切は
 * `precision: date-only` で収録し、時刻 (23:59 など) を補完しない (AGENTS.md の
 * 「締切の推測はしない」)。会期のみの回（締切未公開・[未定]）は会期だけを追記する。
 *
 * ケンマージ対象は data/manual.yaml に既出の IEICE 研究会だけ。未収録の研究会は
 * 報告して、収録は人が `conferences:` にブロックを追加する（収録意思の表明は人の判断）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface ScheduleRow {
  event_start: string;
  event_end: string;
  date_text: string;
  place: string;
  /** 公式が「発表申込締切日」に示した暦日。未定などは null（推測しない）。 */
  deadline: string | null;
  /** 検証用に、締切セルの原文を残す（[未定] 区別など）。 */
  deadline_text: string;
}

const WEEKDAY_RE = /\((?:月|火|水|木|金|土|日)\)/g;

/** 全角英数・全角記号を半角に畳み空白正規化する（スケジュール表は全角混在）。 */
export function foldWidths(text: string): string {
  const folded = [...String(text)].reduce((acc: string[], ch) => {
    const code = ch.codePointAt(0) ?? 0;
    acc.push(code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch);
    return acc;
  }, []);
  return folded.join("").replace(/\s+/g, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_s, digits: string) => String.fromCodePoint(Number(digits)));
}

/** 1 行の HTML からセルの文章を取り出す（タグ・全角空白・曜日を落とす）。 */
export function rowCells(rowHtml: string): string[] {
  return [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
    foldWidths(decodeEntities(m[1].replace(/<[^>]+>/g, " ")))
      .replace(WEEKDAY_RE, "")
      .trim(),
  );
}

/**
 * 開催地セルを「会場（都道府県）／オンライン」の形に寄せる。
 * 表は `ハイブリッド開催` の注記や `(オンライン開催, 大阪府)` のような形式を持つが、
 * 会場名そのものは壊さない。
 */
export function placeFromCell(raw: string): string {
  // 表は全角の「＋」「（）」が混在するため、単独で呼ばれたときにも畳む。
  let text = foldWidths(String(raw ?? ""));
  // 会場の後ろに付くだけの「(オンライン開催)」は、取り除く前にオンライン判定へ使う。
  let online = /\(オンライン開催\)/.test(text);
  text = text
    .replace(/\s*\(ハイブリッド開催[^)]*\)?/g, "")
    .replace(/\s*\(オンライン開催\)/g, "")
    .trim();
  const hybrid = /^(.*?)\s*\+\s*オンライン開催\s*\(([^)]*)\)$/.exec(text);
  if (hybrid) {
    text = hybrid[1].trim();
    online = true;
    const region = hybrid[2]
      .split(",")
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("オンライン"));
    if (region) text = `${text}（${region}）`;
  } else {
    const paren = /^(.*?)\s*\(([^)]*)\)$/.exec(text);
    if (paren) {
      const inner = paren[2]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      online = inner.some((part) => part.startsWith("オンライン"));
      const region = inner.find((part) => !part.startsWith("オンライン"));
      text = region ? `${paren[1].trim()}（${region}）` : paren[1].trim();
    }
  }
  if (online && text && !text.includes("オンライン")) text = `${text}／オンライン`;
  if (online && !text) text = "オンライン";
  return text || "未定";
}

const JP_DATE_HEAD = /^(?<y>20\d\d)年(?<m>\d{1,2})月(?<d>\d{1,2})日/;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** スケジュール表を解釈する。会期・開催地・発表申込締切日を返す（行のない表は空配列）。 */
export function parseSchedule(html: string): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  for (const match of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = rowCells(match[1]);
    if (cells.length < 6) continue;
    const head = JP_DATE_HEAD.exec(cells[0]);
    if (!head?.groups) continue;
    const y = Number(head.groups.y);
    const mo = Number(head.groups.m);
    const d = Number(head.groups.d);
    const eventStart = `${y}-${pad2(mo)}-${pad2(d)}`;
    let eventEnd = eventStart;
    let dateText = `${y}年${mo}月${d}日`;
    const tail = cells[0].slice(head[0].length);
    const endMatch = /(?:(20\d\d)年)?(\d{1,2})月(\d{1,2})日/.exec(tail);
    if (endMatch) {
      const em = Number(endMatch[2]);
      const ed = Number(endMatch[3]);
      const ey = endMatch[1] ? Number(endMatch[1]) : em < mo ? y + 1 : y;
      eventEnd = `${ey}-${pad2(em)}-${pad2(ed)}`;
      dateText = `${dateText}-${ey === y && em === mo ? "" : `${em}月`}${ed}日`;
    }
    const deadlineCell = cells[4];
    const deadlineMatch = /(\d{1,2})月(\d{1,2})日/.exec(deadlineCell);
    let deadline: string | null = null;
    if (deadlineMatch) {
      const dm = Number(deadlineMatch[1]);
      const dd = Number(deadlineMatch[2]);
      // 締切は会期より前に来る。日付だけの表で月が会期より後ろなら前年の表記。
      const dy = dm > mo ? y - 1 : y;
      deadline = `${dy}-${pad2(dm)}-${pad2(dd)}`;
    }
    rows.push({
      event_start: eventStart,
      event_end: eventEnd,
      date_text: dateText,
      place: placeFromCell(cells[1]),
      deadline,
      deadline_text: deadlineCell,
    });
  }
  return rows;
}

// --- data/manual.yaml への反映 -------------------------------------------------

export interface PlanEntry {
  key: string;
  deadlinesFilled: string[];
  editionsAdded: string[];
}

export interface PlanResult {
  text: string;
  entries: PlanEntry[];
  /** 手動収録が必要な研究会（manual.yaml にまだ無い）。 */
  unregistered: string[];
}

/* 締切の項目は `- date:` の後の本文インデント（12 語）に揃える。
 * `data/manual.yaml` の既存の書き方と同じ形にしないと YAML として壊れる。 */
const DEADLINE_ITEM_INDENT = "          ";
const DEADLINE_KEY_INDENT = "            ";
const EDITION_FIELD_INDENT = "        ";
const EDITION_ITEM_INDENT = "      ";
/* 会議自身の field（key / full_name）は 4 語インデント。版の field と混同すると
 * 範囲検索が空振りして、収録済みの研究会を「未収録」と誤判定する。 */
const CONFERENCE_FIELD_INDENT = "    ";

function deadlineLines(iso: string): string[] {
  return [
    `${DEADLINE_ITEM_INDENT}- date: '${iso}'`,
    `${DEADLINE_KEY_INDENT}kind: abstract`,
    `${DEADLINE_KEY_INDENT}label: 発表申込締切`,
    `${DEADLINE_KEY_INDENT}precision: date-only`,
  ];
}

/**
 * 指定した版の空の `deadlines: []` を締切 1 件で埋める。
 * 版をまたいだ検索はしない（`deadlines: []` を前方検索すると、前の版に締切を
 * くっつけて別会議の締切として公開してしまう。2026-09-22 の dry-run で実検）。
 * 既存の締切を持つ版は返さない（人手で確定済みの値を壊さない）。
 */
function fillDeadline(block: string, editionId: string, iso: string): string | null {
  const lines = block.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${EDITION_ITEM_INDENT}- `)) starts.push(i);
  }
  const idLine = `${EDITION_FIELD_INDENT}id: ${editionId}`;
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
    let hasId = false;
    let emptyAt = -1;
    let alreadyFilled = false;
    for (let i = from; i < to; i++) {
      const line = lines[i].trimEnd();
      if (line === idLine) hasId = true;
      else if (line === `${EDITION_FIELD_INDENT}deadlines:`) alreadyFilled = true;
      else if (line === `${EDITION_FIELD_INDENT}deadlines: []`) emptyAt = i;
    }
    // 別の版が締切を持っていても対象版には影響しない（対象の中でだけ判断する）。
    if (!hasId || alreadyFilled || emptyAt < 0) continue;
    const replaced = [
      ...lines.slice(0, emptyAt),
      `${EDITION_FIELD_INDENT}deadlines:`,
      ...deadlineLines(iso),
      ...lines.slice(emptyAt + 1),
    ];
    return replaced.join("\n");
  }
  return null;
}

/** 版 id の接頭語。既存の版 id（ipsj-hpc-2026-09 など）から日付より前を取り出す。 */
export function editionIdPrefix(block: string, key: string): string {
  const ids = [...block.matchAll(/^\s+id: (\S+?)-\d{4}-\d{2}(?:[-\w]*)$/gm)].map((m) => m[1]);
  // 会議キーと違う接頭語で統一されている研究会（ipsj-sighpc → ipsj-hpc）に合わせる。
  for (const id of ids.reverse()) if (id !== key) return id;
  return key;
}

function editionLines(
  ed: ScheduleRow,
  key: string,
  today: string,
  idPrefix = editionIdPrefix("", key),
): string[] {
  const out = [`${EDITION_ITEM_INDENT}- date_text: ${ed.date_text}`];
  // 過ぎた締切を「これから来る締切」として収録しない（公式が過去の日付を出す回がある）。
  if (ed.deadline && ed.deadline >= today) {
    out.push(`${EDITION_FIELD_INDENT}deadlines:`);
    out.push(`${DEADLINE_ITEM_INDENT}- date: '${ed.deadline}'`);
    out.push(`${DEADLINE_KEY_INDENT}kind: abstract`);
    out.push(`${DEADLINE_KEY_INDENT}label: 発表申込締切`);
    out.push(`${DEADLINE_KEY_INDENT}precision: date-only`);
  } else {
    out.push(`${EDITION_FIELD_INDENT}deadlines: []`);
  }
  out.push(`${EDITION_FIELD_INDENT}event_end: '${ed.event_end}'`);
  out.push(`${EDITION_FIELD_INDENT}event_start: '${ed.event_start}'`);
  out.push(
    `${EDITION_FIELD_INDENT}id: ${idPrefix}-${ed.event_start.slice(0, 4)}-${ed.event_start.slice(5, 7)}`,
  );
  out.push(`${EDITION_FIELD_INDENT}link: ${programUrl(keyToTgid(key))}`);
  out.push(`${EDITION_FIELD_INDENT}place: ${ed.place}`);
  out.push(`${EDITION_FIELD_INDENT}year: ${ed.event_start.slice(0, 4)}`);
  return out;
}

/* 研究会キーと研究会発表申込システムの tgid の対応表。情報処理学会の研究会も
 * 同じシステム（ken.ieice.org）でスケジュール表を出しているので、学会名付きの
 * tgid（IPSJ-HPC など）はここに名指しで持つ。tgid に "-" を含むものは学会名付きと
 * みなしてそのまま URL に使う。 */
const TGID_BY_KEY: Record<string, string> = {
  "ieice-ns": "NS",
  "ieice-in": "IN",
  "ieice-isec": "ISEC",
  "ieice-cpsy": "CPSY",
  "ieice-rcs": "RCS",
  "ieice-nv": "NV",
  "ipsj-sighpc": "IPSJ-HPC",
  "ipsj-sigsec": "IPSJ-CSEC",
  "ipsj-sigarc": "IPSJ-ARC",
  "ipsj-sigemb": "IPSJ-EMB",
  "ipsj-sigse": "IPSJ-SE",
  "ipsj-sigdps": "IPSJ-DPS",
  "ipsj-sigubi": "IPSJ-UBI",
};

export function keyToTgid(key: string): string {
  return TGID_BY_KEY[key] ?? key.replace(/^ieice-/, "").toUpperCase();
}

/** tgid から研究会キーを組み立てる（逆引きに無いものは IEICE の略称とみなす）。 */
export function tgidToKey(tgid: string): string {
  for (const [key, value] of Object.entries(TGID_BY_KEY)) if (value === tgid) return key;
  return `ieice-${tgid.toLowerCase()}`;
}

export function programUrl(tgid: string): string {
  const tgidParam = tgid.includes("-") ? tgid : `IEICE-${tgid}`;
  return `https://ken.ieice.org/ken/program/?tgid=${tgidParam}`;
}

function conferenceRange(text: string, key: string): { start: number; end: number } | null {
  const at = text.indexOf(`\n${CONFERENCE_FIELD_INDENT}key: ${key}\n`);
  if (at < 0) return null;
  const start = text.lastIndexOf("\n  - ", at);
  if (start < 0) return null;
  const candidates = [
    text.indexOf("\n  - ", at),
    text.indexOf("\nschema_version:"),
    text.length,
  ].map((n) => (n > at ? n : Number.POSITIVE_INFINITY));
  return { start, end: Math.min(...candidates) };
}

/**
 * manual.yaml のテキストへ会期・締切を反映した結果を返す。
 * 既存の締切値は変更せず、空の `deadlines: []` と未登録の会期の追加だけを行う
 * （人手で確定済みの値をスクリプトが壊さないため）。
 */
export function planIeiceUpdate(
  manualText: string,
  rowsByCommittee: Record<string, ScheduleRow[]>,
  today: string,
): PlanResult {
  let text = manualText;
  const entries: PlanEntry[] = [];
  const unregistered: string[] = [];
  for (const [key, rows] of Object.entries(rowsByCommittee)) {
    let range = conferenceRange(text, key);
    if (!range) {
      unregistered.push(key);
      continue;
    }
    let block = text.slice(range.start, range.end);
    const entry: PlanEntry = { key, deadlinesFilled: [], editionsAdded: [] };
    // 版 id の接頭語は会議キーと限らない（ipsj-sighpc の版は ipsj-hpc-2026-12）。
    const idPrefix = editionIdPrefix(block, key);
    const existingStarts: string[] = [];
    for (const match of block.matchAll(/event_start: '(\d{4}-\d{2}-\d{2})'/g)) {
      existingStarts.push(match[1]);
    }
    for (const row of rows) {
      if (row.event_end < today || existingStarts.indexOf(row.event_start) < 0) continue;
      if (!row.deadline || row.deadline < today) continue;
      const id = `${idPrefix}-${row.event_start.slice(0, 4)}-${row.event_start.slice(5, 7)}`;
      const updated = fillDeadline(block, id, row.deadline);
      if (updated === null) continue;
      block = updated;
      entry.deadlinesFilled.push(`${id} ${row.deadline}`);
    }
    const additions = rows
      .filter((row) => row.event_end >= today && existingStarts.indexOf(row.event_start) < 0)
      .sort((a, b) => a.event_start.localeCompare(b.event_start));
    if (additions.length) {
      let insertAt = block.indexOf(`${CONFERENCE_FIELD_INDENT}full_name:`);
      if (insertAt < 0) throw new Error(`${key}: editions の末尾位置を特定できない`);
      // 収録したての会議は `editions: []`（インラインの空リスト）で持つ。そのまま版を足すと
      // `editions: []` の直下に 6 字下げの項が来て YAML が壊れるので、ブロック表記へ直す。
      const emptyEditions = `${CONFERENCE_FIELD_INDENT}editions: []\n`;
      const emptyEditionAsBlock = `${CONFERENCE_FIELD_INDENT}editions:\n`;
      const emptyAt = block.indexOf(emptyEditions);
      if (emptyAt >= 0 && emptyAt < insertAt) {
        block = block.replace(emptyEditions, emptyEditionAsBlock);
        insertAt += emptyEditionAsBlock.length - emptyEditions.length;
      }
      const lines: string[] = [];
      for (const row of additions) lines.push(...editionLines(row, key, today, idPrefix));
      block = `${block.slice(0, insertAt)}${lines.join("\n")}\n${block.slice(insertAt)}`;
      entry.editionsAdded.push(...additions.map((row) => row.event_start));
    }
    if (entry.deadlinesFilled.length || entry.editionsAdded.length) {
      text = text.slice(0, range.start) + block + text.slice(range.end);
      range = { start: range.start, end: range.start + block.length };
    }
    entries.push(entry);
  }
  return { text, entries, unregistered };
}

// --- 取得 --------------------------------------------------------------------

/** ken.ieice.org は既知のブラウザ UA でないと 403 を返し、間隔を詰めると 503 を返す。 */
export async function fetchProgram(tgid: string, timeoutMs = 20_000): Promise<string> {
  const res = await fetch(programUrl(tgid), {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${programUrl(tgid)}`);
  return await res.text();
}

function readCached(cacheDir: string, tgid: string): string | null {
  const path = join(cacheDir, `${tgid}.html`);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function loadManualKeys(): Set<string> {
  const doc = loadYaml(readFileSync(join(ROOT_DIR, "data", "manual.yaml"), "utf8")) as {
    conferences?: { key?: string }[];
  };
  return new Set((doc.conferences || []).map((c) => String(c.key ?? "")));
}

const ROOT_DIR = join(import.meta.dirname, "..");

/* 巡回する研究会。手前の 6 つは data/manual.yaml に収録済みで、 automatic に更新できる。
 * 以降は未収録（公式のスケジュール表はあるが、manual.yaml にブロックが無い）。
 * 実行すると「公式に何回分出ているか」を報告する。収録するかどうかは人が決める。 */
const TGID_ORDER = [
  ...Object.keys(TGID_BY_KEY).map(keyToTgid),
  "NWS",
  "DC",
  "SUSC",
  "ICSS",
  "AI",
  "IBISML",
  "DE",
  "SS",
  // 情報処理学会の研究会も同じシステムでスケジュール表が出る（ipsj.or.jp は 403 で機械取得不能）。
  "IPSJ-HPC",
  "IPSJ-CSEC",
  "IPSJ-ARC",
  "IPSJ-EMB",
  "IPSJ-SE",
  "IPSJ-DPS",
  "IPSJ-UBI",
];

function parseArgs(argv: string[]): {
  apply: boolean;
  cacheDir: string | null;
  only: string[];
  today: string;
  intervalMs: number;
} {
  const out = {
    apply: false,
    cacheDir: null as string | null,
    only: [] as string[],
    today: new Date().toISOString().slice(0, 10),
    intervalMs: 12_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--cache-dir") out.cacheDir = argv[++i] ?? null;
    else if (arg === "--only") out.only = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--now") out.today = (argv[++i] ?? "").slice(0, 10);
    else if (arg === "--interval") out.intervalMs = Number(argv[++i] ?? out.intervalMs);
    else throw new Error(`unknown flag: ${arg}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const wanted = args.only.length ? args.only : TGID_ORDER;
  if (args.cacheDir && !existsSync(args.cacheDir)) mkdirSync(args.cacheDir, { recursive: true });
  const manualKeys = loadManualKeys();
  const rowsByCommittee: Record<string, ScheduleRow[]> = {};
  const failures: string[] = [];
  for (const tgid of wanted) {
    const key = tgidToKey(tgid);
    const registered = manualKeys.has(key);
    let html: string | null = null;
    if (args.cacheDir) html = readCached(args.cacheDir, tgid);
    if (html === null) {
      try {
        html = await fetchProgram(tgid);
        if (args.cacheDir) writeFileSync(join(args.cacheDir, `${tgid}.html`), html);
        await new Promise((resolve) => setTimeout(resolve, args.intervalMs));
      } catch (exc) {
        failures.push(`${tgid}: ${(exc as Error).message}`);
        continue;
      }
    }
    const rows = parseSchedule(html);
    if (!registered) {
      // 収録していない研究会は、自動では増やさない（収録は人の判断）。
      // ただし公式に何回先まで出ているかを出して、追加する価値があるかを示す。
      const upcoming = rows.filter((r) => r.event_end >= args.today).length;
      console.log(
        `未収録 ${key}: 公式に ${upcoming} 回分の開催（manual.yaml にブロックを足すと取り込む）`,
      );
      continue;
    }
    rowsByCommittee[key] = rows;
  }

  const manualPath = join(ROOT_DIR, "data", "manual.yaml");
  const original = readFileSync(manualPath, "utf8");
  const plan = planIeiceUpdate(original, rowsByCommittee, args.today);
  // 生成物をそのまま書き込まないための検査（キーの欠落・重複・既存版の消失を見たら止める）。
  const before = loadYaml(original) as { conferences: Record<string, unknown>[] };
  const after = loadYaml(plan.text) as { conferences: Record<string, unknown>[] };
  const beforeById = new Map(before.conferences.map((c) => [String(c.key), c]));
  for (const conf of after.conferences) {
    const key = String(conf.key ?? "");
    const source = beforeById.get(key);
    if (!source) throw new Error(`会議が増えた（このスクリプトの想定外）: ${key}`);
    const beforeCount = ((source.editions as unknown[]) || []).length;
    const afterCount = ((conf.editions as unknown[]) || []).length;
    if (afterCount < beforeCount) throw new Error(`版が消えた: ${key}`);
  }
  if (after.conferences.length !== before.conferences.length) throw new Error("会議数が変わった");

  let changed = 0;
  for (const entry of plan.entries) {
    if (!entry.deadlinesFilled.length && !entry.editionsAdded.length) continue;
    changed += 1;
    console.log(
      `${entry.key}: 締切 ${entry.deadlinesFilled.length} 件（${entry.deadlinesFilled.join(", ")}）/ 会期追加 ${entry.editionsAdded.join(", ")}`,
    );
  }
  if (failures.length) console.warn(`取得失敗 ${failures.length} 件: ${failures.join(" / ")}`);
  if (plan.unregistered.length) console.warn(`未登録: ${plan.unregistered.join(", ")}`);
  if (!changed) {
    console.log("更新なし");
    return;
  }
  if (!args.apply) {
    console.log("dry-run: --apply で data/manual.yaml に書き込む");
    return;
  }
  writeFileSync(manualPath, plan.text);
  console.log(`data/manual.yaml を更新した（${changed} 研究会）`);
}

if (process.argv[1]?.endsWith("refresh-ieice.ts")) {
  await main();
}
