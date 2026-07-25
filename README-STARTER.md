# cms-agent starter kit

Drop these files into the root of the new cms-agent repository. What each piece does and how to get running:

## Contents

```
CLAUDE.md                              project instructions Claude Code loads every session
.claude/settings.json                  wires the hooks below to lifecycle events
.claude/hooks/post-edit-check.sh       after every edit: typecheck + lint (fast)
.claude/hooks/stop-gate.sh             when Claude tries to finish: full test suite, blocks on red
.claude/hooks/guard-dangerous-commands.sh  before any bash command: deny list (force push, hard reset, npm publish, etc.)
.claude/agents/plan-reviewer.md        read-only code/architecture reviewer subagent
.claude/agents/page-reviewer.md        rendered-output reviewer subagent (needs the fixture site + renderer to exist)
docs/phase-1-checklist.md              Phase 1 acceptance criteria as provable assertions
```

Also copy `cms-build-plan-v3.md` into `docs/` so CLAUDE.md's references resolve.

## Setup

1. `chmod +x .claude/hooks/*.sh`
2. Ensure `package.json` defines the scripts the hooks call: `typecheck` (tsc --noEmit), `lint`, and `test`. The hooks exit quietly if package.json is absent, so they will not fight you during initial scaffolding.
3. Add `.claude/.stop-gate-stamp` to `.gitignore`.
4. Run `/hooks` inside Claude Code once to confirm the hooks registered, and `/agents` to confirm both subagents are listed.

## Verify against current docs

Hook schemas and subagent frontmatter evolve. Before first use, ask Claude Code itself to verify `.claude/settings.json` and the agent frontmatter against the current documentation (it has a built-in docs lookup), or check https://code.claude.com/docs/en/sub-agents and the hooks reference. In particular confirm: exit code 2 is still the blocking convention for Stop and PreToolUse hooks, and the `tools` frontmatter syntax for scoped Bash permissions.

## The working loop

1. Start a session, state which checklist group is in scope (one or two groups per session, no more).
2. Claude proposes a plan for the group; confirm or adjust before any code is written.
3. Claude implements. Post-edit hook keeps typecheck and lint green continuously; the Stop gate refuses to let a turn end with failing tests.
4. Claude fills in the Proof column of the checklist as tests land. An empty Proof cell means not done, whatever the code looks like.
5. End of session: invoke `@plan-reviewer` on the diff. Address or explicitly accept its findings.
6. You read the diff yourself between sessions. Commit history should show one commit per green checkpoint.
7. Once the renderer exists, add `@page-reviewer` to the end-of-session ritual whenever rendering behaviour changed.

## Deliberately not automated

- `npm publish` is on the deny list. Releasing the package is a human action.
- The reviewer subagents report; they never fix. Fixes go back through the lead thread so you see them.
- Nothing merges or pushes without you. The kit enforces quality, not autonomy over the repo's history.
