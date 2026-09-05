#!/bin/zsh
set -euo pipefail

cd "${0:A:h}/.."
repro_dir=$(mktemp -d "${TMPDIR:-/tmp}/kamiyobi-repro.XXXXXX")
trap 'rm -rf -- "$repro_dir"' EXIT

for name in one two; do
  mkdir "$repro_dir/cache-$name"
  node src/cli.ts build --out "$repro_dir/$name" --offline --no-embeddings \
    --cache "$repro_dir/cache-$name" --now 2026-08-09T00:00:00Z
done
/usr/bin/diff -r --brief "$repro_dir/one" "$repro_dir/two"
print -r -- "byte-identical: fixed-clock offline public outputs"
