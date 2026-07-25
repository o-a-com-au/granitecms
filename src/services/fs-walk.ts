import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

// Recursively lists files matching extension under dir, returned as
// paths relative to base. Agent-configured roots only (content/drafts
// roots, theme directories), never a request-supplied :path - callers
// that walk request-shaped paths must go through sanitisePath instead.
export function listFilesRecursively(dir: string, base: string, extension: string): string[] {
  let out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listFilesRecursively(full, base, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(relative(base, full));
    }
  }
  return out;
}
