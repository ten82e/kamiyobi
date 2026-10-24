/** One reviewed CFP can have several archival venue/edition names. */
export const COMPSAC_JIP_CALL = {
  key: "jip-compsac-2027-special-issue",
  title: "JIP 特集号（Applications and the Internet／COMPSAC 2026連携）",
  publisher: "Journal of Information Processing（情報処理学会）",
  publicationYear: 2027,
  issueLabel: "2027年9月号（掲載予定）",
  language: "英語論文のみ",
  officialUrl: "https://www.ipsj.or.jp/journal/cfp/27-R.html",
  evidenceRef:
    "data/evidence/blobs/9972268f811c33df5e345fc94570018d6ea5ec55be146ca81b95744b7fd4f3bd.body",
  aliases: [
    { venueKey: "jip", editionId: "jip-compsac2027-si", year: 2027, label: "投稿締切" },
    { venueKey: "ipsj-27-r-compsac", editionId: "ipsj-27-r26", year: 2026, label: "Submission" },
  ],
} as const;

interface SubmissionIdentityInput {
  venueKey?: string;
  editionId?: string;
  editionYear?: number;
  label?: string;
  officialUrl?: string;
  kind?: string;
  round?: number;
  track?: string;
  precision?: string;
  localDate?: string;
}

/** Scope is exact archival IDs, official CFP, one paper round, and the reviewed date-only value. */
export function reviewedSubmission(input: SubmissionIdentityInput): typeof COMPSAC_JIP_CALL | null {
  return COMPSAC_JIP_CALL.aliases.some(
    (alias) =>
      alias.venueKey === input.venueKey &&
      alias.editionId === input.editionId &&
      alias.year === input.editionYear &&
      alias.label === input.label,
  ) &&
    input.officialUrl === COMPSAC_JIP_CALL.officialUrl &&
    input.kind === "paper" &&
    input.round === 1 &&
    !input.track &&
    input.precision === "date-only" &&
    input.localDate === "2026-12-01"
    ? COMPSAC_JIP_CALL
    : null;
}

interface SubmissionRow {
  conf: { key: string; title?: string; full_name?: string; link?: string; tags?: string[] };
  ed: {
    id?: string;
    year?: number;
    link?: string;
    date_text?: string;
    event_start?: string | null;
    event_end?: string | null;
  };
  dl: { kind?: string; round?: number; track?: string; precision?: string; label?: string };
  kind: string;
  localDate?: string;
  hay: string;
  tEvent?: number;
  cats?: string[];
  tags?: string[];
  submission?: SubmissionDisplay;
}

export interface SubmissionDisplay {
  issueLabel: string;
  language: string;
  shareAliases: string[];
  sourceRecords: Array<{ venueKey: string; editionId: string; year?: number }>;
}

/** Consolidate the presentation only. Input objects and archival records remain unchanged. */
export function consolidateReviewedSubmissions<T extends SubmissionRow>(
  rows: T[],
  shareKey: (row: T) => string,
): Array<T & { submission?: SubmissionDisplay }> {
  const members = rows.filter((row) =>
    reviewedSubmission({
      venueKey: row.conf.key,
      editionId: row.ed.id,
      editionYear: row.ed.year,
      label: row.dl.label,
      officialUrl: row.ed.link || row.conf.link,
      kind: row.kind,
      round: row.dl.round,
      track: row.dl.track,
      precision: row.dl.precision,
      localDate: row.localDate,
    }),
  );
  if (!members.length || (members.length === 1 && members[0].submission)) return rows;
  const chosen = members.find((row) => row.conf.key === "jip") || members[0];
  const display = {
    ...chosen,
    conf: {
      ...chosen.conf,
      title: COMPSAC_JIP_CALL.title,
      full_name: COMPSAC_JIP_CALL.publisher,
      tags: [...new Set(members.flatMap((row) => [...(row.conf.tags || []), ...(row.tags || [])]))],
    },
    ed: {
      ...chosen.ed,
      year: COMPSAC_JIP_CALL.publicationYear,
      date_text: COMPSAC_JIP_CALL.issueLabel,
      event_start: "",
      event_end: "",
    },
    cats: [...new Set(members.flatMap((row) => row.cats || []))],
    tags: [...new Set(members.flatMap((row) => row.tags || []))],
    hay: `${members.map((row) => row.hay).join(" ")} ${COMPSAC_JIP_CALL.issueLabel} ${COMPSAC_JIP_CALL.language}`,
    tEvent: Number.NaN,
    submission: {
      issueLabel: COMPSAC_JIP_CALL.issueLabel,
      language: COMPSAC_JIP_CALL.language,
      shareAliases: [
        ...new Set(members.flatMap((row) => row.submission?.shareAliases || [shareKey(row)])),
      ],
      sourceRecords: [
        ...new Map(
          members
            .flatMap(
              (row) =>
                row.submission?.sourceRecords || [
                  {
                    venueKey: row.conf.key,
                    editionId: row.ed.id || "",
                    year: row.ed.year,
                  },
                ],
            )
            .map((record) => [JSON.stringify(record), record]),
        ).values(),
      ],
    },
  };
  const first = rows.findIndex((row) => members.includes(row));
  return rows.flatMap((row, index) =>
    index === first ? [display] : members.includes(row) ? [] : [row],
  );
}

export interface SharedRowIdentity {
  legacyShareKey?: string;
  shareDiscriminator?: string;
}

/** Only colliding legacy keys gain a suffix. Distinct editions, rounds and labels stay distinct. */
export function assignShareIdentities<T extends SubmissionRow>(
  rows: T[],
  legacyKey: (row: T) => string,
): Array<T & SharedRowIdentity> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = legacyKey(row);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return rows.map((row) => {
    const key = legacyKey(row);
    if ((groups.get(key)?.length || 0) < 2) return row;
    return {
      ...row,
      legacyShareKey: key,
      shareDiscriminator: JSON.stringify([
        row.ed.id || "",
        row.dl.round ?? 1,
        row.dl.track || "",
        row.dl.label || "",
      ]),
    };
  });
}
