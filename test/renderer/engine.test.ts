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
