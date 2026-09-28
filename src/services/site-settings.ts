import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';
import { CURRENT_SCHEMA_VERSION } from '../migrations/index.ts';
import { computeEtag, etagsMatch } from './etag.ts';
import type { CommitAuthor } from './git.ts';
import { commitPaths } from './git.ts';
import { sanitisePath } from './path-safety.ts';
import { validateSiteSettings, type ThemeSchemas } from './validation.ts';
import { enqueue } from './write-queue.ts';

// Site settings: values for the fields the theme defines in
// theme/config/site_settings.json, stored as content in
// content/settings.json - { schemaVersion, settings: {...} } - so editors
// change them in the admin and they travel with content. Like menus
// they have no draft state: a save is committed and live at once
// (confirmed with the owner, matching how Shopify's theme settings save).

export type SiteSettings = Record<string, unknown>;

export function siteSettingsPath(config: SiteConfig): string {
  return sanitisePath(config.contentRoot, 'settings.json');
}

export interface StoredSiteSettings {
  settings: SiteSettings;
  // null when there is no settings.json yet.
  etag: string | null;
}

// A settings.json that isn't a readable object counts as empty rather
// than breaking every page: settings only ever fill in a theme's
// defaults, and the admin shows the file's problem when it's saved.
export function readSiteSettings(config: SiteConfig): StoredSiteSettings {
  const path = siteSettingsPath(config);
  if (!existsSync(path)) {
    return { settings: {}, etag: null };
  }
  const bytes = readFileSync(path);
  let settings: SiteSettings = {};
  try {
    const parsed = JSON.parse(bytes.toString('utf-8')) as { settings?: unknown };
    if (typeof parsed.settings === 'object' && parsed.settings !== null && !Array.isArray(parsed.settings)) {
      settings = parsed.settings as SiteSettings;
    }
  } catch {
    settings = {};
  }
  return { settings, etag: computeEtag(bytes) };
}

// What templates see as `settings`: every setting the theme defines,
// with its default where nothing has been saved. Only the theme's own
// settings - a saved value for a setting the theme no longer defines is
// left out.
export function resolveSiteSettings(config: SiteConfig, themeSchemas: ThemeSchemas): SiteSettings {
  return resolveSiteSettingsFrom(readSiteSettings(config).settings, themeSchemas);
}

// The same, from values given rather than read from disk: the preview
// of settings an editor has changed but not saved yet.
export function resolveSiteSettingsFrom(saved: SiteSettings, themeSchemas: ThemeSchemas): SiteSettings {
  const properties = (themeSchemas.settings as { properties?: Record<string, { default?: unknown }> } | undefined)?.properties;
  if (!properties) {
    return {};
  }
  const resolved: SiteSettings = {};
  for (const [name, property] of Object.entries(properties)) {
    if (name in saved) {
      resolved[name] = saved[name];
    } else if (property && typeof property === 'object' && 'default' in property) {
      resolved[name] = property.default;
    }
  }
  return resolved;
}

// For the render cache: pages depend on settings like they depend on
// menus, so a save must make every cached page stale. 0 when there is
// no settings.json.
export function siteSettingsMtimeMs(config: SiteConfig): number {
  try {
    return statSync(siteSettingsPath(config)).mtimeMs;
  } catch {
    return 0;
  }
}

export type SaveSiteSettingsReason = 'validation-failed' | 'conflict' | 'commit-failed' | 'rollback-failed';

export class SaveSiteSettingsError extends Error {
  readonly reason: SaveSiteSettingsReason;
  readonly errors: Array<{ path: string; message: string }>;

  constructor(reason: SaveSiteSettingsReason, message: string, errors: Array<{ path: string; message: string }> = [], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveSiteSettingsError';
    this.reason = reason;
    this.errors = errors;
  }
}

async function saveSiteSettingsJob(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  settings: unknown,
  expectedEtag: string,
  message: string,
  author: CommitAuthor,
): Promise<string> {
  // Checked inside the queued job, never before it (the same TOCTOU
  // reasoning as drafts.ts and manage-menus.ts). No file yet means
  // nothing to conflict with.
  const current = readSiteSettings(config);
  if (current.etag !== null && !etagsMatch(current.etag, expectedEtag)) {
    throw new SaveSiteSettingsError('conflict', 'The site settings changed since you opened them');
  }

  const result = validateSiteSettings(settings, themeSchemas);
  if (!result.valid) {
    throw new SaveSiteSettingsError(
      'validation-failed',
      `Site settings failed validation: ${result.errors.map((error) => `${error.path || '/'} ${error.message}`).join('; ')}`,
      result.errors,
    );
  }

  const path = siteSettingsPath(config);
  const before = existsSync(path) ? readFileSync(path) : null;
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, settings }, null, 2)}\n`);
  writeFileSync(path, bytes);

  try {
    commitPaths(config.siteRoot, [path], message, author);
  } catch (error) {
    try {
      if (before === null) {
        unlinkSync(path);
      } else {
        writeFileSync(path, before);
      }
    } catch (rollbackError) {
      throw new SaveSiteSettingsError(
        'rollback-failed',
        'Saving the site settings failed and putting them back also failed; content/settings.json needs manual inspection',
        [],
        { cause: rollbackError },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new SaveSiteSettingsError('commit-failed', `Saving the site settings failed: ${detail}`, [], { cause: error });
  }
  return computeEtag(bytes);
}

export function saveSiteSettings(
  config: SiteConfig,
  themeSchemas: ThemeSchemas,
  settings: unknown,
  expectedEtag: string,
  message: string,
  author: CommitAuthor,
): Promise<string> {
  return enqueue(() => saveSiteSettingsJob(config, themeSchemas, settings, expectedEtag, message, author));
}
