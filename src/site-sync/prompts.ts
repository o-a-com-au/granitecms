// Asks questions on the terminal - the live site's address, then its
// API token without showing it. A token typed on the command line (or
// in CMS_TOKEN=... before it) ends up in shell history; typed here, it
// goes nowhere but this process.

export interface PromptInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  on: (event: 'data' | 'end', listener: (chunk?: string) => void) => unknown;
  removeAllListeners: (event: 'data' | 'end') => unknown;
  pause: () => unknown;
  resume: () => unknown;
}

export interface PromptOutput {
  write: (text: string) => unknown;
}

export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelledError';
  }
}

export interface Prompter {
  ask: (question: string, options?: { hidden?: boolean }) => Promise<string>;
}

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

// One prompter per input, shared by every question, because input that
// arrives faster than it is asked for (two piped lines in one chunk, or
// a line typed ahead) has to be kept for the next question rather than
// thrown away with the first answer.
//
// In a terminal, a hidden question switches echo off (raw mode) before
// it is shown - never after, or anything typed or pasted the instant it
// appears is echoed in the gap (seen for real in a pty test) - and
// handles Enter, Backspace and Ctrl+C itself. A visible question leaves
// the terminal's own line editing alone. Without a terminal (input
// piped in), each line answers the next question.
export function createPrompter(input: PromptInput, output: PromptOutput): Prompter {
  const interactive = input.isTTY === true && typeof input.setRawMode === 'function';
  let buffered = '';
  let ended = false;
  input.setEncoding('utf8');

  function ask(question: string, { hidden = false } = {}): Promise<string> {
    const raw = interactive && hidden;
    if (raw) {
      input.setRawMode?.(true);
    }
    output.write(question);

    return new Promise((resolve, reject) => {
      let answer = '';

      function finish(error?: Error): void {
        input.removeAllListeners('data');
        input.removeAllListeners('end');
        if (raw) {
          input.setRawMode?.(false);
          // Raw mode swallowed the Enter the terminal would have echoed.
          output.write('\n');
        }
        input.pause();
        if (error) {
          reject(error);
        } else {
          resolve(answer.trim());
        }
      }

      // Consumes characters up to the end of this answer; returns true
      // once the answer is complete, leaving the rest buffered.
      function consume(text: string): boolean {
        for (let index = 0; index < text.length; index += 1) {
          const char = text[index] as string;
          if (char === '\r' || char === '\n') {
            // A \r\n pair ends one answer, not two.
            const next = index + 1;
            buffered = text.slice(char === '\r' && text[next] === '\n' ? next + 1 : next);
            finish();
            return true;
          }
          if (raw && char === CTRL_C) {
            buffered = '';
            finish(new PromptCancelledError());
            return true;
          }
          if (raw && char === CTRL_D) {
            buffered = text.slice(index + 1);
            finish();
            return true;
          }
          if (raw && BACKSPACE.has(char)) {
            answer = answer.slice(0, -1);
            continue;
          }
          answer += char;
        }
        buffered = '';
        return false;
      }

      if (consume(buffered)) {
        return;
      }
      if (ended) {
        finish();
        return;
      }
      input.on('data', (chunk) => {
        consume(chunk ?? '');
      });
      input.on('end', () => {
        ended = true;
        finish();
      });
      input.resume();
    });
  }

  return { ask };
}

// Accepts an address as someone would type it: "my-site.example" is
// taken to mean https://my-site.example, but a site on this machine
// ("localhost:3600", "127.0.0.1:3600") http://, since a local site has
// no certificate. Returns null for anything that still isn't an http(s)
// address.
const LOCAL_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i;

export function normaliseSiteUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `${LOCAL_HOST.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
