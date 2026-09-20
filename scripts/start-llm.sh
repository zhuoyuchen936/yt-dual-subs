#!/bin/sh
# Start LM Studio's local server and load the translation model.
# The model unloads itself after an hour idle (--ttl) to give the ~19 GB of memory back.
set -e
MODEL="${1:-qwen/qwen3.6-35b-a3b}"
lms server start
lms load "$MODEL" --context-length 8192 --ttl 3600 -y
echo "Ready: http://localhost:1234/v1  ($MODEL)"
