import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContent, validatePost } from '../../src/services/validation.ts';
import type { ThemeSchemas } from '../../src/services/validation.ts';

// Inlined rather than read from the theme fixture: this test is about
// page/post envelope validation, not about the theme file format
// (which is theme-component-file.test.ts's job) - decoupling the two
// means a theme fixture restructuring never breaks this test.
const themeSchemas: ThemeSchemas = {
  sections: {
    hero: {
      type: 'object',
      additionalProperties: false,
      required: ['heading'],
      properties: {
        heading: { type: 'string', minLength: 1 },
        subheading: { type: 'string' },
        columns: { type: 'integer', minimum: 1, maximum: 4 },
      },
    },
  },
  blocks: {
    button: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'url'],
      properties: {
        label: { type: 'string', minLength: 1 },
        url: { type: 'string', minLength: 1 },
      },
    },
  },
};

function validPost(overrides: Record<string, unknown> = {}): object {
  return {
    schemaVersion: 4,
    title: 'Hello World',
    type: 'post',
    layout: 'theme',
    published: true,
    author: 'Jane Editor',
    publishDate: '2026-07-27',
    tags: ['news', 'launch'],
    sections: [],
    ...overrides,
  };
}

test('a post with all required fields (including author, publishDate, tags) validates successfully', () => {
  const result = validatePost(validPost(), themeSchemas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('a post missing author fails validation naming the field', () => {
  const post = validPost() as Record<string, unknown>;
  delete post.author;
  const result = validatePost(post, themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.path === '/author');
  assert.ok(error, 'expected an error naming the missing "author" field');
  assert.equal(error?.keyword, 'required');
});

test('a post missing publishDate or tags fails validation', () => {
  const missingPublishDate = validPost() as Record<string, unknown>;
  delete missingPublishDate.publishDate;
  assert.equal(validatePost(missingPublishDate, themeSchemas).valid, false);

  const missingTags = validPost() as Record<string, unknown>;
  delete missingTags.tags;
  assert.equal(validatePost(missingTags, themeSchemas).valid, false);
});

test('a post with type other than "post" is rejected (const constraint)', () => {
  const result = validatePost(validPost({ type: 'page' }), themeSchemas);
  assert.equal(result.valid, false);
});

test('an unknown/extra property on a post is rejected (additionalProperties false)', () => {
  const result = validatePost(validPost({ unexpectedField: 'x' }), themeSchemas);
  assert.equal(result.valid, false);
  const error = result.errors.find((e) => e.keyword === 'additionalProperties');
  assert.ok(error, 'expected an additionalProperties error');
});

test('a post with a real section still gets the same section/block recursion pages get', () => {
  const post = validPost({
    sections: [
      {
        id: 'sec-hero',
        type: 'hero',
        settings: { heading: 'Launch day' },
      },
    ],
  });
  assert.equal(validatePost(post, themeSchemas).valid, true);

  const broken = validPost({
    sections: [{ id: 'sec-hero', type: 'hero', settings: { heading: 123 } }],
  });
  const result = validatePost(broken, themeSchemas);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.path.startsWith('/sections/0')));
});

test('validateContent dispatches to validatePost for a posts/ relative path', () => {
  const result = validateContent('posts/hello-world.json', validPost(), themeSchemas);
  assert.equal(result.valid, true);

  // A page-shaped document (no author/publishDate/tags) is invalid as a
  // post, proving the dispatch actually picked the post schema, not
  // silently falling back to the looser page schema.
  const pageShaped = { schemaVersion: 4, title: 'X', type: 'page', layout: 'theme', published: true, sections: [] };
  assert.equal(validateContent('posts/hello-world.json', pageShaped, themeSchemas).valid, false);
});
