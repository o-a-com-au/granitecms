import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuthError, requireScope, verifyToken } from '../../src/services/token-auth.ts';
import type { TokenEntry } from '../../src/server-config.ts';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const CONTENT_TOKEN = 'content-token-value';
const THEME_TOKEN = 'theme-token-value';

const tokens: TokenEntry[] = [
  { hash: hashOf(CONTENT_TOKEN), scopes: ['content'] },
  { hash: hashOf(THEME_TOKEN), scopes: ['theme'] },
];

test('verifyToken returns the matching entry\'s scopes for a known token', () => {
  assert.deepEqual(verifyToken(tokens, CONTENT_TOKEN), ['content']);
  assert.deepEqual(verifyToken(tokens, THEME_TOKEN), ['theme']);
});

test('verifyToken returns null for an unknown token', () => {
  assert.equal(verifyToken(tokens, 'not-a-real-token'), null);
});

test('verifyToken returns null when no tokens are configured (fails closed, not open)', () => {
  assert.equal(verifyToken([], CONTENT_TOKEN), null);
});

test('requireScope throws AuthError(missing-token, 401) when no Authorization header is present', async () => {
  const guard = requireScope(tokens, 'content');
  await assert.rejects(
    guard({ headers: {} } as never),
    (error: unknown) => error instanceof AuthError && error.reason === 'missing-token' && error.statusCode === 401,
  );
});

test('requireScope throws AuthError(missing-token, 401) when the header is not a Bearer token', async () => {
  const guard = requireScope(tokens, 'content');
  await assert.rejects(
    guard({ headers: { authorization: 'Basic dXNlcjpwYXNz' } } as never),
    (error: unknown) => error instanceof AuthError && error.reason === 'missing-token',
  );
});

test('requireScope throws AuthError(invalid-token, 401) for a token that matches nothing configured', async () => {
  const guard = requireScope(tokens, 'content');
  await assert.rejects(
    guard({ headers: { authorization: 'Bearer not-a-real-token' } } as never),
    (error: unknown) => error instanceof AuthError && error.reason === 'invalid-token' && error.statusCode === 401,
  );
});

test('requireScope throws AuthError(missing-scope, 403) for a valid token lacking the required scope', async () => {
  const guard = requireScope(tokens, 'theme');
  await assert.rejects(
    guard({ headers: { authorization: `Bearer ${CONTENT_TOKEN}` } } as never),
    (error: unknown) => error instanceof AuthError && error.reason === 'missing-scope' && error.statusCode === 403,
  );
});

test('requireScope resolves without throwing for a valid, correctly-scoped token', async () => {
  const guard = requireScope(tokens, 'content');
  await assert.doesNotReject(guard({ headers: { authorization: `Bearer ${CONTENT_TOKEN}` } } as never));
});
