#!/usr/bin/env bash
set -euo pipefail

archive=reactivecore-multidb-v0.2.0-alpha.1-linux-amd64.tar.gz
sha256=623b7d959d767a33b52c2512ec00b936ed59282f7efed4584729c41348013c88
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
curl --fail --location --silent --show-error --retry 2 --max-time 180 \
  "https://github.com/herimalala-ranaivoarisoa-rivomanana/reactivecore-multidb/releases/download/v0.2.0-alpha.1/$archive" \
  --output "$scratch/$archive"
(cd "$scratch" && printf '%s  %s\n' "$sha256" "$archive" | sha256sum --check -)
docker load --input "$scratch/$archive"
