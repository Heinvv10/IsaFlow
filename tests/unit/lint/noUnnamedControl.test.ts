import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { ESLint, RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { noUnnamedControl, readControlAllowlist } from '../../../eslint/rules/no-unnamed-control.mjs';
import isaflow from '../../../eslint/isaflow-plugin.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
});

const NONE = [{ allowlist: {} as Record<string, number> }];
const file = 'src/components/accounting/SomeForm.tsx';

tester.run('no-unnamed-control', noUnnamedControl, {
  valid: [
    { code: '<select aria-label="Status" />', filename: file, options: NONE },
    { code: '<textarea aria-label="Notes" />', filename: file, options: NONE },
    { code: '<><h3 id="h1">Status</h3><select aria-labelledby="h1" /></>', filename: file, options: NONE },
    { code: '<><label htmlFor="s">Status</label><select id="s" /></>', filename: file, options: NONE },
    { code: '<><textarea id="n" /><label htmlFor="n">Notes</label></>', filename: file, options: NONE },
    { code: '<label>Status <select /></label>', filename: file, options: NONE },
    { code: '<label><span>Notes</span><textarea /></label>', filename: file, options: NONE },
    { code: '<select id={id} />', filename: file, options: NONE },
    { code: '<select {...props} />', filename: file, options: NONE },
    { code: '<textarea {...register("notes")} />', filename: file, options: NONE },
    { code: '<select aria-label={label} />', filename: file, options: NONE },
    { code: '<Select label="Status" />', filename: file, options: NONE },
    // <input> is the other rule's
    { code: '<input />', filename: file, options: NONE },
    // a listed file keeps exactly its count; the kit is exempt
    { code: '<><select /><textarea /></>', filename: file, options: [{ allowlist: { [file]: 2 } }] },
    { code: '<select />', filename: 'src/components/ui/Select.tsx', options: NONE },
    // a non-empty title is a name (the last fallback in accname)
    { code: '<select title="Status" />', filename: file, options: NONE },
    { code: '<textarea title={label} />', filename: file, options: NONE },
    // hidden controls are not in the accessibility tree
    { code: '<select hidden />', filename: file, options: NONE },
    { code: '<textarea aria-hidden="true" />', filename: file, options: NONE },
    { code: '<select aria-hidden />', filename: file, options: NONE },
    { code: '<select hidden={true} />', filename: file, options: NONE },
    { code: '<select hidden="true" />', filename: file, options: NONE },
    { code: '<textarea aria-hidden={true} />', filename: file, options: NONE },
    { code: '<textarea aria-hidden={`true`} />', filename: file, options: NONE },
    // text, an expression, a component or an aria-label on the wrapping label is a name
    { code: '<label>{text}<select /></label>', filename: file, options: NONE },
    { code: '<label><Trans /><select /></label>', filename: file, options: NONE },
    { code: '<label aria-label="Status"><select /></label>', filename: file, options: NONE },
    { code: '<label {...p}><select /></label>', filename: file, options: NONE },
    // aria-labelledby at an id written in the file, or a dynamic one
    { code: '<><h2 id="h">Status</h2><select aria-labelledby="h" /></>', filename: file, options: NONE },
    { code: '<><select aria-labelledby="x h" /><span id="h">S</span></>', filename: file, options: NONE },
    { code: '<select aria-labelledby={headingId} />', filename: file, options: NONE },
    // a label with htmlFor wrapping the control it points at
    { code: '<label htmlFor="s">Status <select id="s" /></label>', filename: file, options: NONE },
  ],
  invalid: [
    { code: '<select />', filename: file, options: NONE, errors: [{ messageId: 'unnamed', data: { tag: 'select' } }] },
    { code: '<textarea placeholder="Notes" />', filename: file, options: NONE, errors: [{ messageId: 'unnamed', data: { tag: 'textarea' } }] },
    { code: '<select aria-label="" />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select aria-label={undefined} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select id={undefined} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select id="s" />', filename: file, options: NONE, errors: [{ messageId: 'orphanId' }] },
    { code: '<><select id="s" /><label htmlFor="t">x</label></>', filename: file, options: NONE, errors: [{ messageId: 'orphanId' }] },
    // a sibling <label> that names nothing is not a name
    { code: '<><label>Status</label><select /></>', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<><label>Notes</label><textarea /></>', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    // one more than the count fails, and it is the later one that reports
    { code: '<><select /><select /><textarea /></>', filename: file, options: [{ allowlist: { [file]: 2 } }], errors: [{ messageId: 'overList', line: 1, column: 23 }] },
    // the over-count message names the file and its allowed count
    {
      code: '<><select /><textarea /></>', filename: file, options: [{ allowlist: { [file]: 1 } }],
      errors: [{ message: `<textarea> has no accessible name. Add aria-label or aria-labelledby, an id that a <label htmlFor> points at, or wrap it in a <label>. Prefer the kit: Select, Textarea. (${file} may have 1 by eslint/unnamed-control-allowlist.json and now has more. The report lands on the first control past the count in file order; the one you added or changed may be earlier in the file.)` }],
    },
    { code: '<select />', filename: '__proto__', options: [{ allowlist: {} }], errors: [{ messageId: 'unnamed' }] },
    { code: '<select />', filename: 'src/components/uix/Thing.tsx', options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select title="" />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    // a dynamic hidden / aria-hidden may be false: it does not exempt the control
    { code: '<select hidden={isHidden} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<textarea aria-hidden={collapsed} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select hidden={open ? false : true} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select aria-hidden={!!x} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select aria-hidden="yes" />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    // ARIA takes the exact string "true": any other spelling leaves the control in the tree
    { code: '<select aria-hidden="TRUE" />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<textarea aria-hidden=" true " />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<textarea aria-hidden={`1`} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    // a wrapping label with no text, no expression, no component and no aria names nothing; option text is not label text
    { code: '<label><select /></label>', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<label><select><option>A</option></select></label>', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<label> <span> </span><textarea /></label>', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select hidden={false} />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    { code: '<select aria-hidden="false" />', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
    // aria-labelledby at no id in the file names nothing
    { code: '<select aria-labelledby="nowhere" />', filename: file, options: NONE, errors: [{ messageId: 'danglingLabelledby', data: { tag: 'select', ids: 'nowhere' } }] },
    // a wrapping <label> names only its first control
    { code: '<label>Range <select /><select /></label>', filename: file, options: NONE, errors: [{ messageId: 'secondInLabel', column: 24 }] },
    { code: '<label>Notes <input /><textarea /></label>', filename: file, options: NONE, errors: [{ messageId: 'secondInLabel' }] },
    // a <label htmlFor> names its target, not the control it wraps
    { code: '<label htmlFor="a">Status <select /></label>', filename: file, options: NONE, errors: [{ messageId: 'unnamed' }] },
  ],
});

describe('the unnamed-control allowlist', () => {
  it('a missing list reads as empty, so deleting it reports every violation', () => {
    expect(readControlAllowlist('/nonexistent/unnamed-control-allowlist.json')).toEqual({});
  });

  it('the committed list is sorted, unique paths to positive counts, only existing tsx files outside the kit', () => {
    const list: Record<string, number> = JSON.parse(readFileSync('eslint/unnamed-control-allowlist.json', 'utf8'));
    const files = Object.keys(list);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    for (const f of files) {
      expect(f.endsWith('.tsx')).toBe(true);
      expect(f.startsWith('src/components/ui/')).toBe(false);
      expect(existsSync(f)).toBe(true);
      expect(list[f]).toBeGreaterThan(0);
    }
  });

  it('the rule reads the committed list: a listed file passes at its count and fails at one more', async () => {
    const list: Record<string, number> = JSON.parse(readFileSync('eslint/unnamed-control-allowlist.json', 'utf8'));
    const [listed, count] = Object.entries(list)[0] as [string, number];
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [{
        files: ['**/*.tsx'],
        languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { isaflow },
        rules: { 'isaflow/no-unnamed-control': 'error' },
      }],
    });
    const reports = async (n: number) => {
      const [r] = await eslint.lintText(`export const X = () => <>${'<select />'.repeat(n)}</>;\n`, { filePath: listed });
      return r?.messages.filter((m) => m.ruleId === 'isaflow/no-unnamed-control').length ?? -1;
    };
    expect(await reports(count)).toBe(0);
    expect(await reports(count + 1)).toBe(1);
  });
});
