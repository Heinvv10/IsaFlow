// D2 round 13: the consolidated trial balance load: success shows the accounts, a refusal shows the server
// message, an empty 500 a plain sentence, and a failed reload clears the figures it had.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import GroupTrialBalancePage from '../../../pages/accounting/group/trial-balance';
import { typeDate } from '../../helpers/typeDate';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const TB = {
  groupAccounts: [{ groupAccountCode: '4000', groupAccountName: 'Heron Group Revenue', accountType: 'revenue', entities: { c1: { debit: 0, credit: 500 } },
    eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 0, consolidatedCredit: 500 }],
  entityNames: { c1: 'Heron Holdings' },
  totals: { entities: { c1: { debit: 0, credit: 500 } }, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 0, consolidatedCredit: 500 },
  balanced: false, difference: 500, accountCount: 1, unmapped: { accountCount: 0, value: 0, byEntity: [] }, coterminous: true,
};
const groups = () => on('GET', 'company-groups', () => ok({ items: [{ id: 'g1', name: 'Group One' }] }));
const dateInputs = () => Array.from(document.querySelectorAll('input[placeholder="dd MMM yyyy"]')) as HTMLInputElement[];

describe('consolidated trial balance load', () => {
  it('200: shows the group account and the entity column', async () => {
    serve(groups(), on('GET', 'consolidated-reports', () => ok(TB)));
    render(<GroupTrialBalancePage />);
    expect(await screen.findByText('Heron Group Revenue')).toBeDefined();
    expect(screen.getByText('Heron Holdings')).toBeDefined();
  });
  it('400: the server message and no figures', async () => {
    serve(groups(), on('GET', 'consolidated-reports', () => refuse()));
    render(<GroupTrialBalancePage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.queryByText('Heron Group Revenue')).toBeNull();
  });
  it('empty 500: a plain sentence, no jargon', async () => {
    serve(groups(), on('GET', 'consolidated-reports', empty500));
    render(<GroupTrialBalancePage />);
    expect(await screen.findByText('Could not load the consolidated trial balance - try again')).toBeDefined();
    expectNoJargon();
  });
  it('a failed reload (period changed) clears the figures it had', async () => {
    let n = 0;
    serve(groups(), on('GET', 'consolidated-reports', () => (n++ === 0 ? ok(TB) : empty500())));
    render(<GroupTrialBalancePage />);
    await screen.findByText('Heron Group Revenue');
    expect(document.body.textContent).toMatch(/500[.,]00/);   // the summary cards carry the figures too
    typeDate(dateInputs()[0]!, '2020-01-01');
    expect(await screen.findByText('Could not load the consolidated trial balance - try again')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('Heron Group Revenue')).toBeNull());
    expect(document.body.textContent).not.toMatch(/500[.,]00/);   // nor do the cards keep the old totals
  });
});
