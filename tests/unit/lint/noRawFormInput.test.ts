import { describe, it, expect } from 'vitest';
import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { noRawFormInput } from '../../../eslint/rules/no-raw-form-input.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

const NONE = [{ allowlist: [] as string[] }];
const file = 'src/components/accounting/SomeForm.tsx';

tester.run('no-raw-form-input', noRawFormInput, {
  valid: [
    { code: '<input aria-label="Search" />', filename: file, options: NONE },
    { code: '<input aria-labelledby="h1" />', filename: file, options: NONE },
    { code: '<><input id="n" /><label htmlFor="n">Name</label></>', filename: file, options: NONE },
    { code: '<><label htmlFor="n">Name</label><input id="n" /></>', filename: file, options: NONE },
    { code: '<label>Name <input /></label>', filename: file, options: NONE },
    { code: '<label><span><input /></span></label>', filename: file, options: NONE },
    { code: '<input id={id} />', filename: file, options: NONE },
    { code: '<input id={`row-${i}`} />', filename: file, options: NONE },
    { code: '<input {...props} />', filename: file, options: NONE },
    { code: '<input type="hidden" name="csrf" />', filename: file, options: NONE },
    { code: '<Input label="Name" />', filename: file, options: NONE },
    { code: '<DateField label="Date" value={d} onChange={set} />', filename: file, options: NONE },
    { code: '<input type={kind} aria-label="x" />', filename: file, options: NONE },
    // the kit itself is exempt
    { code: '<input type="date" />', filename: 'src/components/ui/DateThing.tsx', options: NONE },
    // listed files are skipped
    { code: '<input type="date" />', filename: file, options: [{ allowlist: [file] }] },
  ],
  invalid: [
    { code: '<input type="date" aria-label="Due" />', filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: "<input type={'date'} aria-label=\"Due\" />", filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    {
      code: '<input type="date" />',
      filename: file,
      options: NONE,
      errors: [{ messageId: 'rawDate' }, { messageId: 'unlabelled' }],
    },
    { code: '<input />', filename: file, options: NONE, errors: [{ messageId: 'unlabelled' }] },
    { code: '<input type="text" placeholder="Name" />', filename: file, options: NONE, errors: [{ messageId: 'unlabelled' }] },
    { code: '<input aria-label="" />', filename: file, options: NONE, errors: [{ messageId: 'unlabelled' }] },
    { code: '<input type="checkbox" />', filename: file, options: NONE, errors: [{ messageId: 'unlabelled' }] },
    { code: '<><input id="n" /><label htmlFor="other">x</label></>', filename: file, options: NONE, errors: [{ messageId: 'orphanId' }] },
    { code: '<input id="n" />', filename: file, options: NONE, errors: [{ messageId: 'orphanId' }] },
    // a file that is not listed is not exempt just because another is
    { code: '<input type="date" aria-label="Due" />', filename: file, options: [{ allowlist: ['src/other.tsx'] }], errors: [{ messageId: 'rawDate' }] },
  ],
});

describe('default allowlist', () => {
  it('the committed allowlist is sorted, unique and only names existing tsx files outside the kit', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const list: string[] = JSON.parse(readFileSync('eslint/raw-input-allowlist.json', 'utf8'));
    expect(list).toEqual([...new Set(list)].sort());
    for (const f of list) {
      expect(f.endsWith('.tsx')).toBe(true);
      expect(f.startsWith('src/components/ui/')).toBe(false);
      expect(existsSync(f)).toBe(true);
    }
  });
});
