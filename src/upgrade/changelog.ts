// Versions are plain x.y.z here: the package never publishes
// pre-releases, and anything else is treated as not comparable.
export function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    return a.localeCompare(b);
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (x[index] as number) - (y[index] as number);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

// Below 1.0.0, a minor bump (0.5 -> 0.6) may break things, as a major
// bump would above it.
export function mayBreak(from: string, to: string): boolean {
  const x = parseVersion(from);
  const y = parseVersion(to);
  if (!x || !y) {
    return true;
  }
  return x[0] !== y[0] || (x[0] === 0 && x[1] !== y[1]);
}

export interface ChangelogSection {
  version: string;
  text: string;
}

// The CHANGELOG.md sections after `from`, up to and including `to`,
// newest first - what an upgrade from one to the other brings.
export function changesBetween(changelog: string, from: string, to: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  const headings = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*$/gm)];
  headings.forEach((heading, index) => {
    const version = heading[1] as string;
    if (compareVersions(version, from) <= 0 || compareVersions(version, to) > 0) {
      return;
    }
    const start = (heading.index as number) + heading[0].length;
    const end = index + 1 < headings.length ? (headings[index + 1]?.index as number) : changelog.length;
    sections.push({ version, text: changelog.slice(start, end).trim() });
  });
  return sections;
}
