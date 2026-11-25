// Account detail report page: the back link and Export button are 44px on phones, and the title row wraps.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({ pathname: '/x', query: { accountId: '11111111-1111-4111-8111-111111111111', from: '2026-05-01', to: '2026-05-31' }, asPath: '/', isReady: true, push: () => undefined, replace: () => undefined }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/reports/AccountLedgerSummary', () => ({ AccountLedgerSummary: () => null }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiJson: vi.fn(async () => ({
    meta: { accountId: 'a', accountCode: '1000', accountName: 'Bank', accountType: 'asset', normalBalance: 'debit' },
    rows: [], openingBalance: 0, periodClosingBalance: 0, periodNet: 0, closedToRetainedEarnings: 0, derivedRows: 0, total: 0,
  })),
}));

import Page from '../../../pages/accounting/reports/account-detail/[accountId]';

afterEach(cleanup);

describe('Account detail page on touch', () => {
  it('makes the back link and Export this view 44px', async () => {
    render(<Page />);
    const exportBtn = await screen.findByRole('button', { name: /Export this view/ });
    expect(exportBtn.className.split(' ')).toContain('max-lg:min-h-11');
    expect(screen.getByRole('link', { name: /Back to/ }).className.split(' ')).toContain('max-lg:min-h-11');
  });

  it('lets the title and Export wrap onto two rows on a phone', async () => {
    render(<Page />);
    const exportBtn = await screen.findByRole('button', { name: /Export this view/ });
    expect(exportBtn.parentElement!.className.split(' ')).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
