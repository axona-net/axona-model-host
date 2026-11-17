#!/bin/bash
# start.sh — start the alert-bot runner DETACHED on the test machine.
#   runner/start.sh <path to axona-relay/src/mcp.js> <requester signer, 64 hex> [min gap ms]
# Stop it:  touch ~/.axona/alertbot-runner.stop   (it finishes a run in progress, then leaves)
set -u
MCP="${1:?path to the MCP server script}"; REQ="${2:?the requester signer, 64 hex}"; GAP="${3:-180000}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"; DIR="$HOME/.axona"; mkdir -p "$DIR"
if pgrep -f "alertbot-runner.mjs" > /dev/null; then echo "already running pid=$(pgrep -f alertbot-runner.mjs | tr '\n' ' ')"; exit 0; fi
rm -f "$DIR/alertbot-runner.stop"
RUNNER_MCP="$MCP" RUNNER_REQUESTER="$REQ" RUNNER_MIN_GAP_MS="$GAP" RUNNER_OPERATOR="${RUNNER_OPERATOR:-}" \
  nohup node "$HERE/runner/alertbot-runner.mjs" >> "$DIR/alertbot-runner.out" 2>&1 < /dev/null &
echo "started pid=$! log=$DIR/alertbot-runner.jsonl"
