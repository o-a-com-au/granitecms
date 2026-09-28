import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { SiteConfig } from '../config.ts';
import { createEngine } from '../renderer/engine.ts';
import type { ThemeState } from '../theme-state.ts';
import { listFilesRecursively } from './fs-walk.ts';
import type { CommitAuthor } from './git.ts';
import { commitPaths } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import { stripSchemaBlock } from './theme-component-file.ts';
import { enqueue } from './write-queue.ts';

// A theme file path, relative to theme/: folders and a file name, no dot
// segments and no hidden files (.DS_Store and the like are never part of
// a theme).
const THEME_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function isValidThemePath(path: string): boolean {
  return THEME_PATH.test(path);
}

export function hashThemeFile(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ThemeFileEntry {
  path: string;
  size: number;
  hash: string;
}

export function listThemeFiles(config: SiteConfig): ThemeFileEntry[] {
  return listFilesRecursively(config.themeRoot, config.themeRoot, '')
    .filter(isValidThemePath)
    .sort()
    .map((path) => {
      const full = sanitisePath(config.themeRoot, path);
      const bytes = readFileSync(full);
      return { path, size: statSync(full).size, hash: hashThemeFile(bytes) };
    });
}

export function readThemeFile(config: SiteConfig, path: string): Buffer | null {
  if (!isValidThemePath(path)) {
    return null;
  }
  const full = sanitisePath(config.themeRoot, path);
  return existsSync(full) ? readFileSync(full) : null;
}

export type ThemePushReason = 'invalid-path' | 'conflict' | 'invalid-liquid' | 'write-failed' | 'commit-failed' | 'rollback-failed';

export class ThemePushError extends Error {
  readonly reason: ThemePushReason;

  constructor(reason: ThemePushReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ThemePushError';
    this.reason = reason;
  }
}

export interface ThemeWrite {
  path: string;
  bytes: Buffer;
  // The hash the file had when the client last saw it, or null for a
  // file it expects not to exist yet.
  expected: string | null;
}

export interface ThemeDelete {
  path: string;
  expected: string;
}

export interface ThemePushResult {
  generation: number;
  // Theme components the reloaded theme had to leave out, the same
  // warnings a start-up prints - worth showing whoever pushed.
  warnings: string[];
}

function currentHash(path: string): string | null {
  return existsSync(path) ? hashThemeFile(readFileSync(path)) : null;
}

// Only syntax: a template that can't be parsed breaks every page using
// it, so it is refused. Anything that parses is left to render as the
// theme author wrote it. Parsed exactly as the site will: the agent's
// own engine settings, with any {% schema %} block removed first.
function checkLiquid(writes: ThemeWrite[]): void {
  const parser = createEngine({});
  for (const write of writes) {
    if (!write.path.endsWith('.liquid')) {
      continue;
    }
    try {
      parser.parse(stripSchemaBlock(write.bytes.toString('utf-8')));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ThemePushError('invalid-liquid', `theme/${write.path} is not valid Liquid: ${detail}`);
    }
  }
}

// Writes and deletes theme files as one change: every file is checked
// against what the client expected first (so a file changed on the site
// since the client last pulled it is never overwritten), then everything
// is written, committed once, and the running theme reloaded. If the
// commit fails, every file is put back as it was.
async function pushThemeJob(
  config: SiteConfig,
  theme: ThemeState,
  writes: ThemeWrite[],
  deletes: ThemeDelete[],
  message: string,
  author: CommitAuthor,
): Promise<ThemePushResult> {
  const all = [...writes.map((write) => write.path), ...deletes.map((entry) => entry.path)];
  for (const path of all) {
    if (!isValidThemePath(path)) {
      throw new ThemePushError('invalid-path', `Not a theme file path: ${JSON.stringify(path)}`);
    }
  }
  if (new Set(all).size !== all.length) {
    throw new ThemePushError('invalid-path', 'The same theme file appears more than once in one push');
  }

  mkdirSync(config.themeRoot, { recursive: true });
  const resolved = new Map(all.map((path) => [path, sanitisePath(config.themeRoot, path)]));

  const conflicts: string[] = [];
  for (const write of writes) {
    if (currentHash(resolved.get(write.path) as string) !== write.expected) {
      conflicts.push(write.path);
    }
  }
  for (const entry of deletes) {
    if (currentHash(resolved.get(entry.path) as string) !== entry.expected) {
      conflicts.push(entry.path);
    }
  }
  if (conflicts.length > 0) {
    throw new ThemePushError(
      'conflict',
      `Changed on the site since you last saw them: ${conflicts.map((path) => `theme/${path}`).join(', ')}`,
    );
  }

  checkLiquid(writes);

  const originals = new Map<string, Buffer | null>();
  for (const path of all) {
    const full = resolved.get(path) as string;
    originals.set(path, existsSync(full) ? readFileSync(full) : null);
  }

  function restore(): void {
    for (const [path, bytes] of originals) {
      const full = resolved.get(path) as string;
      if (bytes === null) {
        rmSync(full, { force: true });
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, bytes);
      }
    }
  }

  try {
    for (const write of writes) {
      const full = resolved.get(write.path) as string;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, write.bytes);
    }
    for (const entry of deletes) {
      rmSync(resolved.get(entry.path) as string, { force: true });
    }
  } catch (error) {
    restore();
    throw new ThemePushError('write-failed', 'Writing the theme failed; nothing was changed', { cause: error });
  }

  try {
    commitPaths(config.siteRoot, [...resolved.values()].map((full) => relative(config.siteRoot, full)), message, author);
  } catch (error) {
    try {
      restore();
    } catch (rollbackError) {
      throw new ThemePushError(
        'rollback-failed',
        'Committing the theme failed and putting it back also failed; theme/ needs manual inspection',
        { cause: rollbackError },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ThemePushError('commit-failed', `Committing the theme failed: ${detail}`, { cause: error });
  }

  const reloaded = theme.reload();
  return { generation: reloaded.generation, warnings: reloaded.themeSchemas.warnings ?? [] };
}

export function pushTheme(
  config: SiteConfig,
  theme: ThemeState,
  writes: ThemeWrite[],
  deletes: ThemeDelete[],
  message: string,
  author: CommitAuthor,
): Promise<ThemePushResult> {
  return enqueue(() => pushThemeJob(config, theme, writes, deletes, message, author));
}
