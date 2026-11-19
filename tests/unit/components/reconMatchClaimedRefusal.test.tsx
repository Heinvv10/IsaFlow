/**
 * The reconciliation screen's Match, refused because the GL line is already claimed (LINE_CLAIMED): the person
 * reads the server's sentence, not "Could not match" and not raw JSON. The provisional-held wording is the one
 * `assertMatchTargets` (bankTxStatusMutations) raises for a line a bank-first provisional's own statement line carries;
 * the route answers it 400 (tests/integration/recon-gl-provisional-held.int.test.ts).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { reconId: 'r-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ReconDetailPage from '../../../pages/accounting/bank-reconciliation/[reconId]';
import { ok } from '../helpers/d2CensusG4';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const CLAIMED = 'Journal line l-7 is the bank leg of a provisional journal whose own bank transaction t-9 already carries it '
  + '— use that line.';
const RECON = { id: 'r-1', bankAccountId: 'b1', bankAccountName: 'Claimed Bank', statementDate: '2031-03-01', statementBalance: 10,
  glBalance: 10, reconciledBalance: 10, difference: 10, status: 'in_progress', startedBy: 'u', startedAt: '2031-03-01',
  createdAt: '2031-03-01', updatedAt: '2031-03-01' };
const TX = { id: 't1', bankAccountId: 'b1', transactionDate: '2031-03-01', amount: -10, description: 'Claimed stmt line',
  status: 'imported', feedState: 'posted' };
const GL = { id: 'l-7', debit: 0, credit: 10, description: 'Claimed GL line', entryDate: '2031-03-01', entryNumber: 'JE-7' };

describe('recon screen: a LINE_CLAIMED refusal of Match', () => {
  it('shows the server sentence, and no raw JSON or bare fallback', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('bank-transactions-action') && init?.method === 'POST') {
        return new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: CLAIMED } }), { status: 400 });
      }
      if (u.includes('bank-reconciliations?id=')) return ok(RECON);
      if (u.includes('bank-transactions?reconciliation_id=')) return ok({ transactions: [TX] });
      if (u.includes('bank-reconciliation-gl-lines?')) return ok({ lines: [GL], total: 1, truncated: false });
      return ok({});
    });
    render(<ReconDetailPage />);
    fireEvent.click(await screen.findByText('Claimed stmt line'));
    fireEvent.click(await screen.findByText('Claimed GL line'));
    fireEvent.click(await screen.findByRole('button', { name: 'Match' }));
    expect(await screen.findByText(CLAIMED)).toBeTruthy();
    expect(screen.queryByText(/Could not match - try again/)).toBeNull();
    expect(screen.queryByText(/"success"|\{"error"/)).toBeNull();
  });
});
