import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemeComponentFile } from '../../src/services/theme-component-file.ts';

test('parseThemeComponentFile extracts the schema block and strips it from the markup', () => {
  const source = `<h1>{{ section.settings.heading }}</h1>
{% schema %}
{ "type": "object", "properties": { "heading": { "type": "string" } } }
{% endschema %}
`;
  const result = parseThemeComponentFile(source);
  assert.ok(result);
  assert.deepEqual(result?.schema, { type: 'object', properties: { heading: { type: 'string' } } });
  assert.equal(result?.markup.includes('{% schema %}'), false);
  assert.equal(result?.markup.includes('{% endschema %}'), false);
  assert.ok(result?.markup.includes('<h1>{{ section.settings.heading }}</h1>'));
});

test('parseThemeComponentFile finds the schema block regardless of where it sits in the file', () => {
  const source = `{% schema %}
{ "type": "object" }
{% endschema %}
<p>markup after the schema block</p>
`;
  const result = parseThemeComponentFile(source);
  assert.ok(result);
  assert.deepEqual(result?.schema, { type: 'object' });
  assert.ok(result?.markup.includes('<p>markup after the schema block</p>'));
});

test('parseThemeComponentFile accepts whitespace-control dash variants ({%- ... -%})', () => {
  const source = `<p>markup</p>
{%- schema -%}
{ "type": "object" }
{%- endschema -%}
`;
  const result = parseThemeComponentFile(source);
  assert.ok(result);
  assert.deepEqual(result?.schema, { type: 'object' });
});

test('parseThemeComponentFile returns null when no schema block is present', () => {
  assert.equal(parseThemeComponentFile('<p>just markup, no schema block</p>'), null);
});

test('parseThemeComponentFile returns null when the schema block contains invalid JSON', () => {
  const source = `<p>markup</p>
{% schema %}
{ not valid json
{% endschema %}
`;
  assert.equal(parseThemeComponentFile(source), null);
});

test('parseThemeComponentFile returns null when the schema block is valid JSON but not an object (e.g. a bare string or array)', () => {
  const source = `<p>markup</p>
{% schema %}
"just a string, not an object"
{% endschema %}
`;
  assert.equal(parseThemeComponentFile(source), null);
});
