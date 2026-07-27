// Shared by publish.ts/move.ts/delete-content.ts/drafts.ts's prepare*
// exports and batch.ts's orchestration: "do the writes for one
// operation, stop before committing, hand back what's needed to stage
// it and what's needed to undo it." Lets batch.ts accumulate paths
// across a heterogeneous sequence of operations and commit exactly
// once, while each service keeps full ownership of its own on-disk
// layout and rollback details.
export interface PreparedOperation {
  // Paths needing staging in the eventual single commit. Empty for
  // operations that never touch git-tracked files (draft writes/
  // discards - drafts are never git-tracked).
  paths: string[];
  // Reverses this operation's writes. Returns accumulated rollback
  // failures (empty array = fully restored), matching the existing
  // rollback() functions' own contract - never throws itself.
  undo: () => unknown[];
}
