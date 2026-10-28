/**
 * Budgets P3 PR-B (T10, spec §2.6): the drill opened from a Budget vs Actual
 * line sends the line's EXPLICIT dimension levels (cc1_id / cc2_id, beside
 * business_unit_id), so its period net foots to the line, and links every
 * posted row to its source document (or journal entry).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, render, screen } from '@testing-library/react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { apiFetch } from '@/lib/apiFetch';
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const requestParams = () => new URL(String(vi.mocked(apiFetch).mock.calls.at(-1)?.[0]), 'http://localhost').searchParams;
const INV = '22222222-2222-4222-8222-222222222222';
const JE1 = '11111111-1111-4111-8111-111111111111';
const JE2 = '33333333-3333-4333-8333-333333333333';

afterEach(cleanup);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

describe('AccountDrillDown from Budget vs Actual', () => {
  it('sends cc1_id and cc2_id (explicit levels) and links rows to their source', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => response({
      accountCode: '4000', accountName: 'Sales', openingBalance: 0, periodNet: 15, closingBalance: 15,
      transactions: [
        { date: '2026-04-01', entryNumber: 'INV-1', description: 'Invoice', debit: 0, credit: 10, balance: 10, source: 'auto_invoice', journalId: JE1, document: { kind: 'customer_invoice', id: INV } },
        { date: '2026-04-02', entryNumber: 'JE-2', description: 'Manual', debit: 0, credit: 5, balance: 15, source: 'manual', journalId: JE2, document: null },
      ],
    }));
    render(<AccountDrillDown accountCode="4000" periodStart="2026-04-01" periodEnd="2026-04-30" cc1Id="cc1-a" cc2Id="cc2-b" businessUnitId="bu-a" />);
    const inv = await screen.findByRole('link', { name: /INV-1/ });
    expect(inv).toHaveAttribute('href', `/accounting/customer-invoices/${INV}`);
    expect(screen.getByRole('link', { name: /JE-2/ })).toHaveAttribute('href', `/accounting/journal-entries/${JE2}`);
    const params = requestParams();
    expect([params.get('cc1_id'), params.get('cc2_id'), params.get('business_unit_id'), params.get('cost_centre_id')]).toEqual(['cc1-a', 'cc2-b', 'bu-a', null]);
  });
});
