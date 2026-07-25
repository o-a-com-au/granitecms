import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { sanitisePath } from './path-safety.ts';
import type { ThemeSchemas } from './validation.ts';
import { validatePage } from './validation.ts';
import { enqueue } from './write-queue.ts';

export type DraftReason = 'validation-failed';

export class DraftError extends Error {
  readonly reason: DraftReason;

  constructor(reason: DraftReason, message: string) {
    super(message);
    this.name = 'DraftError';
    this.reason = reason;
  }
}

async function saveDraftJob(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePath: string,
  content: unknown,
): Promise<void> {
  const draftPath = sanitisePath(config.draftsRoot, relativePath);

  // Validate before touching disk at all, so a validation failure
  // writes nothing (checklist C3) structurally, not via cleanup.
  const result = validatePage(content, themeSchemas);
  if (!result.valid) {
    throw new DraftError(
      'validation-failed',
      `Draft at "${relativePath}" failed validation: ${JSON.stringify(result.errors)}`,
    );
  }

  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, JSON.stringify(content, null, 2));
  // No git call: saves are cheap and frequent, and never create history
  // (checklist C2, constraint 5).
}

async function discardDraftJob(config: SiteConfig, relativePath: string): Promise<void> {
  const draftPath = sanitisePath(config.draftsRoot, relativePath);
  // Idempotent, matching DELETE semantics: silently succeed if the
  // draft is already absent rather than inventing a not-found error
  // the checklist doesn't ask for.
  if (existsSync(draftPath)) {
    unlinkSync(draftPath);
  }
  // No git call: discard never touches /content/ or history.
}

export function saveDraft(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  relativePath: string,
  content: unknown,
): Promise<void> {
  return enqueue(() => saveDraftJob(config, themeSchemas, relativePath, content));
}

export function discardDraft(config: SiteConfig, relativePath: string): Promise<void> {
  return enqueue(() => discardDraftJob(config, relativePath));
}
