import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PromptCancelledError, promptHidden, type PromptInput } from '../../src/pull-site/prompt-token.ts';

// Stands in for a terminal's stdin: records raw-mode changes, and lets a
// test type keys by emitting data.
class FakeTerminal extends EventEmitter implements PromptInput {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
  setEncoding(): void {}
  pause(): void {}
  resume(): void {}
  type(text: string): void {
    this.emit('data', text);
  }
}

function captureOutput() {
  let text = '';
  return { write: (chunk: string) => (text += chunk), text: () => text };
}

test('in a terminal: nothing typed is echoed, Backspace deletes, Enter finishes, and raw mode is switched back off', async () => {
  const terminal = new FakeTerminal();
  const output = captureOutput();
  const answer = promptHidden('Token: ', terminal, output);

  terminal.type('secrex');
  terminal.type('\u007f');
  terminal.type('t-token\r');

  assert.equal(await answer, 'secret-token');
  assert.equal(output.text(), 'Token: \n', 'only the question and a newline are ever written');
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test('a pasted token followed by Enter arrives in one chunk and is read the same way', async () => {
  const terminal = new FakeTerminal();
  const answer = promptHidden('Token: ', terminal, captureOutput());
  terminal.type('pasted-token-value\r');
  assert.equal(await answer, 'pasted-token-value');
});

test('Ctrl+C cancels, and still switches raw mode back off', async () => {
  const terminal = new FakeTerminal();
  const answer = promptHidden('Token: ', terminal, captureOutput());
  terminal.type('half\u0003');
  await assert.rejects(answer, PromptCancelledError);
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test('without a terminal (piped input), the first line is the answer', async () => {
  const piped = new PassThrough();
  const answer = promptHidden('Token: ', piped as unknown as PromptInput, captureOutput());
  piped.end('from-a-pipe\nignored second line\n');
  assert.equal(await answer, 'from-a-pipe');
});

test('piped input with no newline at all is still read when the input ends', async () => {
  const piped = new PassThrough();
  const answer = promptHidden('Token: ', piped as unknown as PromptInput, captureOutput());
  piped.end('no-newline');
  assert.equal(await answer, 'no-newline');
});
