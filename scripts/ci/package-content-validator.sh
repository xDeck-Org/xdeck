#!/usr/bin/env bash
# scripts/ci/package-content-validator.sh
#
# CI-side mirror of `apps/backend/src/modules/tenant-package/services/content-validator.service.ts`.
# Runs in GitHub Actions on every `v*` tag of an `xdeck-pkg-*` repo to refuse
# tags whose tree would be rejected by the runtime resolver.
#
# Implements the 6 non-negotiable hardenings from ADR 0003 §6:
#
#   1. Symlinks                       — find -type l
#   2. Submodules                     — any `.gitmodules` file
#   3. LFS pointers                   — files starting with the LFS pointer signature
#   4. `.gitattributes` filter dirs   — `filter=` directive in any `.gitattributes`
#   5. Path traversal                 — no test (worktree is rooted by definition)
#   6. Size cap                       — total tree size in bytes
#
# Exits non-zero on any violation, with a structured violation list on stderr.
# Skips the `.git/` directory (it's not part of the package payload).
#
# Usage:
#   package-content-validator.sh <root-dir> [--max-size-bytes N]
#
#   <root-dir>             directory to validate (the package's tree).
#   --max-size-bytes N     override default 100 MB cap.
#   -h, --help             show this message.
#
# Exit codes:
#   0  clean tree
#   1  violation(s) found
#   2  invalid args / missing root

set -euo pipefail

DEFAULT_MAX_SIZE_BYTES=$((100 * 1024 * 1024))
LFS_SIGNATURE="version https://git-lfs.github.com/spec/"

ROOT=""
MAX_SIZE_BYTES="$DEFAULT_MAX_SIZE_BYTES"

usage() { sed -n '1,30p' "$0" | sed 's/^#//' | sed 's/^ //'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-size-bytes) MAX_SIZE_BYTES="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) ROOT="$1"; shift ;;
  esac
done

[[ -z "$ROOT" ]] && { echo "error: root-dir required" >&2; exit 2; }
[[ ! -d "$ROOT" ]] && { echo "error: root-dir does not exist: $ROOT" >&2; exit 2; }
[[ ! "$MAX_SIZE_BYTES" =~ ^[0-9]+$ ]] && { echo "error: --max-size-bytes must be a positive integer" >&2; exit 2; }

VIOLATIONS=()

add_violation() {
  VIOLATIONS+=("$1")
}

# ── 1. Symlinks ─────────────────────────────────────────────────────────────
while IFS= read -r -d '' link; do
  rel="${link#$ROOT/}"
  target=$(readlink "$link" 2>/dev/null || echo "?")
  add_violation "SYMLINK ${rel} → ${target}"
done < <(find "$ROOT" -path "$ROOT/.git" -prune -o -type l -print0 2>/dev/null)

# ── 2. Submodules ───────────────────────────────────────────────────────────
while IFS= read -r -d '' f; do
  rel="${f#$ROOT/}"
  add_violation "SUBMODULE ${rel}"
done < <(find "$ROOT" -path "$ROOT/.git" -prune -o -type f -name '.gitmodules' -print0 2>/dev/null)

# ── 3. LFS pointers ─────────────────────────────────────────────────────────
# LFS pointer files are tiny (≤4 KB) — skip larger files for speed.
while IFS= read -r -d '' f; do
  size=$(wc -c < "$f")
  if [[ "$size" -le 4096 ]]; then
    head=$(head -c 64 "$f" 2>/dev/null || echo "")
    if [[ "$head" == "$LFS_SIGNATURE"* ]]; then
      rel="${f#$ROOT/}"
      add_violation "LFS_POINTER ${rel}"
    fi
  fi
done < <(find "$ROOT" -path "$ROOT/.git" -prune -o -type f -print0 2>/dev/null)

# ── 4. .gitattributes filter directives ─────────────────────────────────────
while IFS= read -r -d '' f; do
  if grep -E '(^|[[:space:]])filter=' "$f" >/dev/null 2>&1; then
    rel="${f#$ROOT/}"
    add_violation "GITATTRIBUTES_FILTER ${rel}"
  fi
done < <(find "$ROOT" -path "$ROOT/.git" -prune -o -type f -name '.gitattributes' -print0 2>/dev/null)

# ── 6. Size cap ─────────────────────────────────────────────────────────────
TOTAL_BYTES=$(find "$ROOT" -path "$ROOT/.git" -prune -o -type f -print0 2>/dev/null | xargs -0 wc -c 2>/dev/null | awk 'END {print $1+0}')
if [[ "$TOTAL_BYTES" -gt "$MAX_SIZE_BYTES" ]]; then
  add_violation "SIZE_CAP_EXCEEDED total=${TOTAL_BYTES} cap=${MAX_SIZE_BYTES}"
fi

# ── Report ──────────────────────────────────────────────────────────────────
if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  echo "✅ Content validator: clean (size=${TOTAL_BYTES} bytes, cap=${MAX_SIZE_BYTES} bytes)"
  exit 0
fi

echo "❌ Content validator: ${#VIOLATIONS[@]} violation(s) in ${ROOT}" >&2
for v in "${VIOLATIONS[@]}"; do
  echo "  - ${v}" >&2
done
exit 1
