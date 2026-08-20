import localtunnel from 'localtunnel';

// localtunnel pulls in an old axios version with known high-severity
// advisories (SSRF/prototype-pollution class issues, see `npm audit`).
// Accepted, not ignored: this is an opt-in, dev-only feature (never on
// the request-handling path), and axios here only ever talks to the
// hardcoded localtunnel.me registration endpoint, never
// attacker-controlled input. No pure-JS, no-native-binary alternative
// without the same class of stale-dependency trade-off was found.
export interface DevTunnel {
  url: string;
  close: () => void;
}

export async function startDevTunnel(port: number): Promise<DevTunnel> {
  const tunnel = await localtunnel({ port });
  return { url: tunnel.url, close: () => tunnel.close() };
}
