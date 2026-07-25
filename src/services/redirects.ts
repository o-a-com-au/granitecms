import { readFileSync } from 'node:fs';
import type { SiteConfig } from '../config.ts';

export type RedirectReason = 'redirect-cycle';

export class RedirectError extends Error {
  readonly reason: RedirectReason;

  constructor(reason: RedirectReason, message: string) {
    super(message);
    this.name = 'RedirectError';
    this.reason = reason;
  }
}

export type RedirectMap = Record<string, string>;

// redirectsPath is agent-configured site data (a fixed top-level file),
// never a request-supplied :path. Graceful-empty on any read/parse
// failure, matching theme-schemas.ts's established pattern.
export function loadRedirects(config: SiteConfig): RedirectMap {
  try {
    return JSON.parse(readFileSync(config.redirectsPath, 'utf-8')) as RedirectMap;
  } catch {
    return {};
  }
}

// Collapses chains at write time. Walks `to` forward through any
// existing chain to its final destination (not just one hop), then
// rewrites every existing entry that pointed at the just-added `from`
// to point at that final destination too, so old entries stay
// collapsed alongside the new one.
export function addRedirect(redirects: RedirectMap, from: string, to: string): RedirectMap {
  let target = to;
  const visited = new Set<string>();

  for (;;) {
    const next = redirects[target];
    if (next === undefined) {
      break;
    }
    if (visited.has(target)) {
      throw new RedirectError(
        'redirect-cycle',
        `redirects.json already contains a cycle reachable from "${to}"`,
      );
    }
    visited.add(target);
    target = next;
  }

  // The walk above only detects a cycle among *pre-existing* entries.
  // A walk that terminates normally can still resolve back to `from`
  // itself (e.g. adding "/b" -> "/a" when "/a" -> "/b" already exists:
  // the walk hits "/b", which has no further mapping, and stops without
  // revisiting anything) - that's a self-referential redirect, checked
  // separately here.
  if (target === from) {
    throw new RedirectError(
      'redirect-cycle',
      `Adding redirect "${from}" -> "${to}" would create a cycle (resolves back to "${from}")`,
    );
  }

  const updated: RedirectMap = { ...redirects, [from]: target };
  for (const key of Object.keys(updated)) {
    if (updated[key] === from) {
      updated[key] = target;
    }
  }
  return updated;
}

export function removeRedirectForPath(redirects: RedirectMap, url: string): RedirectMap {
  if (!(url in redirects)) {
    return redirects;
  }
  const updated = { ...redirects };
  delete updated[url];
  return updated;
}
