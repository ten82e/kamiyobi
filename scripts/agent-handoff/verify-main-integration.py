"""Verify updater integration in the actual worktree, preserving source snapshots."""
import json
import subprocess
import time
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / "work/agent-verification/main-integration"
root.mkdir(parents=True, exist_ok=True)
commands = [
    ("typecheck", ["npm", "run", "typecheck"]),
    ("lint", ["npm", "run", "check"]),
    ("fixed-build", ["node", "src/cli.ts", "build", "--out", "public", "--offline", "--no-embeddings", "--cache", ".cache", "--now", "2026-08-09T00:00:00Z"]),
    ("tests", ["npm", "test", "--", "--maxWorkers=4"]),
    ("fixed-validation", ["npm", "run", "validate:data", "--", "public/data.json"]),
    ("fixed-health", ["npm", "run", "health-gate"]),
    ("semantic-recommendation", ["node", "src/bench-recommender.ts", "--v2", "tests/fixtures/bench-v2.json", "--json"]),
    ("recommendation-data-delta", ["node", "src/bench-recommender.ts", "--data-delta", "tests/fixtures/recommendation-data-delta.json", "--json"]),
    ("real-paper-recommendation", ["node", "src/bench-recommender.ts", "--data", "public/data.json", "--real-v2-dev", "data/benchmarks/real-paper-required-dev.json", "--real-v2-heldout", "data/benchmarks/real-paper-required-heldout.json", "--real-v2-negative", "data/benchmarks/real-paper-negative.json", "--real-v2-features", "data/benchmarks/real-paper-features.jsonl", "--real-v2-feature-baseline", "data/benchmarks/real-paper-feature-baseline.json", "--real-v2-small", "--json"]),
    ("build", ["npm", "run", "build", "--", "--no-embeddings"]),
    ("data-validation", ["npm", "run", "validate:data"]),
    ("public-validation", ["npm", "run", "validate:data", "--", "public/data.json"]),
    ("health-gate", ["npm", "run", "health-gate"]),
    ("diff-check", ["git", "diff", "--check"]),
]
protected_paths = [repo / "data/snapshot.json", *(repo / "data/source-snapshots").glob("*.json")]
protected = {p: p.read_bytes() for p in protected_paths}
results = []
for name, command in commands:
    start = time.monotonic()
    with (root / (name + ".log")).open("w") as output:
        try:
            result = subprocess.run(command, cwd=repo, stdout=output, stderr=subprocess.STDOUT)
        finally:
            if name == "build":
                for p in (repo / "data/source-snapshots").glob("*.json"):
                    if p not in protected: p.unlink()
                for p, content in protected.items(): p.write_bytes(content)
    results.append({"check": name, "exit_code": result.returncode, "seconds": round(time.monotonic() - start, 2)})
    (root / "checks.json").write_text(json.dumps(results, indent=2) + "\n")
    print(name, result.returncode, flush=True)
    if result.returncode: raise SystemExit(result.returncode)
