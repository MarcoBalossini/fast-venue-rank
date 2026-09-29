#!/usr/bin/env sh
# Render icons/*.png from the SVG sources (needs rsvg-convert).
# 16/32 use icon-small.svg (thicker strokes, no gradients) to stay legible in the toolbar.
set -e
cd "$(dirname "$0")/../icons"
for n in 16 32; do rsvg-convert -w $n -h $n icon-small.svg -o $n.png; done
for n in 48 128; do rsvg-convert -w $n -h $n icon.svg -o $n.png; done
