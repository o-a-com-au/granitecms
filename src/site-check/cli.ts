#!/usr/bin/env node
import { resolve } from 'node:path';
import { runSiteCheck } from './run-check.ts';
import type { CheckFinding, CheckFindingKind } from './run-check.ts';

// Run from vhost/ (see the scaffold's own "check" script), so the
// site root is one level up - the exact same relative relationship
// SERVER_JS in create-site/generate-site.ts already relies on.
const siteRoot = resolve(process.cwd(), '..');

const KIND_LABELS: Record<CheckFindingKind, string> = {
  schema: 'Theme schema',
  'render-error': 'Render error',
  'missing-asset': 'Missing asset',
  'broken-link': 'Broken link',
};

function printGrouped(findings: CheckFinding[]): void {
  const byKind = new Map<CheckFindingKind, CheckFinding[]>();
  for (const finding of findings) {
    const list = byKind.get(finding.kind) ?? [];
    list.push(finding);
    byKind.set(finding.kind, list);
  }
  for (const [kind, list] of byKind) {
    console.log(`\n${KIND_LABELS[kind]} (${list.length}):`);
    for (const finding of list) {
      const location = finding.pageUrl ? `  ${finding.pageUrl}: ` : '  ';
      console.log(`${location}${finding.message}`);
    }
  }
}

const result = await runSiteCheck(siteRoot);

if (result.ok) {
  console.log('No problems found.');
  process.exit(0);
}

console.log(`${result.findings.length} problem${result.findings.length === 1 ? '' : 's'} found:`);
printGrouped(result.findings);
process.exit(1);
