import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Liquid } from 'liquidjs';
import { createEngine } from '../../src/renderer/engine.ts';

test('D8: no Liquid tags or filters beyond the LiquidJS defaults are registered (asserted by inspecting the engine instance)', () => {
  const engine = createEngine({});
  const vanilla = new Liquid();

  assert.deepEqual(Object.keys(engine.tags).sort(), Object.keys(vanilla.tags).sort());
  assert.deepEqual(Object.keys(engine.filters).sort(), Object.keys(vanilla.filters).sort());
});

test('the built-in render tag resolves a snippet purely from the in-memory snippets map, no disk access', async () => {
  const engine = createEngine({ 'social-icons': '<div class="social">{{ label }}</div>' });
  const html = await engine.parseAndRender(`{% render 'social-icons', label: 'Follow us' %}`, {});
  assert.equal(html, '<div class="social">Follow us</div>');
});

test('render uses an isolated scope: the parent template scope does not leak into the snippet', async () => {
  const engine = createEngine({ leaky: '{{ secret }}' });
  const html = await engine.parseAndRender(`{% render 'leaky' %}`, { secret: 'top-secret' });
  assert.equal(html, '');
});

test('a missing snippet name produces a clear, catchable error rather than a silent empty render', async () => {
  const engine = createEngine({});
  await assert.rejects(engine.parseAndRender(`{% render 'does-not-exist' %}`, {}));
});

test('renderLimit still bounds the whole render tree, including a snippet invoked via render', async () => {
  const engine = createEngine({ runaway: '{% for i in (1..5000000) %}{{ i }}{% endfor %}' });
  await assert.rejects(
    engine.parseAndRender(`before{% render 'runaway' %}after`, {}),
    /template render limit exceeded/,
  );
});
