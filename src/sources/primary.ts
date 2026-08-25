/**
 * Verified-observation stage between primary extraction and merge.
 *
 * data/primary_overrides.yaml は一次ソースからの自動抽出「観測」を載せる。
 * 観測は確認できた精度のまま公開する。日付だけは date-only、時刻と確定 timezone
 * が揃うときだけ exact とする。
 * 満たすときだけにする (SPEC §5):
 *
 *   1. 妥当な日付がある。時刻が無ければ date-only のまま扱い、時刻を捏造しない。
 *   2. 時刻がある場合だけ、tz が resolveTzStatus で confirmed であることを要求する。
 *      CST/BST 等の曖昧略称は不確認として公開しない。
 *   3. 締切日が適用先 edition の開催時期と矛盾しない。会期が不明なら開催年または
 *      前年を許可する。過去版ページは fetch-primary がページタイトルの開催年で隔離する。
 *
 * 検証を通らない行は edition パッチから除外され、パッチ内の deadlines が空に
 * なった edition は deadlines キーごと消える。これにより applyOverrides はその
 * edition をメタデータのみパッチし、既存の確定値 (手書き overrides / 上流) が
 * 保持される。「検証失敗 → 前回値維持」が単一の合成点で完結する。
 *
 * 手訂正の救済経路は本モジュールの外にある: 値の訂正は手編集の
 * data/overrides.yaml (primary より先に適用され、検証を通った primary 行が無い
 * 場合に効く)、tz 未表記ページの補完は data/primary.yaml の tz ヒント
 * (公式が明記した場合のみ) が担う。primary_overrides.yaml 自体は自動生成なので
 * 手編集ブロックの機構は持たない (次回 --apply で消えるため)。
 */

import {
  asDate,
  type Conference,
  DAY_MS,
  type DeadlineEvidence,
  deadlineEvidence,
  KINDS,
  parseDateRange,
  resolveTzStatus,
  warn,
} from "../model.ts";

const TIME_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?/;

/** 解決済み行: そのまま applyOverrides/deadlinesOf に渡せる YAML 行。 */
export type ResolvedRow = Record<string, unknown>;

export function editionYearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * テキストから壁時計の時刻を抜き出して 'HH:MM:SS' に正規化する。
 * 12h 表記 (5:00 pm / 11:59 PM) は 24h に変換する。見つからない・範囲外なら
 * null (日付のみの証拠として扱う)。
 */
export function extractObservationTime(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = TIME_RE.exec(String(text).trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const ap = (m[4] ?? "").replace(/\./g, "").toLowerCase();
  if (min > 59 || sec > 59 || h > 23) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(sec)}`;
}

interface ObservationRow {
  kind: string;
  label: string;
  date: string;
  time: string | null;
  tzRaw: string;
  round: number;
  track?: string;
  rest: Record<string, unknown>;
}

function primaryEvidence(
  row: ObservationRow,
  conference: Record<string, unknown>,
): DeadlineEvidence[] {
  const explicitUrl = String(row.rest.sourceUrl ?? conference.sourceUrl ?? "").trim();
  const commentUrl = /https?:\/\/[^\s)]+/.exec(String(conference._comment ?? ""))?.[0] ?? "";
  const sourceUrl = explicitUrl || commentUrl;
  const originalValue = `${row.date}${row.time ? ` ${row.time} ${row.tzRaw}` : ""}`;
  const supplied = row.rest.evidence;
  if (Array.isArray(supplied)) return deadlineEvidence(supplied);
  if (!sourceUrl) return [];
  return deadlineEvidence([
    {
      source_name: "primary",
      source_url: sourceUrl,
      original_value: originalValue,
      confidence: "official",
      sourceClass: row.rest.structured === false ? "aggregator" : "official-cfp",
      sourceUrl,
      rawExcerpt: String(row.rest.rawExcerpt ?? originalValue),
      verifiedFields: ["date", ...(row.time ? ["time", "timezone"] : [])],
      ...(typeof row.rest.adapter === "string" ? { adapter: row.rest.adapter } : {}),
      ...(typeof row.rest.structured === "boolean" ? { structured: row.rest.structured } : {}),
      ...(typeof row.rest.selectorOrField === "string"
        ? { selectorOrField: row.rest.selectorOrField }
        : {}),
      ...(typeof row.rest.sourceRevision === "string"
        ? { sourceRevision: row.rest.sourceRevision }
        : {}),
      ...(typeof row.rest.retrievedAt === "string" ? { retrievedAt: row.rest.retrievedAt } : {}),
      ...(typeof row.rest.verifiedAt === "string" ? { verifiedAt: row.rest.verifiedAt } : {}),
      ...(typeof row.rest.contentHash === "string" ? { contentHash: row.rest.contentHash } : {}),
    },
  ]);
}

function toObservationRows(rows: unknown): ObservationRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ObservationRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    // date は 'YYYY-MM-DD' 単独か、時刻埋め込み ('YYYY-MM-DD HH:MM[:SS]' /
    // 'YYYY-MM-DD hh:mm am/pm') のどちらも受ける。旧生成物・手マージ由来の
    // 埋め込み形式でも時刻の有無を正しく判定するため。
    const dm =
      /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.)?)?)?$/.exec(
        String(rec.date ?? "").trim(),
      );
    if (!dm) continue;
    const date = dm[1];
    const kind = String(rec.kind ?? "paper");
    // 明示 time フィールドがあればそれを優先し、無ければ埋め込み時刻を使う。
    let time = typeof rec.time === "string" ? extractObservationTime(rec.time) : null;
    if (time === null && dm[2]) time = extractObservationTime(dm[2]);
    out.push({
      kind,
      label: String(rec.label ?? kind),
      date,
      time,
      tzRaw: String(rec.tz ?? ""),
      round: Number(rec.round ?? 1) || 1,
      track: String(rec.track ?? "").trim(),
      rest: rec,
    });
  }
  return out;
}

/** 観測 1 行を確定締切行に解決する。検証を通らないなら null。 */
export function resolveObservation(
  row: ObservationRow,
  editionYear: number,
  eventStart: Date | null = null,
  eventEnd: Date | null = null,
  maxLeadDays = 550,
  evidence: DeadlineEvidence[] = [],
): ResolvedRow | null {
  // 日付のみは一級の観測であり、時刻を捏造しない。
  if (row.time && resolveTzStatus(row.tzRaw).status !== "confirmed") return null;
  const day = asDate(row.date);
  const start = eventStart ?? eventEnd;
  const end = eventEnd ?? eventStart;
  if (
    !day ||
    (start !== null &&
      end !== null &&
      (day.getTime() > end.getTime() || day.getTime() < start.getTime() - maxLeadDays * DAY_MS)) ||
    (start === null &&
      Number.isFinite(editionYear) &&
      ![editionYear - 1, editionYear].includes(editionYearOf(row.date)))
  ) {
    return null;
  }
  const out: ResolvedRow = {
    kind: (KINDS as readonly string[]).includes(row.kind) ? row.kind : "other",
    label: row.label,
    ...(row.time
      ? { date: `${row.date} ${row.time}`, tz: row.tzRaw }
      : { date: row.date, precision: "date-only" }),
    round: row.round,
    ...(row.track ? { track: row.track } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
  };
  if (typeof row.rest.comment === "string" && row.rest.comment !== "") {
    out.comment = row.rest.comment;
  }
  return out;
}

/**
 * primary_overrides 全体を検証済み観測のみのパッチへ変換する。
 * 手編集ブロック (manual: true) は素通し。破損入力 ({} 等) は {} を返す。
 */
export function resolvePrimaryObservations(
  primary: Record<string, unknown> | null | undefined,
  config: Record<string, unknown> | null | undefined = null,
  knownConferences: Conference[] = [],
): Record<string, unknown> {
  if (!primary || typeof primary !== "object") return {};
  const conferences = primary.conferences as Record<string, unknown> | undefined;
  if (!conferences || typeof conferences !== "object") return {};
  const primaryConfig = config?.primary as Record<string, unknown> | undefined;
  const configuredMaxLeadDays = Number(primaryConfig?.max_lead_days);
  const maxLeadDays =
    Number.isFinite(configuredMaxLeadDays) && configuredMaxLeadDays >= 0
      ? configuredMaxLeadDays
      : 550;
  const outConferences: Record<string, unknown> = {};
  for (const [key, confPatch] of Object.entries(conferences)) {
    if (typeof confPatch !== "object" || confPatch === null) continue;
    const rec = confPatch as Record<string, unknown>;
    const editions = rec.editions as Record<string, unknown> | undefined;
    if (!editions || typeof editions !== "object") {
      outConferences[key] = confPatch;
      continue;
    }
    const knownConference = knownConferences.find((conference) => conference.key === key);
    const outEditions: Record<string, unknown> = {};
    for (const [yearKey, editionPatch] of Object.entries(editions)) {
      if (typeof editionPatch !== "object" || editionPatch === null) continue;
      const ep = editionPatch as Record<string, unknown>;
      const editionYear = Number(yearKey);
      const knownEdition = knownConference?.editions.find(
        (edition) => edition.year === editionYear,
      );
      const [parsedStart, parsedEnd] = parseDateRange(String(ep.date_text ?? ""), editionYear);
      const eventStart = asDate(ep.event_start) ?? parsedStart ?? knownEdition?.event_start ?? null;
      const eventEnd = asDate(ep.event_end) ?? parsedEnd ?? knownEdition?.event_end ?? null;
      const rows = toObservationRows(ep.deadlines);
      if (rows.length === 0) {
        outEditions[yearKey] = Array.isArray(ep.remove) ? { ...ep, mode: "merge-slots" } : ep;
        continue;
      }
      let ambiguous = 0;
      let outsideWindow = 0;
      const resolved: ResolvedRow[] = [];
      for (const row of rows) {
        const done = resolveObservation(
          row,
          editionYear,
          eventStart,
          eventEnd,
          maxLeadDays,
          primaryEvidence(row, rec),
        );
        if (done !== null) {
          resolved.push(done);
        } else if (row.time && resolveTzStatus(row.tzRaw).status === "confirmed") {
          outsideWindow += 1;
        } else {
          ambiguous += 1;
        }
      }
      if (resolved.length === 0) {
        // 検証を通る行が無い → deadlines キーを外して既存の確定値を保持する。
        if (outsideWindow > 0) {
          warn(
            `primary[${key}/${yearKey}]: quarantined ${outsideWindow} observation(s) ` +
              "(deadline falls outside edition window)",
          );
        }
        if (ambiguous > 0) {
          warn(
            `primary[${key}/${yearKey}]: dropped ${ambiguous} observation(s) ` +
              "(unconfirmed timezone)",
          );
        }
        const { deadlines: _omit, ...rest } = ep;
        outEditions[yearKey] = rest;
        continue;
      }
      if (outsideWindow > 0 || ambiguous > 0) {
        warn(
          `primary[${key}/${yearKey}]: kept ${resolved.length}/${rows.length} observation(s), ` +
            `quarantined ${outsideWindow} outside-window / ${ambiguous} unverifiable`,
        );
      }
      // Primary is an observation stream: update only the slots it observed.
      // `remove` is intentionally the only deletion mechanism.
      outEditions[yearKey] = {
        ...ep,
        mode: "merge-slots",
        deadlines: resolved,
        ...(Array.isArray(ep.remove) ? { remove: ep.remove } : {}),
      };
    }
    outConferences[key] = { ...rec, editions: outEditions };
  }
  return { conferences: outConferences };
}
