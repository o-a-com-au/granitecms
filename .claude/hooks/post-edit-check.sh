#!/usr/bin/env bash
# Fires after every Edit or Write tool call.
# Keep this FAST: typecheck and lint only. The full test suite runs in the Stop gate.
# Exit code 2 feeds stderr back to Claude as a blocking error it must address.

set -uo pipefail

# Only run if this is a Node project with the expected scripts
if [ ! -f package.json ]; then
  exit 0
fi

ERRORS=""

if npm run --silent typecheck > /tmp/typecheck.log 2>&1; then
  :
else
  ERRORS+="TYPECHECK FAILED:\n$(tail -n 40 /tmp/typecheck.log)\n\n"
fi

if npm run --silent lint > /tmp/lint.log 2>&1; then
  :
else
  ERRORS+="LINT FAILED:\n$(tail -n 40 /tmp/lint.log)\n\n"
fi

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS" >&2
  echo "Fix these before continuing. Do not disable rules or weaken tsconfig to silence them." >&2
  exit 2
fi

exit 0
