import json
import subprocess
import time
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / "work/agent-verification"
root.mkdir(parents=True, exist_ok=True)
commands = [
    ("typecheck", ["npm", "run", "typecheck"]),
    ("lint", ["npm", "run", "check"]),
    ("fixed-build", ["node", "src/cli.ts", "build", "--out", "public", "--offline", "--no-embeddings", "--cache", ".cache", "--now", "2026-08-09T00:00:00Z"]),
    ("tests", ["npm", "test"]),
    ("fixed-validation", ["npm", "run", "validate:data", "--", "public/data.json"]),
    ("fixed-health", ["npm", "run", "health-gate"]),
    ("build", ["npm", "run", "build", "--", "--no-embeddings"]),
    ("data-validation", ["npm", "run", "validate:data"]),
    ("public-validation", ["npm", "run", "validate:data", "--", "public/data.json"]),
    ("health-gate", ["npm", "run", "health-gate"]),
    ("diff-check", ["git", "diff", "--check"]),
]
results = []
protected_paths = [repo / 'data/snapshot.json', *(repo / 'data/source-snapshots').glob('*.json')]
protected = {path: path.read_bytes() for path in protected_paths}
for name, command in commands:
    start = time.monotonic()
    with (root / ("final-" + name + ".log")).open("w") as output:
        try:
            result = subprocess.run(command, cwd=repo, stdout=output, stderr=subprocess.STDOUT)
        finally:
            if name == "build":
                for path in (repo / 'data/source-snapshots').glob('*.json'):
                    if path not in protected: path.unlink()
                for path, content in protected.items():
                    path.write_bytes(content)

    results.append({"check": name, "exit_code": result.returncode, "seconds": round(time.monotonic() - start, 2)})
    (root / "checks.json").write_text(json.dumps(results, indent=2))
    print(name, result.returncode, flush=True)
    if result.returncode:
        raise SystemExit(result.returncode)
