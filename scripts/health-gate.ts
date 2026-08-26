import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateHealthGate, type HealthReport } from "../src/build.ts";

export interface HealthGateArgs {
  currentPath: string;
  previousPath?: string;
  lastKnownGoodPath?: string;
  requireBaseline: boolean;
  /** 失敗時でも必ず machine-readable な違反報告を書く先。 */
  reportPath?: string;
}

function usage(): never {
  console.error(
    [
      "usage: node scripts/health-gate.ts <current-health.json>",
      "  [--require-baseline]",
      "  [--report <violations.json>]",
      "  [last-known-good.json] [write-last-known-good.json]",
    ].join(" "),
  );
  process.exit(2);
}

export function parseHealthGateArgs(argv: string[]): HealthGateArgs | null {
  const positional: string[] = [];
  let requireBaseline = false;
  let reportPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--require-baseline") {
      requireBaseline = true;
      continue;
    }
    if (arg === "--report") {
      const value = argv[++i];
      if (!value) return null;
      reportPath = value;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0 || positional.length > 3) return null;
  return {
    currentPath: positional[0],
    ...(positional[1] ? { previousPath: positional[1] } : {}),
    ...(positional[2] ? { lastKnownGoodPath: positional[2] } : {}),
    requireBaseline,
    ...(reportPath ? { reportPath } : {}),
  };
}

/** gate 判定の機械可読記録。失敗時の診断 artifact としてそのまま保存する。 */
export interface HealthGateViolationReport {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  baseline_available: boolean;
  current_path: string;
  previous_path: string | null;
}

export function runHealthGate(argv: string[]): number {
  const args = parseHealthGateArgs(argv);
  if (!args) usage();
  const hasUsableBaseline = Boolean(args.previousPath && existsSync(args.previousPath));
  const writeReport = (report: HealthGateViolationReport) => {
    if (!args.reportPath) return;
    try {
      writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      console.error(`health gate could not write its violation report: ${String(error)}`);
    }
  };
  if (args.requireBaseline && !hasUsableBaseline) {
    console.error("health gate blocked deployment: usable baseline is unavailable");
    writeReport({
      ok: false,
      reasons: ["usable baseline is unavailable"],
      warnings: [],
      baseline_available: false,
      current_path: args.currentPath,
      previous_path: args.previousPath ?? null,
    });
    return 1;
  }
  try {
    const currentText = readFileSync(args.currentPath, "utf8");
    const current = JSON.parse(currentText) as HealthReport;
    const previous = hasUsableBaseline
      ? (JSON.parse(readFileSync(args.previousPath!, "utf8")) as HealthReport)
      : null;
    const result = evaluateHealthGate(current, previous);
    for (const warning of result.warnings) console.warn(`health gate warning: ${warning}`);
    if (!result.ok) {
      console.error(`health gate blocked deployment: ${result.reasons.join("; ")}`);
      writeReport({
        ok: false,
        reasons: [...result.reasons],
        warnings: [...result.warnings],
        baseline_available: hasUsableBaseline,
        current_path: args.currentPath,
        previous_path: hasUsableBaseline ? args.previousPath! : null,
      });
      return 1;
    }
    if (args.lastKnownGoodPath) {
      writeFileSync(args.lastKnownGoodPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    writeReport({
      ok: true,
      reasons: [],
      warnings: [...result.warnings],
      baseline_available: hasUsableBaseline,
      current_path: args.currentPath,
      previous_path: hasUsableBaseline ? args.previousPath! : null,
    });
    console.log(
      previous
        ? "health gate passed against last-known-good"
        : "health gate passed without baseline",
    );
    return 0;
  } catch (error) {
    console.error(`health gate could not read its report: ${String(error)}`);
    writeReport({
      ok: false,
      reasons: [`could not read health report: ${String(error)}`],
      warnings: [],
      baseline_available: hasUsableBaseline,
      current_path: args.currentPath,
      previous_path: args.previousPath ?? null,
    });
    return 1;
  }
}

const isMain = process.argv[1]?.endsWith("health-gate.ts");
if (isMain) process.exit(runHealthGate(process.argv.slice(2)));
