import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ESLint, RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { noRawFormInput } from '../../../eslint/rules/no-raw-form-input.mjs';
import isaflow from '../../../eslint/isaflow-plugin.mjs';

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
    { code: '<input type="HIDDEN" name="csrf" />', filename: file, options: NONE },
    { code: '<><input id="n" /><label for="n">Name</label></>', filename: file, options: NONE },
    // the kit itself is exempt, at any depth, and only the kit
    { code: '<input type="date" />', filename: 'src/components/ui/deep/er/Thing.tsx', options: NONE },
    { code: '<input type="date" />', filename: path.join(process.cwd(), 'src/components/ui/Thing.tsx'), options: NONE },
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
    { code: '<input type="DATE" aria-label="Due" />', filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type=" Date " aria-label="Due" />', filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type={`date`} aria-label="Due" />', filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: "<input type={compact ? 'date' : 'text'} aria-label=\"Due\" />", filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: "<input type={isDate && 'date'} aria-label=\"Due\" />", filename: file, options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type={kind} />', filename: file, options: NONE, errors: [{ messageId: 'unlabelled' }] },
    { code: '<input type={dyn ? "hidden" : "text"} />', filename: file, options: NONE, errors: [{ messageId: 'unlabelled' }] },
    // the kit prefix is a directory, not a substring; the allowlist is an exact path, not a substring
    { code: '<input type="date" aria-label="Due" />', filename: 'src/components/uix/Thing.tsx', options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: 'src/components/ui-extra/Thing.tsx', options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: 'src/components/accounting/ui/Thing.tsx', options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: 'pages/src/components/ui/Thing.tsx', options: NONE, errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: `${file}.bak`, options: [{ allowlist: [file] }], errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: file, options: [{ allowlist: ['components/accounting/SomeForm.tsx'] }], errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: file, options: [{ allowlist: ['src/components/accounting'] }], errors: [{ messageId: 'rawDate' }] },
    { code: '<input type="date" aria-label="Due" />', filename: 'src/components/accounting/SomeForm2.tsx', options: [{ allowlist: [file] }], errors: [{ messageId: 'rawDate' }] },
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

describe('path handling does not depend on where eslint was started', () => {
  const code = 'export const X = () => <input type="date" />;\n';
  const lint = async (cwd: string, rel: string, overrideAllowlist?: string[]) => {
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true,
      overrideConfig: [{
        files: ['**/*.tsx'],
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { isaflow },
        rules: { 'isaflow/no-raw-form-input': overrideAllowlist ? ['error', { allowlist: overrideAllowlist }] : 'error' },
      }],
    });
    const [r] = await eslint.lintText(code, { filePath: path.join(process.cwd(), rel) });
    return r?.messages.filter((m) => m.ruleId === 'isaflow/no-raw-form-input').length ?? -1;
  };

  it('eslint started in a subdirectory still flags a new file and still exempts the kit', async () => {
    const sub = path.join(process.cwd(), 'src');
    expect(await lint(sub, 'src/components/accounting/BrandNew.tsx', [])).toBeGreaterThan(0);
    expect(await lint(sub, 'src/components/ui/Kit.tsx', [])).toBe(0);
  });

  it('eslint started in a subdirectory still honours the committed allowlist', async () => {
    const list: string[] = JSON.parse((await import('node:fs')).readFileSync('eslint/raw-input-allowlist.json', 'utf8'));
    const listed = list.find((f) => f.startsWith('src/')) as string;
    const sub = path.join(process.cwd(), 'src');
    expect(await lint(sub, listed)).toBe(0);
    expect(await lint(sub, listed, [])).toBeGreaterThan(0);
  });
});
