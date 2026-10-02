/**
 * D4: the consolidated trial balance page and its CSV say when the range
 * crosses a member's fiscal-year start — that member's earlier profit was
 * closed to retained earnings (derived, not posted) and sits on Retained
 * Earnings b/f. Inside one fiscal year nothing extra renders or exports.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import ConsolidatedTrialBalancePage from '@/../pages/accounting/group/trial-balance';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const CO = 'aaaaaaaa-0000-0000-0000-000000000001';
const row = { groupAccountId: 'g', groupAccountCode: 'B100', groupAccountName: 'Cash', accountType: 'asset',
  entities: { [CO]: { debit: 100, credit: 0 } }, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 100, consolidatedCredit: 0 };

function serve(fiscalYearEndsClosed: Record<string, string[]>, name = 'Co A', account = row) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const data = String(url).includes('company-groups') ? [{ id: 'grp', name: 'Group' }] : {
      groupAccounts: [account], entityNames: { [CO]: name },
      totals: { entities: { [CO]: { debit: 100, credit: 0 } }, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 100, consolidatedCredit: 0 },
      accountCount: 1, difference: 100, balanced: false, unmapped: { accountCount: 0, value: 0, byEntity: [] }, coterminous: true,
      fiscalYearStarts: { [CO]: '2026-03-01' }, fiscalYearEndsClosed,
    };
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

async function exportedCsv(): Promise<string> {
  let blob: Blob | undefined;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:x'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
  await waitFor(() => expect(blob).toBeDefined());
  return blob!.text();
}

describe('consolidated trial balance — fiscal years closed inside the range', () => {
  it('names the closed year on screen and in the CSV', async () => {
    serve({ [CO]: ['2026-02-28'] });
    render(<ConsolidatedTrialBalancePage />);
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('Co A: profit of the fiscal year ending 2026-02-28 closed to retained earnings — derived, not posted');
    expect(note.textContent).toContain('income statement rows run from 2026-03-01');
    expect(await exportedCsv()).toContain('"Year-end close (derived — not posted)","Co A: profit of the fiscal year ending 2026-02-28');
  });

  // An entity or account name that Excel would read as a formula is neutralised in EVERY text
  // cell (shared csvCell), and quotes are doubled — header, rows, totals and the note line.
  it('neutralises formula-leading text and doubles quotes across the whole export', async () => {
    serve({ [CO]: ['2026-02-28'] }, '=HYPERLINK("x")', { ...row, groupAccountCode: '-B100', groupAccountName: '+Cash', accountType: '@asset' });
    render(<ConsolidatedTrialBalancePage />);
    await screen.findByRole('note');
    const csv = await exportedCsv();
    expect(csv).toContain(`"'=HYPERLINK(""x"") Debit"`);
    expect(csv).toContain(`"'-B100","'+Cash","'@asset",100,0`);
    expect(csv).toContain(`"Year-end close (derived — not posted)","'=HYPERLINK(""x""): profit of the fiscal year ending 2026-02-28`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
  });

  it('adds nothing when the range sits inside one fiscal year', async () => {
    serve({ [CO]: [] });
    render(<ConsolidatedTrialBalancePage />);
    expect(await screen.findByText('Cash')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    expect(await exportedCsv()).not.toContain('Year-end close');
  });
});
