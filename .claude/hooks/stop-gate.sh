#!/usr/bin/env bash
# Fires when Claude attempts to finish responding.
# Exit code 2 blocks completion and forces Claude back into a work loop
# with the failure output as context. This is the enforcement layer for
# "done means green", per CLAUDE.md.
#
# Escape hatch: if no source files changed since the last run of this gate,
# pass immediately so pure Q&A turns are not punished with a test run.

set -uo pipefail

if [ ! -f package.json ]; then
  exit 0
fi

STAMP=".claude/.stop-gate-stamp"

# Skip the gate when nothing under src/ or test/ changed since last green pass
if [ -f "$STAMP" ]; then
  CHANGED=$(find src test -type f -newer "$STAMP" 2>/dev/null | head -n 1)
  if [ -z "$CHANGED" ]; then
    exit 0
  fi
fi

ERRORS=""

if npm run --silent typecheck > /tmp/gate-typecheck.log 2>&1; then
  :
else
  ERRORS+="TYPECHECK FAILED:\n$(tail -n 40 /tmp/gate-typecheck.log)\n\n"
fi

if npm run --silent lint > /tmp/gate-lint.log 2>&1; then
  :
else
  ERRORS+="LINT FAILED:\n$(tail -n 40 /tmp/gate-lint.log)\n\n"
fi

if npm test --silent > /tmp/gate-test.log 2>&1; then
  :
else
  ERRORS+="TESTS FAILED:\n$(tail -n 60 /tmp/gate-test.log)\n\n"
fi

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS" >&2
  echo "The task is not done until typecheck, lint, and tests all pass. Continue working." >&2
  exit 2
fi

touch "$STAMP"
exit 0
