"""Verify the prepared archive; never apply its source to the actual worktree."""
import json
import os
import sys
import subprocess
import time
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / "work/agent-verification/integration"
tree = root / "tree"
# An archive has no Git metadata. Only readonly HEAD reads in its exact root
# are routed to the original immutable UI revision; temporary git-init tests
# keep their own repositories. No GIT_DIR or shared index is used.
prep = json.loads((root / "preparation.json").read_text())
tools = root / "tools"
tools.mkdir(exist_ok=True)
adapter = tools / "git"
adapter.write_text("#!/usr/bin/env python3\n" +
    "import os,sys\n" +
    f"tree={str(tree)!r}\nrepo={str(repo)!r}\nrevision={prep['ui_revision']!r}\n" +
    "args=sys.argv[1:]\n" +
    "if os.getcwd()==tree and len(args)==2 and args[0]=='show' and args[1].startswith('HEAD:'):\n" +
    " args=['--git-dir='+repo+'/.git','show',revision+':'+args[1][5:]]\n" +
    "os.execv('/usr/bin/git',['git',*args])\n")
adapter.chmod(0o755)
env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(root), PATH=str(tools) + os.pathsep + os.environ["PATH"])
commands = [
    ("typecheck", ["npm", "run", "typecheck"]),
    ("lint", ["npm", "run", "check"]),
    ("fixed-build", ["node", "src/cli.ts", "build", "--out", "public", "--offline", "--no-embeddings", "--cache", ".cache", "--now", "2026-08-09T00:00:00Z"]),
    ("tests", ["npm", "test"]),
    ("fixed-validation", ["npm", "run", "validate:data", "--", "public/data.json"]),
    ("fixed-health", ["npm", "run", "health-gate"]),
    ("semantic-recommendation", ["node", "src/bench-recommender.ts", "--v2", "tests/fixtures/bench-v2.json", "--json"]),
    ("recommendation-data-delta", ["node", "src/bench-recommender.ts", "--data-delta", "tests/fixtures/recommendation-data-delta.json", "--json"]),
    ("real-paper-recommendation", ["node", "src/bench-recommender.ts", "--data", "public/data.json", "--real-v2-dev", "data/benchmarks/real-paper-required-dev.json", "--real-v2-heldout", "data/benchmarks/real-paper-required-heldout.json", "--real-v2-negative", "data/benchmarks/real-paper-negative.json", "--real-v2-features", "data/benchmarks/real-paper-features.jsonl", "--real-v2-feature-baseline", "data/benchmarks/real-paper-feature-baseline.json", "--real-v2-small", "--json"]),
    ("build", ["npm", "run", "build", "--", "--no-embeddings"]),
    ("data-validation", ["npm", "run", "validate:data"]),
    ("public-validation", ["npm", "run", "validate:data", "--", "public/data.json"]),
    ("health-gate", ["npm", "run", "health-gate"]),
]
protected_paths = [tree / "data/snapshot.json", *(tree / "data/source-snapshots").glob("*.json")]
protected = {p: p.read_bytes() for p in protected_paths}
results = []
for name, command in commands:
    start = time.monotonic()
    with (root / (name + ".log")).open("w") as output:
        try:
            result = subprocess.run(command, cwd=tree, env=env, stdout=output, stderr=subprocess.STDOUT)
        finally:
            if name == "build":
                for p in (tree / "data/source-snapshots").glob("*.json"):
                    if p not in protected: p.unlink()
                for p, content in protected.items(): p.write_bytes(content)
    results.append({"check": name, "exit_code": result.returncode, "seconds": round(time.monotonic() - start, 2)})
    (root / "checks.json").write_text(json.dumps(results, indent=2) + "\n")
    print(name, result.returncode, flush=True)
raise SystemExit(1 if any(r["exit_code"] for r in results) else 0)
