/** Deterministic semantic validation for every production data input. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { asDate, deadlineTrackKey, isConfirmedTimezone } from "../src/model.ts";

export interface DataValidation {
  errors: string[];
  warnings: string[];
  stats: { exact: number; date_only: number; estimated: number };
}

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff\ufffd]/u;
const YEAR = /\b(20\d{2})\b/g;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function add(out: string[], message: string): void {
  out.push(message);
}
function years(value: unknown): number[] {
  return [...String(value ?? "").matchAll(YEAR)].map((match) => Number(match[1]));
}
function idYears(value: string, includeShortSuffix = false): number[] {
  const standalone = [...value.matchAll(/(?:^|[-_])(20\d{2})(?=$|[-_])/g)].map((match) =>
    Number(match[1]),
  );
  // Some upstream IDs compact the issue and edition suffix as 202726; the
  // terminal 26 is the edition year and must still be checked.
  const compact = [...value.matchAll(/20\d{2}(\d{2})(?=$|[-_])/g)].map(
    (match) => 2000 + Number(match[1]),
  );
  const terminalFour = /20\d{2}$/.exec(value);
  const terminalShort = /(\d{2})$/.exec(value);
  const shortYear = terminalShort ? Number(terminalShort[1]) : 0;
  return [
    ...new Set([
      ...standalone,
      ...compact,
      ...(terminalFour ? [Number(terminalFour[0])] : []),
      ...(includeShortSuffix && shortYear >= 20 ? [2000 + shortYear] : []),
    ]),
  ];
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

export function normalizedTrack(track: unknown, label: unknown, kind: unknown): string {
  return deadlineTrackKey(
    String(label ?? ""),
    String(kind || "other"),
    typeof track === "string" ? track : "",
  );
}

function deadlineValue(
  deadline: Record<string, unknown>,
  precision: "exact" | "date-only",
): string {
  return String(
    precision === "date-only"
      ? (deadline.local_date ?? deadline.date)
      : (deadline.utc ?? deadline.at_utc ?? deadline.date ?? ""),
  );
}
function deadlineRound(deadline: Record<string, unknown>): number {
  const explicit = Number(deadline.round ?? 1) || 1;
  const named = /\b(?:round|r)\s*(\d+)\b/i.exec(String(deadline.label ?? ""));
  return named ? Number(named[1]) : explicit;
}

function validateEdition(
  key: string,
  edition: Record<string, unknown>,
  result: DataValidation,
): void {
  const year = Number(edition.year);
  const id = String(edition.id ?? edition.edition_id ?? "");
  const prefix = `${key}/${id || year}`;
  if (!Number.isInteger(year)) {
    add(result.errors, `${prefix}: edition year is invalid`);
    return;
  }
  for (const mentioned of years(edition.date_text))
    if (mentioned !== year)
      add(result.errors, `${prefix}: date_text year ${mentioned} conflicts with edition ${year}`);
  for (const idYear of idYears(id))
    if (idYear !== year) add(result.errors, `${prefix}: id year conflicts with edition year`);
  const start = asDate(edition.event_start);
  const end = asDate(edition.event_end);
  for (const date of [start, end])
    if (date && date.getUTCFullYear() !== year)
      add(result.errors, `${prefix}: event date year conflicts with edition ${year}`);
  if ((start === null) !== (end === null))
    add(result.errors, `${prefix}: event range is incomplete`);
  if (start && end && start > end) add(result.errors, `${prefix}: event range is reversed`);
  if (!start && !end && String(edition.date_text ?? "").trim())
    add(result.warnings, `${prefix}: event date text is not structured`);

  const slots = new Map<string, string>();
  for (const deadline of records(edition.deadlines)) {
    if (
      deadline.precision !== undefined &&
      deadline.precision !== "exact" &&
      deadline.precision !== "date-only"
    )
      add(result.errors, `${prefix}: unknown deadline precision ${String(deadline.precision)}`);
    const precision = deadline.precision === "date-only" ? "date-only" : "exact";
    const value = deadlineValue(deadline, precision);
    if (precision === "date-only") {
      result.stats.date_only += 1;
      if (
        deadline.tz_raw ||
        deadline.tz ||
        deadline.timezone ||
        deadline.utc ||
        deadline.at_utc ||
        deadline.time ||
        /[T\s]\d{1,2}:\d{2}/.test(value)
      )
        add(result.errors, `${prefix}: date-only has time/timezone`);
      if (!asDate(value)) add(result.errors, `${prefix}: invalid date-only value`);
    } else {
      result.stats.exact += 1;
      const tz = String(deadline.tz_raw ?? deadline.tz ?? deadline.timezone ?? "");
      const calendarDate = /^(\d{4}-\d{2}-\d{2})[T ]/.exec(value)?.[1];
      if (deadline.local_date !== undefined)
        add(result.errors, `${prefix}: exact mixes local_date with instant`);
      if ((tz && !isConfirmedTimezone(tz)) || (!tz && !/[zZ]$/.test(value)))
        add(result.errors, `${prefix}: exact has unconfirmed timezone`);
      if ((calendarDate && !asDate(calendarDate)) || Number.isNaN(Date.parse(value)))
        add(result.errors, `${prefix}: invalid exact instant`);
    }
    if (edition.estimated) result.stats.estimated += 1;
    const kind = String(deadline.kind ?? "other");
    const slot = [
      kind,
      deadlineRound(deadline),
      normalizedTrack(deadline.track, deadline.label, kind),
    ].join("\0");
    const previous = slots.get(slot);
    if (previous !== undefined && previous !== value)
      add(result.errors, `${prefix}: conflicting deadline slot ${slot.replaceAll("\0", "/")}`);
    slots.set(slot, value);
    const deadlineDate = precision === "date-only" ? asDate(value) : new Date(value);
    if (
      start &&
      deadlineDate &&
      !Number.isNaN(deadlineDate.getTime()) &&
      ["paper", "abstract", "supplementary"].includes(kind) &&
      deadlineDate > end!
    )
      add(result.errors, `${prefix}: deadline appears to be an event date (${kind})`);
  }
}

export function validateData(payload: Record<string, unknown>): DataValidation {
  const result: DataValidation = {
    errors: [],
    warnings: [],
    stats: { exact: 0, date_only: 0, estimated: 0 },
  };
  for (const conference of records(payload.conferences)) {
    const key = String(conference.key ?? "?");
    const editions = records(conference.editions);
    const actualYears = editions
      .filter((edition) => !edition.estimated)
      .map((edition) => Number(edition.year))
      .filter(Number.isInteger);
    if (actualYears.length > 0) {
      const expected = Math.max(...actualYears);
      for (const keyYear of idYears(key, true)) {
        if (keyYear !== expected)
          add(result.errors, `${key}: key year ${keyYear} conflicts with edition ${expected}`);
      }
    }
    for (const field of ["title", "full_name"] as const) {
      const value = String(conference[field] ?? "");
      if (INVISIBLE.test(value))
        add(result.errors, `${key}: ${field} contains invisible/replacement characters`);
      if (/\b\p{L}{3,}\s+20$/u.test(value))
        add(result.errors, `${key}: ${field} appears truncated`);
      const mentioned = years(value);
      const actual = actualYears;
      if (mentioned.length && actual.length) {
        const expected = Math.max(...actual);
        for (const namedYear of mentioned)
          if (namedYear !== expected)
            add(
              result.errors,
              `${key}: ${field} year ${namedYear} conflicts with edition ${expected}`,
            );
      }
    }
    const ids = new Set<string>();
    for (const edition of editions) {
      const id = String(edition.id ?? edition.edition_id ?? "");
      if (id && ids.has(id)) add(result.errors, `${key}: duplicate edition id ${id}`);
      ids.add(id);
      validateEdition(key, edition, result);
    }
  }
  result.errors = [...new Set(result.errors)].sort();
  result.warnings = [...new Set(result.warnings)].sort();
  return result;
}

function load(path: string): Record<string, unknown> {
  return loadYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function overrideConferences(
  value: Record<string, unknown>,
  source: string,
): Record<string, unknown>[] {
  const primary = source === "primary_overrides";
  return Object.entries((value.conferences as Record<string, unknown>) ?? {}).map(([key, raw]) => ({
    key: `${source}:${key}`,
    ...(raw as Record<string, unknown>),
    editions: Object.entries(
      ((raw as Record<string, unknown>).editions as Record<string, unknown>) ?? {},
    ).map(([year, edition]) => {
      const item = edition as Record<string, unknown>;
      const deadlines = records(item.deadlines).map((deadline) => {
        if (!primary) return deadline;
        const time = typeof deadline.time === "string" ? deadline.time : "";
        return time
          ? { ...deadline, date: `${String(deadline.date)} ${time}` }
          : { ...deadline, precision: "date-only", tz: undefined, timezone: undefined };
      });
      return { year: Number(year), ...item, ...(deadlines.length ? { deadlines } : {}) };
    }),
  }));
}
function primaryRegistry(value: Record<string, unknown>): Record<string, unknown>[] {
  return Object.entries((value.conferences as Record<string, unknown>) ?? {}).map(([key, raw]) => ({
    key: `primary:${key}`,
    editions: [{ year: Number((raw as Record<string, unknown>).year) }],
  }));
}

function payloadForFile(path: string): Record<string, unknown> {
  if (path.endsWith(".json"))
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const value = load(path);
  const name = path.split("/").at(-1);
  if (name === "overrides.yaml") {
    return { conferences: overrideConferences(value, "overrides") };
  }
  if (name === "primary.yaml") return { conferences: primaryRegistry(value) };
  if (name === "primary_overrides.yaml") {
    return { conferences: overrideConferences(value, "primary_overrides") };
  }
  return value;
}

export function validateFile(path: string): DataValidation {
  return validateData(payloadForFile(path));
}

export function validateProduction(root = ROOT): DataValidation {
  const inputs = [
    { name: "extra", payload: payloadForFile(join(root, "data", "extra.yaml")) },
    {
      name: "overrides",
      payload: payloadForFile(join(root, "data", "overrides.yaml")),
    },
    {
      name: "primary",
      payload: payloadForFile(join(root, "data", "primary.yaml")),
    },
    {
      name: "primary_overrides",
      payload: payloadForFile(join(root, "data", "primary_overrides.yaml")),
    },
    {
      name: "snapshot",
      payload: payloadForFile(join(root, "data", "snapshot.json")),
    },
  ];
  const aggregate: DataValidation = {
    errors: [],
    warnings: [],
    stats: { exact: 0, date_only: 0, estimated: 0 },
  };
  for (const input of inputs) {
    const checked = validateData(input.payload);
    aggregate.errors.push(...checked.errors.map((message) => `${input.name}: ${message}`));
    aggregate.warnings.push(...checked.warnings.map((message) => `${input.name}: ${message}`));
    aggregate.stats.exact += checked.stats.exact;
    aggregate.stats.date_only += checked.stats.date_only;
    aggregate.stats.estimated += checked.stats.estimated;
  }
  aggregate.errors = [...new Set(aggregate.errors)].sort();
  aggregate.warnings = [...new Set(aggregate.warnings)].sort();
  return aggregate;
}

export function main(argv = process.argv.slice(2)): number {
  const json = argv.includes("--json");
  const file = argv.find((value) => !value.startsWith("-"));
  try {
    const result = file ? validateFile(file) : validateProduction();
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else
      process.stdout.write(`validated ${result.stats.exact + result.stats.date_only} deadlines\n`);
    return result.errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`validate:data failed: ${String(error)}\n`);
    return 2;
  }
}
if (process.argv[1]?.endsWith("validate-data.ts")) process.exit(main());
