import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PromptCancelledError, createPrompter, normaliseSiteUrl, type PromptInput } from '../../src/site-sync/prompts.ts';

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

test('a hidden question: nothing typed is echoed, Backspace deletes, Enter finishes, raw mode on before the question and off after', async () => {
  const terminal = new FakeTerminal();
  const output = captureOutput();
  const answer = createPrompter(terminal, output).ask('Token: ', { hidden: true });

  assert.deepEqual(terminal.rawModes, [true], 'echo is off before anything can be typed');
  terminal.type('secrex');
  terminal.type('\u007f');
  terminal.type('t-token\r');

  assert.equal(await answer, 'secret-token');
  assert.equal(output.text(), 'Token: \n', 'only the question and a newline are ever written');
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test('a visible question leaves the terminal\'s own echo and line editing alone', async () => {
  const terminal = new FakeTerminal();
  const output = captureOutput();
  const answer = createPrompter(terminal, output).ask('Address: ');
  // The terminal itself echoes and handles line editing in this mode,
  // and hands over the finished line.
  terminal.type('my-site.example\n');
  assert.equal(await answer, 'my-site.example');
  assert.deepEqual(terminal.rawModes, []);
  assert.equal(output.text(), 'Address: ');
});

test('a visible then a hidden question, answered in turn', async () => {
  const terminal = new FakeTerminal();
  const prompter = createPrompter(terminal, captureOutput());
  const address = prompter.ask('Address: ');
  terminal.type('my-site.example\n');
  assert.equal(await address, 'my-site.example');

  const token = prompter.ask('Token: ', { hidden: true });
  terminal.type('tok\r');
  assert.equal(await token, 'tok');
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test('Ctrl+C at a hidden question cancels, and still switches raw mode back off', async () => {
  const terminal = new FakeTerminal();
  const answer = createPrompter(terminal, captureOutput()).ask('Token: ', { hidden: true });
  terminal.type('half\u0003');
  await assert.rejects(answer, PromptCancelledError);
  assert.deepEqual(terminal.rawModes, [true, false]);
});

test('piped input: two lines arriving in one chunk answer two questions, nothing lost', async () => {
  const piped = new PassThrough();
  const prompter = createPrompter(piped as unknown as PromptInput, captureOutput());
  piped.write('my-site.example\r\nthe-token\n');
  assert.equal(await prompter.ask('Address: '), 'my-site.example');
  assert.equal(await prompter.ask('Token: ', { hidden: true }), 'the-token');
});

test('piped input with no final newline is still read when the input ends, and a question after that gets nothing', async () => {
  const piped = new PassThrough();
  const prompter = createPrompter(piped as unknown as PromptInput, captureOutput());
  piped.end('only-line');
  assert.equal(await prompter.ask('Address: '), 'only-line');
  assert.equal(await prompter.ask('Token: ', { hidden: true }), '');
});

test('normaliseSiteUrl accepts an address as typed, and rejects what is not one', () => {
  assert.equal(normaliseSiteUrl('site-production-fcfe.up.railway.app'), 'https://site-production-fcfe.up.railway.app');
  assert.equal(normaliseSiteUrl(' https://my-site.example/about '), 'https://my-site.example');
  assert.equal(normaliseSiteUrl('http://127.0.0.1:3600'), 'http://127.0.0.1:3600');
  // A site on this machine has no certificate: http, not https.
  assert.equal(normaliseSiteUrl('localhost:3600'), 'http://localhost:3600');
  assert.equal(normaliseSiteUrl('127.0.0.1:45778'), 'http://127.0.0.1:45778');
  assert.equal(normaliseSiteUrl('localhost.example.com'), 'https://localhost.example.com');
  for (const bad of ['', '   ', 'ftp://my-site.example', 'not a url']) {
    assert.equal(normaliseSiteUrl(bad), null, bad);
  }
});
