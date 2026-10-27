import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileSlug, slug, transformLabelFor, type TransformResult } from '../../../scripts/ci/codemods/labelForTransform';

const dir = path.join(__dirname, 'fixtures', 'labelFor');
const run = (name: string): { source: string; result: TransformResult } => {
  const source = readFileSync(path.join(dir, name), 'utf8');
  return { source, result: transformLabelFor(source, `src/components/x/${name}`) };
};

/** The output with every insertion cut back out, byte for byte, plus a check that each insertion sits where it says. */
function withoutInsertions({ output, insertions }: TransformResult): string {
  let rest = output;
  let shift = 0;
  for (const ins of insertions) {
    const at = ins.offset + shift;
    expect(rest.slice(at, at + ins.text.length)).toBe(ins.text);
    rest = rest.slice(0, at) + rest.slice(at + ins.text.length);
  }
  return rest;
}

describe('labelFor codemod: sibling pairs', () => {
  it('gives each label/control sibling pair matching htmlFor and id', () => {
    const { result } = run('SiblingForm.tsx');
    expect(result.output).toContain('<label htmlFor="sibling-form-company-name" className="text-sm">Company name *</label>');
    expect(result.output).toContain('<input id="sibling-form-company-name"   value={v}  onChange={() => {}} />');
    // a literal name attribute wins over the label text
    expect(result.output).toContain('<label htmlFor="sibling-form-province">Province</label>');
    expect(result.output).toContain('<select id="sibling-form-province" name="province" value={v}>');
    expect(result.output).toContain('<textarea id="sibling-form-notes" rows={3} />');
    expect(result.pairs.map((p) => p.id)).toEqual(['sibling-form-company-name', 'sibling-form-province', 'sibling-form-notes']);
  });

  it('leaves alone: a named label, an aria-label, a spread, a hidden input, a wrapping label, a non-adjacent control', () => {
    const { result } = run('SiblingForm.tsx');
    for (const untouched of ['<input id="done" />', '<input aria-label="Has aria" />', '<input {...rest} />', '<input type="hidden" />', '<label>Wraps <input /></label>', '<label>Not adjacent</label>']) {
      expect(result.output).toContain(untouched);
    }
    expect(result.insertions).toHaveLength(6);
  });

  it('the output differs from the input only at the insertion offsets', () => {
    for (const name of ['SiblingForm.tsx', 'LoopForm.tsx', 'CollisionForm.tsx']) {
      const { source, result } = run(name);
      expect(withoutInsertions(result)).toBe(source);
    }
  });

  it('is idempotent: a second run changes nothing and reports no pair', () => {
    const { result } = run('SiblingForm.tsx');
    const again = transformLabelFor(result.output, 'src/components/x/SiblingForm.tsx');
    expect(again.output).toBe(result.output);
    expect(again.insertions).toEqual([]);
  });
});

describe('labelFor codemod: skips', () => {
  it('a pair inside .map or Array.from is skipped as a loop; the static one beside it is named', () => {
    const { result } = run('LoopForm.tsx');
    expect(result.pairs).toEqual([
      { line: 6, id: 'loop-form-amount', component: 'LoopForm', skip: 'loop' },
      { line: 11, id: 'loop-form-qty', component: 'LoopForm', skip: 'loop' },
      { line: 13, id: 'loop-form-total', component: 'LoopForm' },
    ]);
    expect(result.output).not.toContain('loop-form-amount');
    expect(result.output).toContain('<input id="loop-form-total" />');
  });

  it('collisions, a nested render function, no static text and a component rendered twice are skipped', () => {
    const { result, source } = run('CollisionForm.tsx');
    expect(result.pairs.map((p) => [p.line, p.skip])).toEqual([
      [3, 'nested-function'],
      [7, 'id-collision'],
      [9, 'id-collision'],
      [11, 'id-collision'],
      [14, 'no-text'],
      [22, 'rendered-twice'],
      [30, 'rendered-twice'],
    ]);
    expect(result.output).toBe(source);
  });
});

describe('labelFor codemod: uses in other files', () => {
  const source = readFileSync(path.join(dir, 'SiblingForm.tsx'), 'utf8');
  const at = 'src/components/x/SiblingForm.tsx';

  it('a component rendered from 2+ places across the repo is skipped as rendered-twice, with nothing inserted', () => {
    const seen: string[] = [];
    const result = transformLabelFor(source, at, { usesElsewhere: (name) => { seen.push(name); return 2; } });
    expect(seen).toContain('SiblingForm');
    expect(result.insertions).toEqual([]);
    expect(result.output).toBe(source);
    expect(result.pairs.every((p) => p.skip === 'rendered-twice')).toBe(true);
  });

  it('rendered from one place elsewhere (the usual page -> tab) is named', () => {
    const result = transformLabelFor(source, at, { usesElsewhere: () => 1 });
    expect(result.insertions).toHaveLength(6);
  });
});

describe('labelFor codemod: ids', () => {
  it('slugs the file and the text', () => {
    expect(fileSlug('src/components/accounting/settings/DetailsTab.tsx')).toBe('details-tab');
    expect(fileSlug('pages/accounting/assets/index.tsx')).toBe('assets-index');
    expect(fileSlug('pages/accounting/assets/[id].tsx')).toBe('assets-id');
    // `new` and `edit` say nothing on their own: the directory names the page
    expect(fileSlug('pages/accounting/loans/new.tsx')).toBe('loans-new');
    expect(fileSlug('pages/accounting/customer-invoices/edit.tsx')).toBe('customer-invoices-edit');
    expect(fileSlug('pages/accounting/newsletter.tsx')).toBe('newsletter');
    expect(slug('VAT number *')).toBe('vat-number');
    expect(slug('registrationNumber')).toBe('registration-number');
    expect(slug('Position of logo on invoices and statements')).toBe('position-of-logo-on-invoices-and');
  });
});
