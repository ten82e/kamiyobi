"""Run isolated headless browser checks on the completed integration archive."""
import json
import os
import shutil
import subprocess
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = repo / "work/agent-verification/integration"
tree = root / "tree"
checks = json.loads((root / "checks.json").read_text())
assert any(c["check"] == "health-gate" for c in checks), "Finish sequential integration checks first"
assert all(c["exit_code"] == 0 for c in checks if c["check"] in ["build", "public-validation", "health-gate"])
output = root / "browser"
output.mkdir(exist_ok=True)
scripts = output / "scripts"
scripts.mkdir(exist_ok=True)
server_log = (output / "server.log").open("w")
server = subprocess.Popen(["python3", "-m", "http.server", "8772", "--bind", "127.0.0.1", "--directory", str(tree / "public")], stdout=server_log, stderr=subprocess.STDOUT)
results = []
try:
    # The source checks remain byte-identical except their local test port.
    # Never alter the site's source, data, browser settings, or GUI.
    for mode in ["reduce", "no-preference"]:
        for name in ["compsac", "identity", "researcher", "updater"]:
            original = repo / f"scripts/agent-handoff/headless-{name}.mjs"
            script = scripts / original.name
            script.write_text(original.read_text().replace("127.0.0.1:8771/", "127.0.0.1:8772/"))
            env = dict(os.environ, KAMIYOBI_REDUCED_MOTION=mode, KAMIYOBI_OLD_LINK_INPUTS=str(root / "ui-old-link-inputs.json"))
            with (output / f"{name}-{mode}.log").open("w") as log:
                result = subprocess.run(["node", str(script)], cwd=tree, env=env, stdout=log, stderr=subprocess.STDOUT)
            source = tree / f"work/agent-verification/headless-{name}.json"
            if source.exists(): shutil.copyfile(source, output / f"{name}-{mode}.json")
            results.append({"check":name,"mode":mode,"exit_code":result.returncode})
            print(name, mode, result.returncode, flush=True)
    screenshots = tree / "work/agent-verification/screenshots"
    if screenshots.exists(): shutil.copytree(screenshots, output / "screenshots", dirs_exist_ok=True)
finally:
    server.terminate()
    server.wait(timeout=10)
    server_log.close()
(output / "checks.json").write_text(json.dumps(results, indent=2)+"\n")
raise SystemExit(1 if any(c["exit_code"] for c in results) else 0)
