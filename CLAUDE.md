# CLAUDE.md - cms-agent

## What this project is

A self-hosted, git-backed CMS agent, distributed as a compiled npm package. The full build plan is in `docs/cms-build-plan.md` and is the source of truth for architecture decisions. Read it before starting any phase. The current phase's acceptance criteria live in `docs/phase-1-checklist.md` (and later `phase-2-checklist.md`, etc.).

## Non-negotiable constraints (do not relitigate these in code)

1. Content is JSON files on disk, git-tracked. No database is ever the source of truth.
2. The agent NEVER assumes it lives inside a site repo. The site root always comes from configuration. Any code that resolves paths relative to the agent's own location instead of the configured site root is a bug.
3. Search lives in a derived, disposable SQLite index, rebuilt by walking content files. Never write to the index as if it were authoritative.
4. Every content file carries `schemaVersion`. Any change to a content shape requires a migration function, never a manual edit convention.
5. Save writes drafts without committing. Publish is the only routine operation that creates a git commit. Do not add commits to other paths without discussing it first.
6. All disk and git mutations go through the single in-process write queue. No route handler touches the filesystem or git directly.
7. Path sanitisation on every `:path` parameter: resolve, then confirm the result sits inside the content or drafts root, before ANY filesystem operation. This is the project's number one security concern.

## Working rules

- Propose a plan and get confirmation before implementing anything that spans more than one module.
- Keep architecture decisions in the lead thread. Delegate mechanical, well-scoped tasks (writing tests for a finished module, docs) to subagents.
- Small, reviewable increments. Commit at each green checkpoint with a clear message. Never batch a day of work into one commit.
- Never use `--force` with git, never rewrite history, never commit directly to main if a branch workflow is in place.
- TypeScript strict mode stays on. Do not weaken tsconfig to make errors go away.
- Dependencies: minimal by policy (this ships as a package third parties install). Justify any new dependency in the commit message. Prefer Node built-ins.
- Use `node:sqlite` behind the driver interface as the default. Do not import better-sqlite3 anywhere outside the optional driver implementation.
- No dynamically registered Liquid tags or filters. Ever.
- Australian English in all comments, docs, and user-facing strings. No em dashes or en dashes anywhere.

## Definition of done for any task

A task is not done until:
1. `npm run typecheck` passes
2. `npm run lint` passes
3. `npm test` passes, including tests for the new behaviour
4. The relevant items in the current phase checklist are ticked with a pointer to the test that proves each one

The Stop hook enforces 1 to 3 automatically. Do not attempt to work around it; if the gate is failing, the work is not finished.

## When unsure

If the plan document is ambiguous or silent on something structural, stop and ask rather than inventing. Flag it as a question, propose two options with trade-offs, and wait.
