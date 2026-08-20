import { existsSync, readFileSync } from "node:fs";
import { evaluateHealthGate, type HealthReport } from "../src/build.ts";

const [currentPath, previousPath] = process.argv.slice(2);
if (!currentPath) {
  console.error("usage: node scripts/health-gate.ts <current-health.json> [last-known-good.json]");
  process.exit(2);
}

const current = JSON.parse(readFileSync(currentPath, "utf8")) as HealthReport;
const previous =
  previousPath && existsSync(previousPath)
    ? (JSON.parse(readFileSync(previousPath, "utf8")) as HealthReport)
    : null;
const result = evaluateHealthGate(current, previous);
if (!result.ok) {
  console.error(`health gate blocked deployment: ${result.reasons.join("; ")}`);
  process.exit(1);
}
console.log(
  previous ? "health gate passed against last-known-good" : "health gate passed without baseline",
);
