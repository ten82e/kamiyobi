#!/usr/bin/env node
/**
 * Generate a reverification manifest from the snapshot.
 *
 * Reads data.json and outputs a prioritized list of deadlines that have
 * VerificationState and a future deadline, sorted by next_check_at.
 *
 * Usage:
 *   node scripts/reverification-manifest.ts [--data <path>] [--now <ISO>] [--json]
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";

interface DeadlineBase {
  deadline: string;
  kind: string;
  official_url?: string;
  verification?: {
    official_url: string;
    last_attempt_at: string | null;
    last_verified_at: string | null;
    next_check_at: string;
    content_hash: string | null;
    status: string;
  };
}

interface Conference {
  key: string;
  title: string;
  full_name: string;
  deadlines: DeadlineBase[];
}

interface ManifestEntry {
  venue_key: string;
  venue_title: string;
  deadline: string;
  kind: string;
  official_url: string;
  next_check_at: string;
  last_verified_at: string | null;
  last_attempt_at: string | null;
  content_hash: string | null;
  verification_status: string;
  priority: "urgent" | "normal" | "low";
}

interface Manifest {
  generated_at: string;
  data_file: string;
  total_deadlines: number;
  deadlines_with_verification: number;
  entries: ManifestEntry[];
}

function parseArgs(argv: string[]) {
  let dataPath = "public/data.json";
  let now: Date | null = null;
  let json = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data" && argv[i + 1]) {
      dataPath = argv[++i];
    } else if (arg === "--now" && argv[i + 1]) {
      now = new Date(argv[++i]);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node scripts/reverification-manifest.ts [--data <path>] [--now <ISO>] [--json]",
      );
      process.exit(0);
    }
  }

  return { dataPath, now: now ?? new Date(), json };
}

function classifyPriority(nextCheckAt: string, now: Date): ManifestEntry["priority"] {
  const msUntil = new Date(nextCheckAt).getTime() - now.getTime();
  if (msUntil <= 0) return "urgent";
  if (msUntil <= 3 * 24 * 60 * 60 * 1000) return "urgent";
  if (msUntil <= 7 * 24 * 60 * 60 * 1000) return "normal";
  return "low";
}

function main(argv: string[] = process.argv) {
  const { dataPath, now, json } = parseArgs(argv);

  let data: { conferences: Conference[] };
  try {
    data = JSON.parse(readFileSync(dataPath, "utf8"));
  } catch (error) {
    process.stderr.write(
      `failed to read data: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }

  const conferences = data.conferences ?? [];
  let totalDeadlines = 0;
  let deadlinesWithVerification = 0;
  const entries: ManifestEntry[] = [];

  for (const conf of conferences) {
    for (const dl of conf.deadlines ?? []) {
      totalDeadlines++;
      if (!dl.verification) continue;

      // Only include deadlines with a future deadline
      const deadlineDate = new Date(dl.deadline);
      if (deadlineDate.getTime() <= now.getTime()) continue;

      deadlinesWithVerification++;
      entries.push({
        venue_key: conf.key,
        venue_title: conf.title,
        deadline: dl.deadline,
        kind: dl.kind,
        official_url: dl.verification.official_url,
        next_check_at: dl.verification.next_check_at,
        last_verified_at: dl.verification.last_verified_at,
        last_attempt_at: dl.verification.last_attempt_at,
        content_hash: dl.verification.content_hash,
        verification_status: dl.verification.status,
        priority: classifyPriority(dl.verification.next_check_at, now),
      });
    }
  }

  // Sort by next_check_at (earliest first)
  entries.sort((a, b) => new Date(a.next_check_at).getTime() - new Date(b.next_check_at).getTime());

  const manifest: Manifest = {
    generated_at: now.toISOString(),
    data_file: basename(dataPath),
    total_deadlines: totalDeadlines,
    deadlines_with_verification: deadlinesWithVerification,
    entries,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } else {
    console.log(`Reverification manifest: ${entries.length} entries`);
    console.log(`Total deadlines: ${totalDeadlines}`);
    console.log(`With verification: ${deadlinesWithVerification}`);
    console.log(`Now: ${now.toISOString()}`);
    console.log("");
    if (entries.length === 0) {
      console.log("No deadlines with verification state found.");
      console.log("VerificationState is populated during the build pipeline.");
    } else {
      console.log(
        "Venue".padEnd(12) +
          "Deadline".padEnd(12) +
          "Kind".padEnd(8) +
          "Priority".padEnd(10) +
          "Status".padEnd(18) +
          "Next Check".padEnd(22) +
          "URL",
      );
      console.log("-".repeat(100));
      for (const e of entries) {
        console.log(
          e.venue_key.padEnd(12) +
            e.deadline.slice(0, 10).padEnd(12) +
            e.kind.padEnd(8) +
            e.priority.padEnd(10) +
            e.verification_status.padEnd(18) +
            e.next_check_at.slice(0, 19).padEnd(22) +
            e.official_url,
        );
      }
    }
  }

  return 0;
}

// Support direct execution and test import
if (basename(process.argv[1] ?? "") === basename(new URL(import.meta.url).pathname)) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}

export type { Manifest, ManifestEntry };
export { classifyPriority, main, parseArgs };
