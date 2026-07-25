import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpSite {
  siteRoot: string;
  cleanup: () => void;
}

// A real directory outside the repo (mkdtemp under os.tmpdir()), never a
// checked-in fixture: a symlink pointing outside the repo doesn't belong
// in git history, and this also proves config loading doesn't secretly
// depend on being run from inside this repo.
export function createTmpSiteRoot(options: { git?: boolean } = {}): TmpSite {
  const siteRoot = mkdtempSync(join(tmpdir(), 'cms-agent-test-'));

  if (options.git) {
    execFileSync('git', ['init', '--quiet'], { cwd: siteRoot });
  }

  return {
    siteRoot,
    cleanup: () => rmSync(siteRoot, { recursive: true, force: true }),
  };
}
