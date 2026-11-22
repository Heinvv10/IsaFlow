// GL import wizard steps 3 and 4: the issues table becomes cards, and every button, radio row and result action is phone-sized.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportStep, ValidationStep } from '../../../src/components/accounting/gl-import/GlImportWizardSteps';
import type { ImportRow, ValidationSummary } from '../../../src/modules/accounting/services/gl/glImportService';

afterEach(cleanup);
const summary = {
  validations: [{ row: 2, valid: false, errors: ['Account 9999 not found'], warnings: ['VAT code missing'] }],
  validCount: 1, warningCount: 1, errorCount: 1, isBalanced: true, totalDebit: 1234567.89, totalCredit: 1234567.89,
} as unknown as ValidationSummary;
const rows = [{}] as unknown as ImportRow[];
const step4 = (over: Partial<Parameters<typeof ImportStep>[0]> = {}) => render(
  <ImportStep validRows={rows} summary={summary} postImmediately={false} onPostModeChange={vi.fn()} onBack={vi.fn()} onImport={vi.fn()}
    importing={false} importError="" importResult={null} onViewEntries={vi.fn()} onReset={vi.fn()} {...over} />);

describe('GL import steps on touch', () => {
  it('turns the row-level issues table into labelled cards', () => {
    const { container } = render(<ValidationStep summary={summary} onBack={vi.fn()} onNext={vi.fn()} />);
    const table = container.querySelector('table')!;
    expect(table.className).toContain('table-cards');
    // 18rem fits about three cards: a nested scroller that small is a scroll trap on a phone, so it gets most of the screen.
    expect(table.parentElement!.className).toContain('max-lg:max-h-[60vh]');
    expect([...table.querySelectorAll(':scope > thead th')].map(th => th.textContent)).toEqual(['Row', 'Type', 'Message']);
    const rowsEls = [...table.querySelectorAll(':scope > tbody > tr')];
    expect(rowsEls).toHaveLength(2); // one error + one warning
    for (const r of rowsEls) expect([...r.querySelectorAll(':scope > td')].map(td => td.getAttribute('data-label'))).toEqual(['Row', 'Type', 'Message']);
  });

  it('makes Back and Continue 44px and lets them wrap', () => {
    render(<ValidationStep summary={summary} onBack={vi.fn()} onNext={vi.fn()} />);
    const back = screen.getByRole('button', { name: /Back/ });
    const next = screen.getByRole('button', { name: /Continue/ });
    for (const b of [back, next]) expect(b.className).toContain('max-lg:min-h-11');
    expect(back.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes the import step phone-sized: stacked summary, 44px radio rows and buttons', () => {
    const { container } = step4();
    expect(container.querySelector('.grid-cols-3')!.className).toContain('max-lg:grid-cols-1'); // a 7-figure total does not fit a third of a phone
    const labels = [...container.querySelectorAll('label')];
    expect(labels).toHaveLength(2);
    for (const l of labels) expect(l.className).toContain('max-lg:min-h-11');
    for (const name of [/Back/, /Import 1 rows/]) expect(screen.getByRole('button', { name }).className, String(name)).toContain('max-lg:min-h-11');
    expect(screen.getByRole('button', { name: /Back/ }).parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });

  it('makes the two result actions 44px and lets them wrap', () => {
    step4({ importResult: { entriesCreated: 1, linesCreated: 2, totalValue: 10 } });
    const view = screen.getByRole('button', { name: 'View Journal Entries' });
    const again = screen.getByRole('button', { name: 'Import Another File' });
    for (const b of [view, again]) expect(b.className).toContain('max-lg:min-h-11');
    expect(view.parentElement!.className).toContain('max-lg:flex-wrap');
  });
});
