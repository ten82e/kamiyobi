"""Prepare a three-way integration archive without a branch, checkout, or clone."""
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
manifest = json.loads((repo / "docs/agent-handoff/candidates/updater-manifest.json").read_text())
incoming = manifest["candidate"]

def git(*args):
    return subprocess.check_output(["git", *args], cwd=repo)

def blob(revision, name):
    result = subprocess.run(["git", "show", f"{revision}:{name}"], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout if result.returncode == 0 else b""

def sha(content):
    return hashlib.sha256(content).hexdigest()

head = git("rev-parse", "HEAD").decode().strip()
base = git("merge-base", head, incoming).decode().strip()
root = Path(os.environ.get("KAMIYOBI_INTEGRATION_ROOT", str(repo / "work/agent-verification/integration"))).resolve()
assert root.is_relative_to(repo / "work/agent-verification"), "Archive must stay in ignored verification directory"
tree = root / "tree"
if tree.exists() and (root / "preparation.json").exists():
    raise SystemExit("Integration archive already exists; preserve it and inspect its manifest before preparing again.")
tree.mkdir(parents=True, exist_ok=True)
archive = git("archive", head)
with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
    tar.extractall(tree, filter="data")
protected = json.loads((repo / "docs/agent-handoff/verification/latest.json").read_text())["protected_paths_sha256"]
for name, expected in protected.items():
    content = (repo / name).read_bytes()
    if sha(content) != expected:
        raise SystemExit(f"Protected input changed: {name}")
    (tree / name).parent.mkdir(parents=True, exist_ok=True)
    (tree / name).write_bytes(content)
shutil.copytree(repo / ".cache", tree / ".cache", dirs_exist_ok=True, ignore=shutil.ignore_patterns("*profile*", "*chrome*"))
if not (tree / "node_modules").exists():
    (tree / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
changed = git("diff", "--name-only", base, incoming).decode().splitlines()
records = []
for name in changed:
    before = blob(base, name)
    after = blob(incoming, name)
    target = tree / name
    current = target.read_bytes() if target.exists() else b""
    status = "identical" if current == after else "unchanged-incoming" if before == after else "applied" if before == current else "three-way"
    target.parent.mkdir(parents=True, exist_ok=True)
    if status == "applied":
        target.write_bytes(after)
    elif status == "three-way":
        inputs = root / "merge-inputs" / name
        inputs.mkdir(parents=True, exist_ok=True)
        for key, content in [("current", current), ("base", before), ("incoming", after)]:
            (inputs / key).write_bytes(content)
        result = subprocess.run(["git", "merge-file", "--diff3", "-p", "-L", "UI-archive", "-L", "shared-base", "-L", "updater-candidate", str(inputs / "current"), str(inputs / "base"), str(inputs / "incoming")], cwd=root, stdout=subprocess.PIPE)
        if not 0 <= result.returncode <= 127:
            raise SystemExit(f"Merge failed for {name}: {result.returncode}")
        target.write_bytes(result.stdout)
        if result.returncode:
            status = "conflict"
    records.append({"path": name, "status": status, "base_sha256": sha(before), "current_sha256": sha(current), "incoming_sha256": sha(after), "prepared_sha256": sha(target.read_bytes())})
report = {"ui_revision": head, "shared_base": base, "incoming_revision": incoming, "main_prerequisite_revision": manifest["base"], "new_branch_worktree_clone": False, "actual_working_files_modified": False, "archive": "work/agent-verification/integration/tree", "protected_inputs": protected, "changes": records, "conflicts": [r["path"] for r in records if r["status"] == "conflict"], "git_ceiling_directories": str(root)}
(root / "preparation.json").write_text(json.dumps(report, indent=2) + "\n")
# Retain real pre-integration legacy URL inputs for the later browser probe.
# Public generated data only; no raw snapshots or personal documents are sent.
catalog = json.loads((repo / "public/catalog.json").read_text())
old_links = []
for conference in catalog["conferences"]:
    if conference["key"] not in ["evomusart", "evomusart-2027", "ecir", "ecir2027", "wsdm"]: continue
    for edition in conference["editions"]:
        if edition["year"] != 2027: continue
        for deadline in edition["deadlines"]:
            if deadline["kind"] not in ["paper", "abstract"]: continue
            old_links.append({
                "key":conference["key"], "id":edition["id"], "year":edition["year"],
                "kind":deadline["kind"], "round":deadline["round"], "label":deadline["label"],
                "track":deadline.get("track", ""), "utc":deadline.get("utc"),
                "earliest_utc":deadline.get("earliest_utc"), "local_date":deadline.get("local_date"),
            })
(root / "ui-old-link-inputs.json").write_text(json.dumps(old_links, indent=2) + "\n")
print(json.dumps({"shared_base": base, "incoming_files": len(changed), "conflicts": report["conflicts"]}, indent=2))
