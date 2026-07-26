import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // Fast dev-time feedback for the same invariants Group B's grep tests
  // enforce authoritatively (test/static/static-analysis.test.ts). This
  // is redundant with those tests on purpose, not a replacement for
  // them: the checklist's Proof column stays a test.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'fs-touching code must go through sanitisePath in src/services/path-safety.ts. See docs/phase-1-checklist.md Group B.' },
            { name: 'node:fs', message: 'fs-touching code must go through sanitisePath in src/services/path-safety.ts. See docs/phase-1-checklist.md Group B.' },
            { name: 'fs/promises', message: 'fs-touching code must go through sanitisePath in src/services/path-safety.ts. See docs/phase-1-checklist.md Group B.' },
            { name: 'node:fs/promises', message: 'fs-touching code must go through sanitisePath in src/services/path-safety.ts. See docs/phase-1-checklist.md Group B.' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name='dirname']",
          message: 'Resolving relative to the agent module location is reserved for the agent\'s own bundled assets (constraint 2). See docs/phase-1-checklist.md Group B (B1).',
        },
        {
          selector: "MemberExpression[object.type='MetaProperty'][property.name='url']",
          message: 'Resolving relative to the agent module location is reserved for the agent\'s own bundled assets (constraint 2). See docs/phase-1-checklist.md Group B (B1).',
        },
        {
          selector: "Identifier[name='__dirname']",
          message: 'Resolving relative to the agent module location is reserved for the agent\'s own bundled assets (constraint 2). See docs/phase-1-checklist.md Group B (B1).',
        },
      ],
    },
  },
  // no-restricted-imports has no way to express the grep test's "OR
  // imports sanitisePath" escape hatch, so this list is broader than
  // just the reasoned site-root/agent-asset exemptions: it also covers
  // files verified to correctly gate fs access behind sanitisePath.
  {
    files: [
      'src/services/path-safety.ts',
      'src/services/theme-schemas.ts',
      'src/services/startup-checks.ts',
      'src/services/validation.ts',
      'src/services/drafts.ts',
      'src/services/publish.ts',
      'src/renderer/theme-templates.ts',
      'src/renderer/render-page.ts',
      'src/services/redirects.ts',
      'src/services/move.ts',
      'src/services/resolve-url.ts',
      'src/services/fs-walk.ts',
      'src/services/content-read.ts',
      'src/services/migration-runner.ts',
      'src/search/rebuild-index.ts',
      'src/server-config.ts',
      'src/routes/capabilities.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['src/services/validation.ts', 'src/services/startup-checks.ts', 'src/routes/capabilities.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
);
