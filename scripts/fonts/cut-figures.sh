#!/usr/bin/env bash
# Re-cut the figures faces (public/fonts/figures) from the self-hosted IBM Plex Sans files: the ten digits
# U+0030-0039 only, unhinted, WOFF2. The `zero` OpenType feature is the only one kept, because `.font-id`
# (styles/globals.css) asks for slashed-zero and a face without it paints the plain zero.
#
#   scripts/fonts/cut-figures.sh [--no-zero] [OUT_DIR]     OUT_DIR defaults to public/fonts/figures
#
# --no-zero cuts the face as it was before the slashed zero was kept (no layout features). It reproduces the old
# files byte for byte (git show 17550063b^:public/fonts/figures/...) and exists so the font-id painted-glyph
# test in tests/e2e/golden-paths/o3-banner-titles.spec.ts can be shown red. Needs fonttools + brotli (pyftsubset).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
features="zero"
if [ "${1:-}" = "--no-zero" ]; then features=""; shift; fi
out="${1:-$root/public/fonts/figures}"
mkdir -p "$out"

for weight in Regular Medium SemiBold; do
  pyftsubset "$root/public/fonts/IBMPlexSans-$weight.woff2" \
    --unicodes=U+0030-0039 --layout-features="$features" --no-hinting --flavor=woff2 \
    --output-file="$out/IBMPlexSans-Digits-$weight.woff2"
done
