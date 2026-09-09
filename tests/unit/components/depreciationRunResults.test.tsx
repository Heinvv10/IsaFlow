/**
 * The depreciation page is the one screen a human reads after a run.
 *
 * MEDIUM-H: life-expired rows reach `results` with `entryId: null`, and the
 * page rendered every such row in red as "GL Failed". Nothing failed — the
 * asset has no charge this period — so a clean run looked like it had failures
 * and the obvious response was to investigate one that never happened.
 * MEDIUM-I: the page declared its own `DepResult { amount }` over the parsed
 * JSON. The API has never returned `amount`, so every row rendered "RNaN" and
 * `tsc` could not see it.
 * LOW-J: the header still advertised straight line, and the register's
 * "Monthly Dep." column still computed it, after three methods began posting.
 *
 * Rendered, not grepped: all three live inside a conditional in a row map.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({
  // next/font cannot resolve outside a Next runtime and would make every
  // assertion below vacuous.
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shared/ExportCSVButton', () => ({
  ExportCSVButton: () => <button type="button">Export CSV</button>,
}));

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const EXPIRED_NOTE =
  'Its 5-year life ended before 2026-09-30 with 60000.00 of policy book value still '
  + 'undepreciated. This run charges nothing for it — writing the balance off is a '
  + 'prior-period correction, not a month of depreciation.';

const RUN = {
  processed: 2, skipped: 1, glFailed: 2, total: 5, eligible: 5,
  periodDate: '2026-09-30', yyyymm: '202609',
  results: [
    { assetNumber: 'A-0001', policyDep: 1200, taxDep: 1666.67, entryId: 'je-1', glFailed: false },
    { assetNumber: 'A-0002', policyDep: 833.33, taxDep: 1666.67, entryId: 'je-2', glFailed: false },
    { assetNumber: 'A-0003', policyDep: 0, taxDep: 0, entryId: null, glFailed: false, lifeExpiredNote: EXPIRED_NOTE },
    { assetNumber: 'A-0004', policyDep: 500, taxDep: 500, entryId: null, glFailed: true },
    // Life-expired AND its period rolled back. `entryId: null` is shared with
    // an ordinary zero charge, so only `glFailed` separates the two.
    { assetNumber: 'A-0005', policyDep: 0, taxDep: 0, entryId: null, glFailed: true, lifeExpiredNote: EXPIRED_NOTE },
  ],
};

// R100 000, 5-year life, no residual, bought 2024-01-15, R73 600 taken —
// depreciation year 3 of a reducing-balance schedule: 36 000 x 2/5 / 12 = 1 200.
// Straight line would say 1 666.67.
const ASSETS = [{
  id: 'a1', asset_number: 'A-0001', name: 'Reducing balance plant',
  purchase_price: 100000, current_book_value: 26400, accumulated_depreciation: 73600,
  useful_life_years: 5, salvage_value: 0, depreciation_method: 'reducing_balance',
  purchase_date: '2024-01-15', disposal_date: null,
}];

function jsonResponse(data: unknown) {
  return { ok: true, json: async () => ({ data }) };
}

async function runOnce() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Run Monthly Depreciation/i }));
  });
}

async function renderPage() {
  const { default: DepreciationPage } = await import('../../../pages/accounting/depreciation/index');
  render(<DepreciationPage />);
  await waitFor(() => expect(screen.getByText('A-0001')).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
  apiFetch.mockImplementation(async (url: string) =>
    url.includes('run-depreciation') ? jsonResponse(RUN) : jsonResponse({ items: ASSETS }));
});

describe('depreciation page — last run results', () => {
  it('calls a life-expired asset "No charge", not "GL Failed" (MEDIUM-H)', async () => {
    await renderPage();
    await runOnce();

    await waitFor(() => expect(screen.getByText('A-0003')).toBeInTheDocument());
    expect(screen.getByText('No charge')).toBeInTheDocument();
    // A-0004 and A-0005 both rolled back; A-0005 is ALSO life-expired and used
    // to hide behind the note as a quiet "No charge" (MEDIUM-K).
    expect(screen.getAllByText('GL Failed')).toHaveLength(2);
    expect(screen.getAllByText('GL Posted')).toHaveLength(2);
  });

  it('shows a rolled-back period as failed even when the asset is life-expired (MEDIUM-K)', async () => {
    await renderPage();
    await runOnce();

    await waitFor(() => expect(screen.getByText('A-0005')).toBeInTheDocument());
    // The row's own label, not the run totals: find the line A-0005 sits on.
    const row = screen.getByText('A-0005').closest('div')!;
    expect(row.textContent).toContain('GL Failed');
    expect(row.textContent).not.toContain('No charge');
  });

  it('puts the glFailed count on the summary line (MEDIUM-K)', async () => {
    await renderPage();
    await runOnce();
    await waitFor(() => expect(screen.getByText(/GL Failed: 2/)).toBeInTheDocument());
  });

  it('renders the life-expired note so the balance is visible', async () => {
    await renderPage();
    await runOnce();
    // Both life-expired rows carry it, the failed one included.
    await waitFor(() => expect(screen.getAllByText(EXPIRED_NOTE)).toHaveLength(2));
  });

  it('renders real amounts rather than RNaN (MEDIUM-I)', async () => {
    await renderPage();
    await runOnce();

    await waitFor(() => expect(screen.getByText('A-0002')).toBeInTheDocument());
    expect(document.body.textContent).not.toContain('NaN');
    // policyDep, formatted as ZAR. 1 200,00 appears twice — once in the run
    // results and once in the register's Monthly Dep. column, which is the
    // point: both read the same schedule.
    expect(screen.getAllByText(/1\s?200,00/)).toHaveLength(2);
    expect(screen.getByText(/833,33/)).toBeInTheDocument();
  });
});

describe('depreciation page — the register', () => {
  it('shows a dash, not a pro-rated guess, when there is no purchase date (LOW-L)', async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.includes('run-depreciation')
        ? jsonResponse(RUN)
        : jsonResponse({ items: [{ ...ASSETS[0], purchase_date: null }] }));
    await renderPage();
    // Substituting today fired the first-month pro-rate and printed a partial
    // charge — a number, and the wrong one.
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('no longer advertises straight line (LOW-J)', async () => {
    await renderPage();
    expect(document.body.textContent).not.toContain('Straight-line monthly depreciation');
    expect(screen.getByText(/own method/i)).toBeInTheDocument();
  });

  it('quotes each asset method charge in Monthly Dep., not straight line', async () => {
    await renderPage();
    // 1 200,00 is the reducing-balance charge; 1 666,67 would be straight line.
    expect(screen.getAllByText(/1\s?200,00/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('1 666,67');
  });
});
