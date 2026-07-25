#!/usr/bin/env bash
# Fires before any Bash tool call. Reads the tool input JSON from stdin
# and blocks a small set of commands that should never run in this repo,
# regardless of what the model decides. Exit code 2 blocks the call and
# returns stderr to Claude as the reason.

set -uo pipefail

INPUT=$(cat)
CMD=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*:[[:space:]]*"//; s/"$//')

# Nothing parsed, allow (fail open on parsing, the deny list below is a
# backstop, not the only line of defence)
if [ -z "$CMD" ]; then
  exit 0
fi

DENY_PATTERNS=(
  "git push --force"
  "git push -f"
  "git reset --hard"
  "git rebase"
  "git filter-branch"
  "rm -rf /"
  "rm -rf ~"
  "rm -rf \."
  "npm publish"
)

for PATTERN in "${DENY_PATTERNS[@]}"; do
  if echo "$CMD" | grep -qF "$PATTERN"; then
    echo "Blocked by policy: '$PATTERN' is not allowed in this repo. History is never rewritten, publishing is a deliberate human action. See CLAUDE.md." >&2
    exit 2
  fi
done

exit 0
