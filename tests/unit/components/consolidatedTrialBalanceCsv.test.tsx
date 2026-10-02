/**
 * The consolidated trial balance page's CSV: an entity or account name Excel
 * would read as a formula (= + - @) is neutralised in EVERY text cell by the
 * shared csvCell, and quotes are doubled — header, rows and totals.
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

function serve(name: string, code: string, accountName: string, type: string) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const data = String(url).includes('company-groups') ? [{ id: 'grp', name: 'Group' }] : {
      groupAccounts: [{ groupAccountId: 'g', groupAccountCode: code, groupAccountName: accountName, accountType: type,
        entities: { [CO]: { debit: 100, credit: 0 } }, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 100, consolidatedCredit: 0 }],
      entityNames: { [CO]: name },
      totals: { entities: { [CO]: { debit: 100, credit: 0 } }, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 100, consolidatedCredit: 0 },
      accountCount: 1, difference: 100, balanced: false, unmapped: { accountCount: 0, value: 0, byEntity: [] }, coterminous: true,
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

describe('consolidated trial balance CSV', () => {
  it('neutralises formula-leading text and doubles quotes across the whole export', async () => {
    serve('=HYPERLINK("x")', '-B100', '+Cash', '@asset');
    render(<ConsolidatedTrialBalancePage />);
    await screen.findByText('+Cash');
    const csv = await exportedCsv();
    expect(csv).toContain(`"'=HYPERLINK(""x"") Debit"`);
    expect(csv).toContain(`"'-B100","'+Cash","'@asset",100,0`);
    expect(csv).toContain(`"","TOTALS",""`);
    expect(csv).not.toMatch(/(^|,)"[=+\-@]/m);
  });

  it('leaves ordinary names as they were', async () => {
    serve('Co A', 'B100', 'Cash', 'asset');
    render(<ConsolidatedTrialBalancePage />);
    await screen.findByText('Cash');
    expect((await exportedCsv()).split('\n')[1]).toBe('"B100","Cash","asset",100,0,0,0,100,0');
  });
});
