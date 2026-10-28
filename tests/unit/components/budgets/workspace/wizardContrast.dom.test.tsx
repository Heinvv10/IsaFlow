/** Contrast (round 1 QA-7): no wizard/import text uses the low-contrast fills, in the DOM as rendered (portals included). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CreateWizard } from '@/components/accounting/budgets/workspace/CreateWizard';
import { ImportDialog } from '@/components/accounting/budgets/workspace/ImportDialog';
import { ImportDiffPreview } from '@/components/accounting/budgets/workspace/ImportDiffPreview';
import { TemplateDownloadDialog } from '@/components/accounting/budgets/workspace/TemplateDownloadDialog';
import * as client from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';
import type { ImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';

vi.mock('@/components/accounting/budgets/workspace/budgetWorkspaceClient');

const LOW = /(?:bg|text)-\[var\(--ff-(?:brand|error-500|warning-500)\)\]/;
const A = '11111111-1111-4111-8111-111111111111';
const fail = { ok: false as const, kind: 'failed' as const, message: 'It broke.', status: 500 };

function audit(): void {
  const all = Array.from(document.body.querySelectorAll<HTMLElement>('*'));
  expect(all.length).toBeGreaterThan(3);
  for (const el of all) {
    const label = `<${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 30)}"`;
    expect(el.getAttribute('class') ?? '', label).not.toMatch(LOW);
    expect(el.style.color, label).not.toMatch(/ff-(error|warning)-500/);
    expect(el.style.background, label).not.toMatch(/ff-(error|warning)-500/);
  }
}

beforeEach(() => {
  vi.mocked(client.listVersions).mockReset().mockResolvedValue({ ok: true, data: [] });
  vi.mocked(client.fetchPriorActuals).mockReset().mockResolvedValue(fail);
  vi.mocked(client.fetchGridCells).mockReset();
  vi.mocked(client.seedVersion).mockReset().mockResolvedValue(fail);
  vi.mocked(client.previewImport).mockReset().mockResolvedValue(fail);
  vi.mocked(client.downloadTemplate).mockReset().mockResolvedValue(fail);
});
afterEach(cleanup);

it('ImportDiffPreview with errors, warnings, a conflict, a revert and a failure', () => {
  const preview = {
    updatedAt: 't', changes: [{ key: `${A}||||2026-03`, before: 1, after: 2, possibleRevert: true, currentChangedAt: null }],
    cells: [{ glAccountId: A, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 2 }],
    counts: { added: 0, changed: 1, cleared: 0, unchanged: 0 }, conflicts: [{ key: `${A}||||2026-03`, downloaded: 1, current: 3, after: 2 }],
    errors: [{ row: 2, column: 'x', message: 'bad' }], errorCount: 1, warnings: [{ row: 3, column: 'y', message: 'warn' }], warningCount: 1,
    truncated: false, totals: { before: {}, after: {} },
  } as unknown as ImportPreview;
  render(<ImportDiffPreview preview={preview} months={['2026-03']} accountLabels={new Map()} memberLabels={new Map()} nowMs={0}
    busy={false} failure={{ message: 'm', failedChunk: 1, chunks: 2 }} onCommit={vi.fn()} onRerun={vi.fn()} onCancel={vi.fn()} />);
  audit();
});

it('CreateWizard: every step, the source error, the preview errors and the create refusal', async () => {
  vi.mocked(client.listVersions).mockResolvedValue(fail);
  const year = { fiscalYear: 2027, startDate: '2027-01-01', endDate: '2027-02-28', kind: 'standard', monthKeys: ['2027-01', '2027-02'] };
  render(<CreateWizard open onClose={vi.fn()} years={[year]} fiscalYear={2027} canMakePrimary accounts={[]} currentTotals={null} onCreated={vi.fn()} />);
  await screen.findByRole('alert'); // the failed year lookup
  audit();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'B' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByLabelText('Copy a version'));
  await waitFor(() => expect(client.listVersions).toHaveBeenCalledTimes(2));
  await screen.findAllByRole('alert');
  audit();
  fireEvent.change(screen.getByLabelText('Uplift (%)'), { target: { value: 'x' } });
  audit();
  fireEvent.click(screen.getByLabelText('Prior-year actuals'));
  fireEvent.change(screen.getByLabelText('Uplift (%)'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText(/Could not load the figures/);
  audit();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(client.seedVersion).toHaveBeenCalled());
  await screen.findAllByText('It broke.');
  audit();
});

it('ImportDialog: a refused preview and the unsaved-edits warning', async () => {
  render(<ImportDialog open onClose={vi.fn()} versionId="v" months={[]} accountLabels={new Map()} memberLabels={new Map()} dirtyCount={2}
    commitImport={vi.fn()} onImported={vi.fn()} />);
  const f = new File(['x'], 'b.xlsx');
  fireEvent.change(screen.getByLabelText(/Excel file/), { target: { files: [f] } });
  await waitFor(() => expect(screen.getAllByRole('alert').length).toBe(2));
  audit();
});

it('TemplateDownloadDialog: a refused download', async () => {
  render(<TemplateDownloadDialog open onClose={vi.fn()} versionId="v" fiscalYear={2027} dimensions={{ cc1: [], cc2: [], bu: [] }} cells={[]} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download' }));
  await screen.findByRole('alert');
  audit();
});
