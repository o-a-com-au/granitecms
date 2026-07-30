import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';

export interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ThemeSchemas {
  sections: Record<string, object>;
  blocks: Record<string, object>;
  // Whether each type's own Liquid markup actually loops blocksHtml -
  // the only place "does this type support nested blocks" is ever
  // expressed (there is no schema field for it - instance.schema.json's
  // own blocks property is fully generic, deliberately unrestricted).
  acceptsBlocks: { sections: Record<string, boolean>; blocks: Record<string, boolean> };
}

// strict: false because theme schema.json files are authored by theme
// authors, not agent code, and are validated the same lenient way
// everywhere (see theme-schemas.ts).
const ajv = new Ajv({ allErrors: true, strict: false });

const schemasDir = join(import.meta.dirname, '..', 'schemas');

function readSchema(filename: string): object {
  return JSON.parse(readFileSync(join(schemasDir, filename), 'utf-8')) as object;
}

const instanceSchema = readSchema('instance.schema.json');
ajv.addSchema(instanceSchema);
const validatePageEnvelope = ajv.compile(readSchema('page.schema.json'));
const validatePostEnvelope = ajv.compile(readSchema('post.schema.json'));
const validateMenuEnvelope = ajv.compile(readSchema('menu.schema.json'));
const validateRedirectsEnvelope = ajv.compile(readSchema('redirects.schema.json'));
const validateInstanceEnvelope = ajv.compile(instanceSchema);

function normaliseErrors(errors: ErrorObject[] | null | undefined): ValidationError[] {
  if (!errors) {
    return [];
  }
  return errors.map((error) => {
    let path = error.instancePath;
    if (error.keyword === 'required') {
      const { missingProperty } = error.params as { missingProperty: string };
      path = `${error.instancePath}/${missingProperty}`;
    } else if (error.keyword === 'additionalProperties') {
      const { additionalProperty } = error.params as { additionalProperty: string };
      path = `${error.instancePath}/${additionalProperty}`;
    }
    return { path, message: error.message ?? '', keyword: error.keyword };
  });
}

function runValidator(validate: ValidateFunction, data: unknown): ValidationResult {
  const valid = validate(data);
  return { valid: Boolean(valid), errors: normaliseErrors(validate.errors) };
}

function prefixErrors(errors: ValidationError[], prefix: string): ValidationError[] {
  return errors.map((error) => ({ ...error, path: `${prefix}${error.path}` }));
}

interface SectionedContentShape {
  sections: unknown[];
}

interface InstanceShape {
  type: string;
  settings: object;
  blocks?: unknown[];
}

export function validateInstance(
  instance: unknown,
  kind: 'section' | 'block',
  themeSchemas: ThemeSchemas,
): ValidationResult {
  const envelopeResult = runValidator(validateInstanceEnvelope, instance);
  if (!envelopeResult.valid) {
    return envelopeResult;
  }

  const typed = instance as InstanceShape;
  const typeSchemas = kind === 'section' ? themeSchemas.sections : themeSchemas.blocks;
  const typeSchema = typeSchemas[typed.type];

  const errors: ValidationError[] = [];

  if (!typeSchema) {
    errors.push({
      path: '/type',
      message: `Unknown ${kind} type "${typed.type}"`,
      keyword: 'unknownType',
    });
  } else {
    const settingsValidate = ajv.compile(typeSchema);
    const settingsResult = runValidator(settingsValidate, typed.settings);
    errors.push(...prefixErrors(settingsResult.errors, '/settings'));
  }

  if (typed.blocks) {
    typed.blocks.forEach((block, index) => {
      const blockResult = validateInstance(block, 'block', themeSchemas);
      errors.push(...prefixErrors(blockResult.errors, `/blocks/${index}`));
    });
  }

  return { valid: errors.length === 0, errors };
}

// Shared by validatePage and validatePost: both envelopes require an
// identical sections/blocks recursion once their own envelope-level
// shape is confirmed valid - genuinely load-bearing for two real
// content types now, not a speculative abstraction.
function validateSectionedContent(
  envelopeValidate: ValidateFunction,
  content: unknown,
  themeSchemas: ThemeSchemas,
): ValidationResult {
  const envelopeResult = runValidator(envelopeValidate, content);
  if (!envelopeResult.valid) {
    return envelopeResult;
  }

  const typed = content as unknown as SectionedContentShape;
  const errors: ValidationError[] = [];

  typed.sections.forEach((section, index) => {
    const sectionResult = validateInstance(section, 'section', themeSchemas);
    errors.push(...prefixErrors(sectionResult.errors, `/sections/${index}`));
  });

  return { valid: errors.length === 0, errors };
}

export function validatePage(page: unknown, themeSchemas: ThemeSchemas): ValidationResult {
  return validateSectionedContent(validatePageEnvelope, page, themeSchemas);
}

export function validatePost(post: unknown, themeSchemas: ThemeSchemas): ValidationResult {
  return validateSectionedContent(validatePostEnvelope, post, themeSchemas);
}

export function validateMenu(menu: unknown): ValidationResult {
  return runValidator(validateMenuEnvelope, menu);
}

// Never routed through validateContent's dispatcher below: redirects.json
// lives at the site root, not under content/, so it never has a
// content/-relative path for that dispatcher to match against.
export function validateRedirects(redirects: unknown): ValidationResult {
  return runValidator(validateRedirectsEnvelope, redirects);
}

// Dispatches on the relative path's prefix, not an in-file `type`
// field: a menu has no `type` field at all, and the correct schema to
// parse against must be known before the content is even validated.
export function validateContent(
  relativePath: string,
  content: unknown,
  themeSchemas: ThemeSchemas,
): ValidationResult {
  if (relativePath.startsWith('menus/')) {
    return validateMenu(content);
  }
  if (relativePath.startsWith('posts/')) {
    return validatePost(content, themeSchemas);
  }
  return validatePage(content, themeSchemas);
}
