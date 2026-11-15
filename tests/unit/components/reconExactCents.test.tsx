/**
 * WP2 row 3: the screens agree with the server — a bank reconciliation out by R0.01 either way is not balanced,
 * offers no Complete button and is not coloured as balanced in the list.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { reconId: 'r-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ReconDetailPage from '../../../pages/accounting/bank-reconciliation/[reconId]';
import ReconListPage from '../../../pages/accounting/bank-reconciliation/index';
import { ReconciliationBalances } from '@/components/accounting/bank/ReconciliationBalances';
import { formatCurrency } from '@/utils/formatters';
import { ok } from '../helpers/d2CensusG4';
import type { BankReconciliation } from '@/modules/accounting/types/bank.types';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const RECON = (difference: number) => ({ id: 'r-1', bankAccountId: 'b1', bankAccountName: 'EC Cheque', statementDate: '2031-03-01',
  statementBalance: 10, glBalance: 10, reconciledBalance: 10, difference, status: 'in_progress', startedBy: 'u',
  startedAt: '2031-03-01', createdAt: '2031-03-01', updatedAt: '2031-03-01' });

describe('ReconciliationBalances badge', () => {
  it.each([0.01, -0.01])('does not say Balanced at %s', (difference) => {
    render(<ReconciliationBalances recon={RECON(difference) as unknown as BankReconciliation} />);
    expect(screen.queryByText('Balanced')).toBeNull();
  });
  it('says Balanced at exactly 0', () => {
    render(<ReconciliationBalances recon={RECON(0) as unknown as BankReconciliation} />);
    expect(screen.getByText('Balanced')).toBeDefined();
  });
});

describe('bank-reconciliation detail page', () => {
  const load = (difference: number) => vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('bank-reconciliations?id=')) return ok(RECON(difference));
    if (u.includes('bank-transactions?reconciliation_id=')) return ok({ transactions: [] });
    if (u.includes('journal-entries?')) return ok({ entries: [] });
    return ok({});
  });
  it.each([0.01, -0.01])('offers no Complete button at %s', async (difference) => {
    load(difference);
    render(<ReconDetailPage />);
    await screen.findByText(/cancel reconciliation/i);
    expect(screen.queryByRole('button', { name: /complete reconciliation/i })).toBeNull();
  });
  it('offers Complete at exactly 0', async () => {
    load(0);
    render(<ReconDetailPage />);
    expect(await screen.findByRole('button', { name: /complete reconciliation/i })).toBeDefined();
  });
});

describe('bank-reconciliation list', () => {
  const colourOf = async (difference: number) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok([{ ...RECON(difference), matchedCount: 1, unmatchedCount: 0 }]));
    const { container } = render(<ReconListPage />);
    await screen.findByText('EC Cheque');
    // The Difference cell is the only bold figure in the row.
    const cell = container.querySelector('td.font-bold')!;
    expect(cell.textContent).toBe(formatCurrency(difference));
    return cell.className;
  };
  it.each([0.01, -0.01])('does not colour %s as balanced', async (difference) => {
    expect(await colourOf(difference)).not.toContain('text-teal-400');
  });
  it('colours exactly 0 as balanced', async () => {
    expect(await colourOf(0)).toContain('text-teal-400');
  });
});
