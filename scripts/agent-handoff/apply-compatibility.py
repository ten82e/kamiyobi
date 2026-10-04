"""Apply the reviewed compatibility overlay only to a prepared integration archive."""
import gzip
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
root = Path(os.environ.get("KAMIYOBI_INTEGRATION_ROOT", str(repo / "work/agent-verification/integration"))).resolve()
assert root.is_relative_to(repo / "work/agent-verification"), "Archive must stay in the ignored verification directory"
tree = root / "tree"
assert tree.is_dir() and not (tree / ".git").exists()
prep = json.loads((root / "preparation.json").read_text())
artifacts = repo / "docs/agent-handoff/candidates"
manifest = json.loads((artifacts / "updater-compatibility-manifest.json").read_text())
assert prep["incoming_revision"] == manifest["candidate_revision"]
sha = lambda content: hashlib.sha256(content).hexdigest()
packed = (artifacts / "updater-compatibility.patch.gz").read_bytes()
assert sha(packed) == manifest["gzip_sha256"]
patch = gzip.decompress(packed)
assert sha(patch) == manifest["patch_sha256"]
records = manifest["files"]
actual = {r["path"]: sha((tree / r["path"]).read_bytes()) for r in records}
if all(actual[r["path"]] == r["target_sha256"] for r in records):
    (root / "compatibility.json").write_text(json.dumps({"ui_revision": prep["ui_revision"], "manifest": "docs/agent-handoff/candidates/updater-compatibility-manifest.json", "files": records, "all_target_hashes_verified": True, "status": "already-applied"}, indent=2) + "\n")
    print("Reviewed compatibility overlay already applied; all target hashes match")
    raise SystemExit(0)
for r in records:
    assert actual[r["path"]] == r["base_sha256"], f"Unexpected input: {r['path']}"
env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(root))
with tempfile.NamedTemporaryFile(suffix=".patch", dir=root) as temporary:
    temporary.write(patch)
    temporary.flush()
    for arguments in [["--check"], []]:
        subprocess.run(["git", "apply", "--no-index", *arguments, temporary.name], cwd=tree, env=env, check=True)
for r in records:
    assert sha((tree / r["path"]).read_bytes()) == r["target_sha256"], r["path"]
(root / "compatibility.json").write_text(json.dumps({"ui_revision": prep["ui_revision"], "manifest": "docs/agent-handoff/candidates/updater-compatibility-manifest.json", "files": records, "all_target_hashes_verified": True}, indent=2) + "\n")
print("Reviewed compatibility overlay applied to archive only; all target hashes match")
