// A running site's /v1/ API, as pull-site and push-site talk to it.

export type SiteSyncReason =
  | 'not-a-site'
  | 'unauthorised'
  | 'newer-schema'
  | 'older-live-schema'
  | 'uncommitted-changes'
  | 'fetch-failed'
  | 'unsafe-path'
  | 'no-sync-record'
  | 'different-site'
  | 'conflicts'
  | 'missing-media'
  | 'rejected'
  | 'no-author';

export class SiteSyncError extends Error {
  readonly reason: SiteSyncReason;

  constructor(reason: SiteSyncReason, message: string) {
    super(message);
    this.name = 'SiteSyncError';
    this.reason = reason;
  }
}

export interface RemoteSiteOptions {
  fetchImpl?: typeof fetch;
  // How long to wait when the site says to slow down (429) and gives no
  // Retry-After. Injectable so tests don't sit out a real wait.
  sleep?: (ms: number) => Promise<void>;
  onWait?: (seconds: number) => void;
}

// Write routes on a site are rate limited (60 a minute by default), and
// a push can make more requests than that - one per image. A 429 is
// waited out, not treated as a failure.
const MAX_RATE_LIMIT_WAITS = 20;

export class RemoteSite {
  readonly siteUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onWait: (seconds: number) => void;

  constructor(siteUrl: string, token: string, options: RemoteSiteOptions = {}) {
    this.siteUrl = siteUrl;
    this.token = token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onWait = options.onWait ?? (() => {});
  }

  private url(path: string): URL {
    return new URL(path, this.siteUrl);
  }

  private async request(
    method: string,
    path: string,
    { auth = true, body, headers = {} }: { auth?: boolean; body?: string | FormData; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.url(path), {
          method,
          headers: { ...(auth ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
          body,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new SiteSyncError('fetch-failed', `Could not reach ${this.url(path).toString()}: ${detail}`);
      }
      if (response.status === 429 && attempt < MAX_RATE_LIMIT_WAITS) {
        const seconds = Math.max(1, Number(response.headers.get('retry-after')) || 5);
        this.onWait(seconds);
        await this.sleep(seconds * 1000);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new SiteSyncError(
          'unauthorised',
          `The live site rejected the token (${response.status}). It needs the "content" and "media" scopes.`,
        );
      }
      return response;
    }
  }

  async get(path: string, { auth = true, allow404 = false } = {}): Promise<Response | null> {
    const response = await this.request('GET', path, { auth });
    if (allow404 && response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new SiteSyncError('fetch-failed', `GET ${path} returned ${response.status}`);
    }
    return response;
  }

  async getJson(path: string, options: { auth?: boolean } = {}): Promise<unknown> {
    const response = await this.get(path, options);
    try {
      return await (response as Response).json();
    } catch {
      throw new SiteSyncError('fetch-failed', `GET ${path} did not return JSON`);
    }
  }

  async getBytes(path: string, options: { auth?: boolean; allow404?: boolean } = {}): Promise<Buffer | null> {
    const response = await this.get(path, options);
    return response === null ? null : Buffer.from(await response.arrayBuffer());
  }

  // Like getBytes, plus the ETag a later write must present as If-Match
  // (or as a batch draft-write's expectedEtag).
  async getFile(path: string): Promise<{ bytes: Buffer; etag: string } | null> {
    const response = await this.get(path, { allow404: true });
    if (response === null) {
      return null;
    }
    return { bytes: Buffer.from(await response.arrayBuffer()), etag: response.headers.get('etag') ?? '' };
  }

  // A JSON write. A refusal from the site (4xx) is reported with the
  // site's own message: a validation failure or conflict is something
  // the person pushing needs to read, not a status code.
  async sendJson(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await this.request(method, path, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
    });
    return this.readWriteResult(method, path, response);
  }

  async upload(path: string, filename: string, bytes: Buffer): Promise<unknown> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), filename);
    const response = await this.request('POST', path, { body: form });
    return this.readWriteResult('POST', path, response);
  }

  private async readWriteResult(method: string, path: string, response: Response): Promise<unknown> {
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const message =
        parsed !== null && typeof parsed === 'object' && typeof (parsed as { message?: unknown }).message === 'string'
          ? (parsed as { message: string }).message
          : `${method} ${path} returned ${response.status}`;
      throw new SiteSyncError('rejected', message);
    }
    return parsed;
  }
}
