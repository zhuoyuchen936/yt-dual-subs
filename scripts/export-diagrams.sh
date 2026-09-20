#!/bin/sh
# Regenerate the draw.io sources and export the PNGs the README embeds.
# The PNGs carry their diagram XML (-e), so dropping one onto app.diagrams.net opens it for editing.
# Needs the draw.io desktop CLI (`brew install --cask drawio`). REPAIR_PNG is optional: some draw.io
# builds write the embedded-XML chunk in a way strict PNG readers reject; the drawio skill's
# repair_png.py fixes that.
set -e
cd "$(dirname "$0")/.."
python3 scripts/make-diagrams.py
for f in overlay how-it-works sentence-groups lookahead; do
  drawio -x -f png -e -s 2 -b 16 -o "docs/diagrams/$f.drawio.png" "docs/diagrams/$f.drawio" >/dev/null 2>&1
  [ -n "$REPAIR_PNG" ] && python3 "$REPAIR_PNG" "docs/diagrams/$f.drawio.png"
  echo "exported docs/diagrams/$f.drawio.png"
done
