#!/usr/bin/env bash
# Fails when two goose migrations share a version number. Parallel branches
# each take the next free number; whichever merges second must renumber, or
# Core refuses to start ("duplicate version") on the deployed host.
set -euo pipefail

dir="${1:-$(dirname "${BASH_SOURCE[0]}")/../core/internal/database/migrations}"
versions=()
for path in "$dir"/*.sql; do
  name="$(basename "$path")"
  version="${name%%_*}"
  if ! [[ "$version" =~ ^[0-9]+$ ]]; then
    echo "migration without a numeric version: $name" >&2
    exit 1
  fi
  versions+=("$((10#$version)) $name")
done
duplicates="$(printf '%s\n' "${versions[@]}" | awk '{count[$1]++; names[$1]=names[$1] " " $2} END {for (v in count) if (count[v] > 1) print "version " v ":" names[v]}')"
if [[ -n "$duplicates" ]]; then
  echo "duplicate migration versions — renumber the later branch:" >&2
  echo "$duplicates" >&2
  exit 1
fi
echo "migration versions are unique (${#versions[@]} files)"
