#!/bin/zsh
set -euo pipefail

cd "${0:A:h}/.."
repro_dir=$(mktemp -d "${TMPDIR:-/tmp}/kamiyobi-repro.XXXXXX")
source_dir="$repro_dir/source"
trap 'git worktree remove --force "$source_dir" >/dev/null 2>&1 || true; rm -rf -- "$repro_dir"' EXIT

git worktree add --detach "$source_dir" HEAD >/dev/null
ln -s "$PWD/node_modules" "$source_dir/node_modules"

for name in one two; do
  mkdir "$repro_dir/cache-$name"
  (
    cd "$source_dir"
    node src/cli.ts build --out "$repro_dir/$name" --offline \
      --cache "$repro_dir/cache-$name" --now 2026-08-09T00:00:00Z
  )
done
diff -r --brief "$repro_dir/one" "$repro_dir/two"
print -r -- "byte-identical: fixed-clock offline public outputs"
