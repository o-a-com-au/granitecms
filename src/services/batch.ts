import type { SiteConfig } from '../config.ts';
import { DraftError, prepareDiscardDraft, prepareSaveDraft } from './drafts.ts';
import { DeleteContentError, prepareDeleteContent } from './delete-content.ts';
import type { CommitAuthor } from './git.ts';
import { commitPaths } from './git.ts';
import { MoveError, prepareMovePage } from './move.ts';
import { PublishError, preparePublishDrafts } from './publish.ts';
import type { PreparedOperation } from './prepared-operation.ts';
import type { ThemeSchemas } from './validation.ts';
import { enqueue } from './write-queue.ts';

export type BatchOperation =
  | { type: 'draft-write'; path: string; content: unknown; expectedEtag: string }
  | { type: 'draft-discard'; path: string }
  | { type: 'content-delete'; path: string; redirectTo?: string }
  | { type: 'move'; from: string; to: string };

export interface BatchPublish {
  relativePaths: string[];
}

export type BatchReason =
  // draft-write
  | 'validation-failed'
  | 'conflict'
  // content-delete
  | 'page-not-found'
  | 'has-children'
  | 'redirect-cycle'
  // move
  | 'source-not-found'
  | 'destination-exists'
  // publish (the optional trailing step)
  | 'draft-not-found'
  | 'duplicate-path'
  // shared
  | 'write-failed'
  | 'commit-failed'
  | 'rollback-failed';

export class BatchError extends Error {
  readonly reason: BatchReason;
  // Which part of the batch failed. operationIndex indexes into the
  // operations array; the trailing publish step is a distinct stage,
  // not folded into that same index space (index 3 could otherwise
  // ambiguously mean "the 4th operation" or "there were only 3
  // operations, so this must be publish").
  readonly stage?: 'operation' | 'publish';
  readonly operationIndex?: number;

  constructor(
    reason: BatchReason,
    message: string,
    options?: { cause?: unknown; stage?: 'operation' | 'publish'; operationIndex?: number },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'BatchError';
    this.reason = reason;
    this.stage = options?.stage;
    this.operationIndex = options?.operationIndex;
  }
}

// No whole-batch duplicate-path pre-check: rejected in design review.
// publishDrafts's own internal duplicate check exists because its
// rollback restores multiple snapshots in *forward* order within a
// single call - a real hazard specific to that shape. Undo across
// batch *operations* runs in *reverse* chronological order instead
// (see batchJob below), which composes correctly even when multiple
// operations touch the same path (e.g. move A->B then content-delete
// B in the same batch unwinds correctly: undo delete restores B to
// what move wrote, then undo move renames B back to A). Genuine
// conflicts (two moves to the same destination, etc.) are already
// caught fresh by each sub-service's own real-time validation when it
// runs, precisely because processing is sequential.
async function runOperation(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  operation: BatchOperation,
): Promise<PreparedOperation> {
  switch (operation.type) {
    case 'draft-write':
      return prepareSaveDraft(config, themeSchemas, operation.path, operation.content, operation.expectedEtag);
    case 'draft-discard':
      return prepareDiscardDraft(config, operation.path);
    case 'content-delete':
      return prepareDeleteContent(config, operation.path, operation.redirectTo);
    case 'move':
      return prepareMovePage(config, operation.from, operation.to);
  }
}

function reasonFromError(error: unknown): BatchReason | undefined {
  if (
    error instanceof DraftError ||
    error instanceof DeleteContentError ||
    error instanceof MoveError ||
    error instanceof PublishError
  ) {
    return error.reason;
  }
  return undefined;
}

async function batchJob(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  operations: BatchOperation[],
  publish: BatchPublish | undefined,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  const allPaths: string[] = [];
  const undoStack: Array<() => unknown[]> = [];

  // Sequential, not two-phase validate-then-write: operations can be
  // order-dependent within a single batch (e.g. write a draft, then
  // publish that same draft, in one call) - a later step's validation
  // may depend on an earlier step's write having already happened.
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index] as BatchOperation;
    try {
      const prepared = await runOperation(config, themeSchemas, operation);
      allPaths.push(...prepared.paths);
      undoStack.push(prepared.undo);
    } catch (error) {
      await rollbackAndThrow(undoStack, error, { stage: 'operation', operationIndex: index });
    }
  }

  if (publish) {
    try {
      const prepared = preparePublishDrafts(config, themeSchemas, publish.relativePaths);
      allPaths.push(...prepared.paths);
      undoStack.push(prepared.undo);
    } catch (error) {
      await rollbackAndThrow(undoStack, error, { stage: 'publish' });
    }
  }

  // A batch of pure draft-write/draft-discard operations legitimately
  // produces zero git-tracked paths (drafts are never git-tracked).
  // git commit with nothing staged exits non-zero ("nothing to
  // commit") - verified empirically - which would otherwise produce a
  // spurious commit-failed (or a spurious full rollback) for a batch
  // that did nothing wrong. Skip the commit entirely when there is
  // nothing to stage.
  if (allPaths.length === 0) {
    return;
  }

  try {
    commitPaths(config.siteRoot, allPaths, message, author);
  } catch (error) {
    await rollbackAndThrow(undoStack, error, {});
  }
}

// Runs every already-succeeded operation's undo, in reverse order,
// then throws. Never returns normally - always throws either
// BatchError('rollback-failed') (if any undo itself failed) or a
// BatchError carrying the original failure's own reason.
async function rollbackAndThrow(
  undoStack: Array<() => unknown[]>,
  cause: unknown,
  context: { stage?: 'operation' | 'publish'; operationIndex?: number },
): Promise<never> {
  const failures: unknown[] = [];
  for (const undo of [...undoStack].reverse()) {
    failures.push(...undo());
  }

  if (failures.length > 0) {
    throw new BatchError(
      'rollback-failed',
      'Batch failed and rolling back afterwards also failed; the working tree may be inconsistent and needs manual inspection',
      { cause, ...context },
    );
  }

  const reason = reasonFromError(cause);
  if (reason) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new BatchError(reason, `Batch failed: ${detail}`, { cause, ...context });
  }

  // context.stage is only ever set when this was called from the
  // operations/publish loop, never from the post-loop commitPaths call
  // below - so a non-domain error reaching here (e.g. PathSafetyError
  // thrown by sanitisePath deep inside a prepareX function) came from
  // there too. Rethrow it as-is rather than mislabelling it
  // 'commit-failed': callers up the stack (the route's own
  // PathSafetyError check) need to see the original error type.
  if (context.stage) {
    throw cause;
  }

  // No stage means this can only have come from the commitPaths call
  // just above, which only ever throws GitOperationError.
  const detail = cause instanceof Error ? cause.message : String(cause);
  throw new BatchError('commit-failed', `Batch failed: ${detail}`, { cause, ...context });
}

export function runBatch(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  operations: BatchOperation[],
  publish: BatchPublish | undefined,
  message: string,
  author: CommitAuthor,
): Promise<void> {
  return enqueue(() => batchJob(config, themeSchemas, operations, publish, message, author));
}
