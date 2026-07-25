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

interface PageShape {
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

export function validatePage(page: unknown, themeSchemas: ThemeSchemas): ValidationResult {
  const envelopeResult = runValidator(validatePageEnvelope, page);
  if (!envelopeResult.valid) {
    return envelopeResult;
  }

  const typed = page as unknown as PageShape;
  const errors: ValidationError[] = [];

  typed.sections.forEach((section, index) => {
    const sectionResult = validateInstance(section, 'section', themeSchemas);
    errors.push(...prefixErrors(sectionResult.errors, `/sections/${index}`));
  });

  return { valid: errors.length === 0, errors };
}
