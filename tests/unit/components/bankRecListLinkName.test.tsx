/**
 * /accounting/bank-reconciliation: the per-row open link was an icon only (a tick or a chevron), so axe
 * reported link-name (serious) once per reconciliation. Each link is named for what it opens.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: LIST }) })),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const base = { bankAccountId: 'b1', statementDate: '2031-03-01', statementBalance: 10, glBalance: 10, reconciledBalance: 10, difference: 0,
  startedBy: 'u', startedAt: '2031-03-01', createdAt: '2031-03-01', updatedAt: '2031-03-01', matchedCount: 1, unmatchedCount: 0 };
const LIST = [
  { ...base, id: 'r-1', bankAccountName: 'FNB Cheque', status: 'in_progress' },
  { ...base, id: 'r-2', bankAccountName: 'Nedbank Savings', status: 'completed' },
];

import ReconListPage from '../../../pages/accounting/bank-reconciliation/index';

describe('bank-reconciliation list: row links have names', () => {
  it('names each link by its action and the account', async () => {
    render(<ReconListPage />);
    const cont = await screen.findByRole('link', { name: 'Continue reconciliation for FNB Cheque' });
    expect(cont).toHaveAttribute('href', '/accounting/bank-reconciliation/r-1');
    expect(screen.getByRole('link', { name: 'View reconciliation for Nedbank Savings' })).toHaveAttribute('href', '/accounting/bank-reconciliation/r-2');
    for (const link of screen.getAllByRole('link')) expect(link).toHaveAccessibleName();
  });
});
