// Bills > Intercompany, "Payments from your group" under the dark flag intercompany_loan_clearing: with the flag off for this company the list
// and the drawer offer no Accept (and do not talk about accepting), while Reject and Dismiss stay; with it on, Accept is in the drawer as
// before. A detail that says off hides Accept even when the list said on; a list answer without the field is off (fail closed).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/supplier-invoices/intercompany' }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyInboxPage from '../../../pages/accounting/supplier-invoices/intercompany';
import { envelope } from './intercompanyFixtures';
import { alloc, detailOf, serve } from './intercompanyInboxFixtures';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const LABEL = 'payment SP-00012 on INV-900';
const section = () => screen.findByRole('region', { name: 'Payments from your group' });
const detailLoads = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => /\/allocations\/a-1$/.test(String(u))).length;

async function openDrawer() {
  render(<IntercompanyInboxPage />);
  const s = await section();
  fireEvent.click(within(s).getByRole('button', { name: `Details for ${LABEL}` }));
  const drawer = await screen.findByRole('dialog');
  await waitFor(() => expect(detailLoads()).toBe(1));
  await waitFor(() => expect(within(drawer).queryByText('Loading')).toBeNull());
  return { s, drawer };
}

describe('the dark flag intercompany_loan_clearing in the inbox', () => {
  it('off: no Accept anywhere and no word about accepting; Reject and Dismiss stay', async () => {
    serve({ items: [], allocations: [alloc()], loanClearingEnabled: false });
    const { s, drawer } = await openDrawer();
    expect(within(drawer).queryByRole('button', { name: `Accept ${LABEL}` })).toBeNull();
    expect(within(drawer).getByRole('button', { name: `Reject ${LABEL}` })).toBeEnabled();
    expect(within(drawer).getByRole('button', { name: `Dismiss ${LABEL}` })).toBeEnabled();
    expect(s.textContent).not.toMatch(/accept/i);
    expect(drawer.textContent).not.toMatch(/accept/i);
    expect(drawer.textContent).not.toMatch(/not enabled|disabled|error/i);
  });

  it('on: the drawer offers Accept, enabled once its preview arrives', async () => {
    serve({ items: [], allocations: [alloc()], loanClearingEnabled: true });
    const { s, drawer } = await openDrawer();
    expect(s.textContent).toMatch(/Accept one to clear it/);
    await waitFor(() => expect(within(drawer).getByRole('button', { name: `Accept ${LABEL}` })).toBeEnabled());
  });

  it('the list said on, the detail says off: no Accept', async () => {
    const item = alloc();
    serve({ items: [], allocations: [item], allocationDetail: { ...detailOf(item, null), loanClearingEnabled: false } });
    const { drawer } = await openDrawer();
    expect(within(drawer).queryByRole('button', { name: `Accept ${LABEL}` })).toBeNull();
    expect(within(drawer).getByRole('button', { name: `Reject ${LABEL}` })).toBeInTheDocument();
  });

  it('a list answer without the field is off (fail closed)', async () => {
    serve({ items: [], allocations: [alloc()] });
    const scripted = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) =>
      (String(url).includes('/allocations?') ? envelope({ items: [alloc()], total: 1, allocationCount: 1 }) : scripted(url as string, init as RequestInit)));
    const { drawer } = await openDrawer();
    expect(within(drawer).queryByRole('button', { name: `Accept ${LABEL}` })).toBeNull();
  });
});
