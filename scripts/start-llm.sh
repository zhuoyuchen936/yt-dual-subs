#!/bin/sh
# Start LM Studio's local server and preload the translation model.
# Preloading is optional: with the server running, the extension's first request loads the model
# on demand (about a second for Hy-MT2-1.8B) and LM Studio unloads it again once it has been idle.
set -e
MODEL="${1:-hy-mt2-1.8b}"
lms server start
lms load "$MODEL" --context-length 8192 --ttl 600 -y
echo "Ready: http://localhost:1234/v1  ($MODEL)"
