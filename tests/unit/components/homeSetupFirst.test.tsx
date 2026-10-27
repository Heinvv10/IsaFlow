/**
 * W2 H: while setup is open the checklist sits ABOVE the hero (it used to sit at
 * y = 846–1050, below the fold), and TodoWidget does not claim "All caught up!".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'owner' }, loading: false }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' }, companies: [{ companyId: 'co-1' }], loading: false }) }));
vi.mock('@/components/accounting/dashboard/OverviewTab', () => ({ OverviewTab: ({ setupOpen }: { setupOpen: boolean }) => <p>overview setupOpen={String(setupOpen)}</p> }));
vi.mock('@/components/accounting/dashboard/DashboardHero', () => ({ DashboardHero: () => <p>the hero</p> }));

import { TodoWidget } from '@/components/accounting/dashboard/TodoWidget';
import AccountingPage from '../../../pages/accounting/index';
import { buildSetupProgress } from '../../../src/modules/accounting/services/core/setupProgressService';
import { NO_FACTS, ALL_FACTS } from '../helpers/setupFacts';

useApiJsonOverMock();
afterEach(cleanup);

const serveSetup = (allDone: boolean) => script((u) => (u.includes('setup-checklist')
  ? ok(buildSetupProgress(allDone ? ALL_FACTS : NO_FACTS)) : ok({})));

describe('Home: checklist first while setup is open', () => {
  it('renders the checklist before the hero, and tells the overview setup is open', async () => {
    serveSetup(false);
    render(<AccountingPage />);
    const checklist = await screen.findByText('Finish setting up');
    const hero = screen.getByText('the hero');
    expect(checklist.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('overview setupOpen=true')).toBeTruthy();
  });

  it('no checklist once setup is complete', async () => {
    serveSetup(true);
    render(<AccountingPage />);
    await screen.findByText('the hero');
    expect(screen.queryByText('Finish setting up')).toBeNull();
    expect(screen.getByText('overview setupOpen=false')).toBeTruthy();
  });
});

describe('TodoWidget empty state', () => {
  const clear = { overdueInvoices: [], overdueInvoiceCount: 0, pendingSupplierPayments: [], uncategorizedBankTxns: 0, draftInvoices: 0 };

  it('says "Finish setup" instead of "All caught up!" while setup is open', async () => {
    script(() => ok(clear));
    render(<TodoWidget setupOpen />);
    expect(await screen.findByText('Finish setup to see your daily tasks')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
  });

  it('still says "All caught up!" once setup is complete', async () => {
    script(() => ok(clear));
    render(<TodoWidget setupOpen={false} />);
    expect(await screen.findByText('All caught up!')).toBeTruthy();
    expect(screen.queryByText('Finish setup to see your daily tasks')).toBeNull();
  });
});
