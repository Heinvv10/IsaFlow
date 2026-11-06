/**
 * A supplier edit never changes bank details, so every bank key the create parser reads has to be in BANK_BODY_FIELDS
 * (the keys the edit route refuses). A bank key added to `supplierInputFromBody` and not to the list would be
 * silently accepted by the edit. A source-text ratchet: it proves the lists agree, and the route / integration tests
 * prove the refusal.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANK_BODY_FIELDS } from '@/modules/accounting/services/core/contactRequestInput';

const SOURCE = readFileSync(resolve(__dirname, '../../../src/modules/accounting/services/core/contactRequestInput.ts'), 'utf8');
const createParser = SOURCE.slice(SOURCE.indexOf('export function supplierInputFromBody'), SOURCE.indexOf('/** The body keys that name a bank detail'));
const snake = (camel: string) => camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

describe('the supplier create parser and the edit route\'s bank refusal agree', () => {
  it('the create parser reads some bank keys at all (the regexes below are not matching nothing)', () => {
    expect(createParser).toContain("'bank_name'");
    expect(createParser.length).toBeGreaterThan(200);
  });

  it('every snake_case bank body key the create parser reads is refused by the edit', () => {
    const read = [...createParser.matchAll(/'(bank[a-z_]*)'/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(0);
    for (const key of read) expect(BANK_BODY_FIELDS, key).toContain(key);
  });

  it('every bank property of the service input has both spellings in the list', () => {
    const props = [...createParser.matchAll(/\b(bank[A-Z]\w*):/g)].map((m) => m[1]!);
    expect(props.length).toBeGreaterThan(0);
    for (const prop of props) {
      expect(BANK_BODY_FIELDS, prop).toContain(prop);
      expect(BANK_BODY_FIELDS, snake(prop)).toContain(snake(prop));
    }
  });

  it('the list holds both spellings of every field it names', () => {
    for (const field of BANK_BODY_FIELDS.filter((f) => f.includes('_'))) {
      const camel = field.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      expect(BANK_BODY_FIELDS, field).toContain(camel);
    }
  });
});
