import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateHealthGate, type HealthReport, type ObservationBaseline } from "../src/build.ts";

interface HealthGateArgs {
  currentPath: string;
  previousPath?: string;
  lastKnownGoodPath?: string;
  requireBaseline: boolean;
  /** 失敗時でも必ず machine-readable な違反報告を書く先。 */
  reportPath?: string;
  /** 最後に成功した online 更新の診断 baseline (snapshot fallback 時の比較源)。 */
  observationBaselinePath?: string;
}

function usage(): never {
  console.error(
    [
      "usage: node scripts/health-gate.ts <current-health.json>",
      "  [--require-baseline]",
      "  [--report <violations.json>]",
      "  [--observation-baseline <source-observation-baseline.json>]",
      "  [last-known-good.json] [write-last-known-good.json]",
    ].join(" "),
  );
  process.exit(2);
}

function parseHealthGateArgs(argv: string[]): HealthGateArgs | null {
  const positional: string[] = [];
  let requireBaseline = false;
  let reportPath: string | undefined;
  let observationBaselinePath: string | undefined;
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
    if (arg === "--observation-baseline") {
      const value = argv[++i];
      if (!value) return null;
      observationBaselinePath = value;
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
    ...(observationBaselinePath ? { observationBaselinePath } : {}),
  };
}

/** gate 判定の機械可読記録。失敗時の診断 artifact としてそのまま保存する。 */
interface HealthGateViolationReport {
  ok: boolean;
  exit_status: number;
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
  const writeReport = (report: HealthGateViolationReport): boolean => {
    if (!args.reportPath) return true;
    try {
      mkdirSync(dirname(args.reportPath), { recursive: true });
      writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`);
      return true;
    } catch (error) {
      console.error(`health gate could not write its violation report: ${String(error)}`);
      return false;
    }
  };
  if (args.requireBaseline && !hasUsableBaseline) {
    console.error("health gate blocked deployment: usable baseline is unavailable");
    writeReport({
      ok: false,
      exit_status: 1,
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
    let observationBaseline: ObservationBaseline | null = null;
    if (args.observationBaselinePath && existsSync(args.observationBaselinePath)) {
      try {
        observationBaseline = JSON.parse(
          readFileSync(args.observationBaselinePath, "utf8"),
        ) as ObservationBaseline;
      } catch (error) {
        console.error(`could not read observation baseline: ${String(error)}`);
        writeReport({
          ok: false,
          exit_status: 1,
          reasons: [`could not read observation baseline: ${String(error)}`],
          warnings: [],
          baseline_available: hasUsableBaseline,
          current_path: args.currentPath,
          previous_path: hasUsableBaseline ? args.previousPath! : null,
        });
        return 1;
      }
    }
    const result = evaluateHealthGate(current, previous, observationBaseline);
    for (const warning of result.warnings) console.warn(`health gate warning: ${warning}`);
    if (!result.ok) {
      console.error(`health gate blocked deployment: ${result.reasons.join("; ")}`);
      writeReport({
        ok: false,
        exit_status: 1,
        reasons: [...result.reasons],
        warnings: [...result.warnings],
        baseline_available: hasUsableBaseline,
        current_path: args.currentPath,
        previous_path: hasUsableBaseline ? args.previousPath! : null,
      });
      return 1;
    }
    const reportWritten = writeReport({
      ok: true,
      exit_status: 0,
      reasons: [],
      warnings: [...result.warnings],
      baseline_available: hasUsableBaseline,
      current_path: args.currentPath,
      previous_path: hasUsableBaseline ? args.previousPath! : null,
    });
    if (!reportWritten) return 1;
    if (args.lastKnownGoodPath) {
      writeFileSync(args.lastKnownGoodPath, `${JSON.stringify(current, null, 2)}\n`);
    }
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
      exit_status: 1,
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
