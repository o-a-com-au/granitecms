// Asks for a secret without showing it. A token typed on the command
// line (or in CMS_TOKEN=... before it) ends up in shell history; typed
// here, it goes nowhere but this process.

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

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

// In a terminal: raw mode, so keystrokes aren't echoed; Enter finishes,
// Backspace deletes, Ctrl+C cancels. A pasted token arrives as one chunk
// and is handled the same way. Without a terminal (input piped in), the
// first line is the answer, so `echo $TOKEN | npm run pull -- <url>`
// still works.
export function promptHidden(question: string, input: PromptInput, output: PromptOutput): Promise<string> {
  input.setEncoding('utf8');
  const interactive = input.isTTY === true && typeof input.setRawMode === 'function';
  // Echo goes off before the question appears, never after: anything
  // typed or pasted the instant the prompt shows would otherwise be
  // echoed by the terminal in the gap (seen for real in a pty test).
  if (interactive) {
    input.setRawMode?.(true);
  }
  output.write(question);

  return new Promise((resolve, reject) => {
    let answer = '';

    function finish(error?: Error): void {
      input.removeAllListeners('data');
      input.removeAllListeners('end');
      if (interactive) {
        input.setRawMode?.(false);
      }
      input.pause();
      output.write('\n');
      if (error) {
        reject(error);
      } else {
        resolve(answer.trim());
      }
    }

    input.resume();

    input.on('data', (chunk) => {
      for (const char of chunk ?? '') {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (interactive && char === CTRL_C) {
          finish(new PromptCancelledError());
          return;
        }
        if (interactive && char === CTRL_D) {
          finish();
          return;
        }
        if (interactive && BACKSPACE.has(char)) {
          answer = answer.slice(0, -1);
          continue;
        }
        answer += char;
      }
    });
    input.on('end', () => finish());
  });
}
