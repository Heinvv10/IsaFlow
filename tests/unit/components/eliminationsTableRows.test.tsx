/**
 * D4 round 7: the eliminations table renders number / type / period / amount from the shape the
 * list API really returns (consolidatedReportingService `ConsolidationAdjustment`, served by
 * consolidated-reports?action=eliminations). The page read number / type / period / amount,
 * which the API never sends, so those four columns were blank.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';
import { ELIMINATION_TYPE_LABELS, fmt } from '@/components/accounting/group/EliminationsShared';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GROUP = '80000000-0000-4000-8000-000000000001';

/** Exactly what mapAdjustmentRow returns (DATE columns arrive as 'YYYY-MM-DD' strings). */
const apiRow = (o: Record<string, unknown>) => ({
  id: '70000000-0000-4000-8000-000000000001', groupId: GROUP, adjustmentNumber: 'ELIM-0007',
  adjustmentType: 'interco_revenue', description: 'January intercompany sale',
  periodStart: '2026-01-31', periodEnd: '2026-01-31', status: 'draft',
  lines: [
    { groupAccountId: '81000000-0000-4000-8000-000000000002', debit: 1250.5, credit: 0, description: '' },
    { groupAccountId: '81000000-0000-4000-8000-000000000003', debit: 0, credit: 1250.5, description: '' },
  ],
  sourceIntercompanyId: null, postedBy: null, postedAt: null, createdAt: '2026-02-01T08:00:00.000Z', ...o,
});

function serve(items: unknown[]) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const data = String(url).includes('company-groups') ? [{ id: GROUP, name: 'Group' }] : { items };
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  });
}

describe('eliminations table — rows from the real list API shape', () => {
  it('renders number, type, period and amount', async () => {
    serve([
      apiRow({}),
      apiRow({ id: '70000000-0000-4000-8000-000000000002', adjustmentNumber: 'ELIM-0008', adjustmentType: 'interco_balance',
        periodStart: '2026-01-01', periodEnd: '2026-03-31', status: 'posted',
        lines: [{ groupAccountId: 'x', debit: 40, credit: 0 }, { groupAccountId: 'y', debit: 60, credit: 0 }, { groupAccountId: 'z', debit: 0, credit: 100 }] }),
    ]);
    render(<EliminationsPage />);
    const first = (await screen.findByText('ELIM-0007')).closest('tr')!;
    const cells = within(first).getAllByRole('cell').map(c => c.textContent);
    expect(cells.slice(0, 6)).toEqual([
      'ELIM-0007', ELIMINATION_TYPE_LABELS.interco_revenue, 'January intercompany sale', '2026-01-31', 'draft', fmt(1250.5),
    ]);
    const second = screen.getByText('ELIM-0008').closest('tr')!;
    expect(within(second).getAllByRole('cell').map(c => c.textContent).slice(0, 6)).toEqual([
      'ELIM-0008', ELIMINATION_TYPE_LABELS.interco_balance, 'January intercompany sale', '2026-01-01 – 2026-03-31', 'posted', fmt(100),
    ]);
  });

  it('a malformed row renders empty cells instead of crashing', async () => {
    serve([apiRow({ adjustmentNumber: undefined, lines: 'not-an-array' })]);
    render(<EliminationsPage />);
    const row = (await screen.findByText('January intercompany sale')).closest('tr')!;
    expect(within(row).getAllByRole('cell').map(c => c.textContent).slice(0, 6)).toEqual([
      '', ELIMINATION_TYPE_LABELS.interco_revenue, 'January intercompany sale', '2026-01-31', 'draft', fmt(0),
    ]);
  });
});
