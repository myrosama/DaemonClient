#!/usr/bin/env bash
# Regenerates GoogleSans.woff2 from the full GoogleSans.ttf variable font.
# Keeps every variation axis (opsz, wght, GRAD) and limits glyphs to
# Latin, Latin Extended and Cyrillic (Uzbek Latin + Russian/Uzbek Cyrillic).
#
# Requires: pip install 'fonttools[woff]' (fonttools + brotli)
set -euo pipefail

dir="$(cd "$(dirname "$0")/.." && pwd)/src/lib/assets/fonts/GoogleSans"

unicodes=(
  U+0000-00FF
  U+0100-024F
  U+0250-02FF
  U+0300-036F
  U+0400-052F
  U+1E00-1EFF
  U+2000-206F
  U+2070-209F
  U+20A0-20CF
  U+2100-214F
  U+2190-21FF
  U+2212,U+2215
  U+2C60-2C7F
  U+A720-A7FF
  U+FEFF,U+FFFD
)

pyftsubset "$dir/GoogleSans.ttf" \
  --unicodes="$(printf '%s,' "${unicodes[@]}" | sed 's/,$//')" \
  --layout-features='*' \
  --flavor=woff2 \
  --output-file="$dir/GoogleSans.woff2"
