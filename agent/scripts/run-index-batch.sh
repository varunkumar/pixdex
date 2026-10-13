#!/bin/bash
# Runs the resumable batch indexer. Safe to start any number of times: a lock
# keeps it to one run, and progress lives in agent/.index-state/queue.json.
#
#   scripts/run-index-batch.sh /Volumes/T9/Varun/Photos "/Volumes/T7Shield/Varun/Bandipur (12,13,14-Sep-2026)"
set -u
cd "$(dirname "$0")/.."
mkdir -p .index-state

# Ollama has to be up; the batch itself also waits for it, so a slow start is fine.
if ! curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  if command -v ollama >/dev/null 2>&1; then
    nohup ollama serve >> .index-state/ollama.log 2>&1 &
  fi
fi

# caffeinate -i keeps the Mac from idle-sleeping while the batch runs.
exec caffeinate -i npm run --silent dev -- index-batch "$@"
