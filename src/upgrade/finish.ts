import { loadSiteConfig } from '../config.ts';
import { SCAFFOLD_SCRIPTS, SERVER_JS, TEMPLATE_ROOT } from '../create-site/generate-site.ts';
import { CURRENT_SCHEMA_VERSION, migrations } from '../migrations/index.ts';
import { CHECKPOINT_AUTHOR } from '../services/checkpoint.ts';
import { MigrationError, runMigrations } from '../services/migration-runner.ts';
import { loadThemeSchemas } from '../services/theme-schemas.ts';
import { runSiteCheck, type CheckResult } from '../site-check/run-check.ts';
import { refreshOwnedFiles, type OwnedFileResult } from './owned-files.ts';

export interface FinishUpgradeResult {
  files: OwnedFileResult[];
  // Content files updated to the current content format.
  migrated: string[];
  // Why content couldn't be updated, if it couldn't: the update is all
  // or nothing, so no content file was changed. The CMS's own files and
  // the new version are in place regardless.
  migrationProblem: string | null;
  check: CheckResult;
}

// The second half of npm run upgrade, always run by the version just
// installed - so each version brings its own files and content changes,
// which the version upgraded from couldn't have known about. Nothing is
// committed: the developer reviews and commits, as after a pull.
export async function finishUpgrade(siteRoot: string): Promise<FinishUpgradeResult> {
  const files = refreshOwnedFiles(siteRoot, { templateRoot: TEMPLATE_ROOT, serverJs: SERVER_JS, scripts: SCAFFOLD_SCRIPTS });
  const config = loadSiteConfig(siteRoot);
  let migrated: string[] = [];
  let migrationProblem: string | null = null;
  try {
    migrated = await runMigrations(
      config,
      loadThemeSchemas(config.themeRoot),
      migrations,
      CURRENT_SCHEMA_VERSION,
      CHECKPOINT_AUTHOR,
      { commit: false },
    );
  } catch (error) {
    if (!(error instanceof MigrationError)) {
      throw error;
    }
    migrationProblem = error.message;
  }
  const check = await runSiteCheck(siteRoot);
  return { files, migrated, migrationProblem, check };
}
