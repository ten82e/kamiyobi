"""Verify integrated actual public assets using the isolated headless browser."""
import json
import os
import shutil
import subprocess
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / "work/agent-verification/main-integration"
checks = json.loads((root / "checks.json").read_text())
assert len(checks) == 14 and all(c["exit_code"] == 0 for c in checks), "Finish all actual-worktree checks first"
output = root / "browser"
output.mkdir(exist_ok=True)
old_inputs = repo / "work/agent-verification/integration/ui-old-link-inputs.json"
assert old_inputs.is_file(), "Keep the pre-integration legacy URL reference"
results = []
for mode in ["reduce", "no-preference"]:
    for name in ["compsac", "identity", "researcher", "updater"]:
        env = dict(os.environ, KAMIYOBI_REDUCED_MOTION=mode, KAMIYOBI_OLD_LINK_INPUTS=str(old_inputs))
        with (output / f"{name}-{mode}.log").open("w") as log:
            result = subprocess.run(["node", f"scripts/agent-handoff/headless-{name}.mjs"], cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT)
        source = repo / f"work/agent-verification/headless-{name}.json"
        if source.exists(): shutil.copyfile(source, output / f"{name}-{mode}.json")
        results.append({"check": name, "mode": mode, "exit_code": result.returncode, "actual_worktree": True})
        print(name, mode, result.returncode, flush=True)
    # Tests connect only to dedicated HeadlessChrome and localhost:8771,
    # whose existing HTTP server serves the actual repo/public directory.
screenshots = repo / "work/agent-verification/screenshots"
if screenshots.exists(): shutil.copytree(screenshots, output / "screenshots", dirs_exist_ok=True)
(output / "checks.json").write_text(json.dumps(results, indent=2) + "\n")
raise SystemExit(1 if any(r["exit_code"] for r in results) else 0)
