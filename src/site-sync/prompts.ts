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

export interface Choice {
  // The name a piped answer uses too ("content", "theme"), and the
  // label shown.
  name: string;
  label: string;
  detail?: string;
  checked: boolean;
  // Shown but can't be ticked, with detail saying why.
  disabled?: boolean;
}

export interface Prompter {
  ask: (question: string, options?: { hidden?: boolean }) => Promise<string>;
  // Returns the names of the ticked choices.
  choose: (question: string, choices: Choice[]) => Promise<string[]>;
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
  // The end of input is listened for for the prompter's whole life, not
  // only while a question waits: piped input can end between questions,
  // and a later question must still find out rather than wait forever.
  let onEnd: (() => void) | null = null;
  input.setEncoding('utf8');
  input.on('end', () => {
    ended = true;
    onEnd?.();
  });

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
        onEnd = null;
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
      onEnd = () => finish();
      input.resume();
    });
  }

  // A checkbox list. In a terminal: up/down (or k/j) to move, space to
  // tick, Enter to confirm, Ctrl+C to cancel. Without one (piped), one
  // line names the choices wanted ("content,theme", or "none"); an
  // empty line keeps the defaults.
  async function choose(question: string, choices: Choice[]): Promise<string[]> {
    const state = choices.map((choice) => ({ ...choice, checked: choice.checked && !choice.disabled }));
    const ticked = () => state.filter((choice) => choice.checked).map((choice) => choice.name);

    if (!interactive) {
      const names = state.map((choice) => choice.name).join(', ');
      const line = (await ask(`${question} (${names}; Enter for the defaults) `)).toLowerCase();
      if (line === '') {
        return ticked();
      }
      if (line === 'none') {
        return [];
      }
      const wanted = new Set(line.split(/[\s,]+/).filter(Boolean));
      return state.filter((choice) => wanted.has(choice.name) && !choice.disabled).map((choice) => choice.name);
    }

    const width = Math.max(...state.map((choice) => choice.label.length));
    let cursor = Math.max(0, state.findIndex((choice) => !choice.disabled));
    let drawn = 0;

    function draw(): void {
      if (drawn > 0) {
        output.write(`\u001b[${drawn}A`);
      }
      const lines = state.map((choice, index) => {
        const pointer = index === cursor ? '>' : ' ';
        const box = choice.disabled ? '[-]' : choice.checked ? '[x]' : '[ ]';
        const detail = choice.detail ? `  (${choice.detail})` : '';
        return `\u001b[2K${pointer} ${box} ${choice.label.padEnd(width)}${detail}\n`;
      });
      output.write(lines.join(''));
      drawn = lines.length;
    }

    output.write(`${question}\n  (up/down to move, space to tick, Enter to go)\n`);
    input.setRawMode?.(true);
    output.write('\u001b[?25l');
    draw();

    return new Promise((resolve, reject) => {
      function finish(error?: Error): void {
        input.removeAllListeners('data');
        input.setRawMode?.(false);
        output.write('\u001b[?25h');
        input.pause();
        if (error) {
          reject(error);
        } else {
          resolve(ticked());
        }
      }

      function move(step: number): void {
        for (let tries = 0; tries < state.length; tries += 1) {
          cursor = (cursor + step + state.length) % state.length;
          if (!state[cursor]?.disabled) {
            return;
          }
        }
      }

      input.on('data', (chunk) => {
        const keys = splitKeys(chunk ?? '');
        for (const key of keys) {
          if (key === CTRL_C) {
            finish(new PromptCancelledError());
            return;
          }
          if (key === '\r' || key === '\n') {
            finish();
            return;
          }
          if (key === '\u001b[A' || key === 'k') {
            move(-1);
          } else if (key === '\u001b[B' || key === 'j') {
            move(1);
          } else if (key === ' ') {
            const choice = state[cursor];
            if (choice && !choice.disabled) {
              choice.checked = !choice.checked;
            }
          }
        }
        draw();
      });
      input.resume();
    });
  }

  return { ask, choose };
}

const ESC = '\u001b';

// One chunk of terminal input can hold several key presses; an arrow
// key arrives as a three-character escape sequence (ESC [ A).
function splitKeys(text: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ESC && text[index + 1] === '[' && index + 2 < text.length) {
      keys.push(text.slice(index, index + 3));
      index += 2;
    } else {
      keys.push(text[index] as string);
    }
  }
  return keys;
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
