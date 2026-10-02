/**
 * D2 round 6 (g1): pages whose load / write handling changed beyond a wording swap. Loans portfolio and compliance
 * (a failed load clears the stale figures and says why), AFS mapping (a refused map keeps the suggestion), the approval
 * enforcement switch (a failed reload after a good write is reported separately and never rejects), the invitation page
 * (an auth outage with an empty body is a sentence, not a JSON error). REAL assertOk / apiErrorMessage over apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const router = vi.hoisted(() => ({ query: { documentId: 'doc-1', token: 'tok-1' } as Record<string, string>, push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/afs/compliance-sections', () => ({
  ScoreRing: () => null, IssueList: () => null, CipcGuideSection: () => <p>GUIDE SHOWN</p>, AlertsSection: () => null,
}));

import { apiFetch } from '@/lib/apiFetch';
import LoansIndexPage from '../../../pages/accounting/loans/index';
import CompliancePage from '../../../pages/accounting/afs/[documentId]/compliance';
import AfsMappingPage from '../../../pages/accounting/afs/mapping';
import AcceptInvitePage from '../../../pages/accept-invite';
import { ApprovalEnforcementPanel } from '../../../src/components/accounting/approvals/ApprovalEnforcementPanel';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('loans portfolio', () => {
  const LOAN = { id: 'l1', reference: 'D2-LN-1', product: 'bond', status: 'active', rateMode: 'FIXED', fixedRate: 10, margin: 0, currentBalance: 1 };
  it('a failed load says why, shows no loans and no "create your first loan" prompt', async () => {
    script((u) => (u.includes('summary') ? ok({}) : empty500()));
    render(<LoansIndexPage />);
    expect(await screen.findByText('Could not load the loan portfolio - try again')).toBeTruthy();
    expect(screen.queryByText(/Create your first loan/)).toBeNull(); expectNoRawError();
  });
  it('a refused load shows the server message', async () => { script(() => refuse()); render(<LoansIndexPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('a good load lists the loans with no error', async () => {
    script((u) => (u.includes('summary') ? ok(null) : ok([LOAN]))); render(<LoansIndexPage />);
    expect(await screen.findByText('D2-LN-1')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('afs compliance', () => {
  const PIS = { total: 90, requiredFramework: 'full_ifrs', requiredAudit: 'voluntary', turnoverPoints: 1, liabilityPoints: 2, dataUnavailable: [] };
  const guide = () => ok({ steps: [] });
  it('a failed load shows a sentence and none of the old figures', async () => {
    let failing = false;
    script((u) => (failing && u.includes('pis-score') ? empty500() : u.includes('cipc-filing-guide') ? guide() : u.includes('pis-score') ? ok(PIS) : undefined));
    render(<CompliancePage />);
    await screen.findByText('GUIDE SHOWN');
    failing = true;
    cleanup(); render(<CompliancePage />);
    expect(await screen.findByText('Could not load the PIS score - try again')).toBeTruthy();
    expect(screen.queryByText('GUIDE SHOWN')).toBeNull(); expectNoRawError();
  });
  it('a refused load shows the server message', async () => { script((u) => (u.includes('pis-score') ? refuse() : undefined)); render(<CompliancePage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('failing alerts alone do not hide the page', async () => {
    script((u) => (u.includes('compliance-alerts') ? empty500() : u.includes('pis-score') ? ok(PIS) : guide()));
    render(<CompliancePage />);
    expect(await screen.findByText('GUIDE SHOWN')).toBeTruthy();
  });
});

describe('afs mapping', () => {
  const SUGGESTION = { glAccountId: 'g1', accountCode: '1000', accountName: 'D2 Suggested Account', suggestedCode: 'BS1', suggestedLabel: 'Cash', confidence: 'high' };
  const LINE = { id: 'ln1', code: 'BS1', section: 'balance_sheet', label: 'Cash', parentCode: null, noteNumber: null, sortOrder: 1, combineGroup: null, isHeader: false, isTotal: false, isActive: true };
  const serve = (put: () => Response) => script((u, m) => (m === 'POST' && u.includes('auto-map') ? ok({ mapped: 0, skipped: 0, suggestions: [SUGGESTION] })
    : m === 'PUT' ? put() : u.includes('/lines') ? ok([LINE]) : u.includes('/stats') ? ok(null) : ok([])));
  const accept = async () => { render(<AfsMappingPage />); fireEvent.click(await screen.findByRole('button', { name: /auto-map accounts/i })); fireEvent.click(await screen.findByRole('button', { name: /^accept$/i })); };
  it('a refused map keeps the suggestion and shows the server message', async () => {
    serve(refuse); await accept();
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(screen.getByText('D2 Suggested Account')).toBeTruthy();
  });
  it('an empty-body 500 keeps the suggestion and says it plainly', async () => {
    serve(empty500); await accept();
    expect(await screen.findByText('Could not map the account - try again')).toBeTruthy(); expect(screen.getByText('D2 Suggested Account')).toBeTruthy(); expectNoRawError();
  });
  it('a good map drops the suggestion', async () => {
    serve(() => ok({})); await accept();
    await waitFor(() => expect(screen.queryByText('D2 Suggested Account')).toBeNull());
  });
});

describe('approval enforcement switch', () => {
  const DATA = { items: [], enforceable: ['supplier_invoice'], preview: { supplier_invoice: 2 } };
  const toggle = async () => { render(<ApprovalEnforcementPanel />); fireEvent.click(await screen.findByRole('checkbox')); };
  it('a good write whose reload then fails reports the reload, not a failed change, and never rejects', async () => {
    let reloads = 0;
    script((u, m) => (m === 'POST' ? ok({}) : ++reloads === 1 ? ok(DATA) : empty500()));
    await toggle();
    expect(await screen.findByText('Could not load approval enforcement - try again')).toBeTruthy();
    expect(screen.queryByText(/Could not change approval enforcement/)).toBeNull();
  });
  it('a refused write shows the server message and the switch stays', async () => {
    script((u, m) => (m === 'POST' ? refuse() : ok(DATA))); await toggle();
    expect(await screen.findByText(MSG)).toBeTruthy(); expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
  it('a transport failure on the first load is shown, not an unhandled rejection', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch'));
    render(<ApprovalEnforcementPanel />);
    expect(await screen.findByText('Could not load approval enforcement - try again')).toBeTruthy();
  });
});

describe('invitation page', () => {
  it('an outage (empty 503) on load is a sentence, not a JSON parse error', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    render(<AcceptInvitePage />);
    expect(await screen.findByText('Could not load the invitation - try again shortly')).toBeTruthy(); expectNoRawError();
  });
  it('a 404 envelope keeps the server message', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'D2 invitation expired' } }), { status: 404 }));
    render(<AcceptInvitePage />);
    expect(await screen.findByText('D2 invitation expired')).toBeTruthy();
  });
  it('an outage while accepting keeps the form and says so plainly', async () => {
    const invite = { success: true, data: { email: 'a@b.c', role: 'admin', company_name: 'D2 Co' } };
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => (init?.method === 'POST' ? new Response('', { status: 503 }) : new Response(JSON.stringify(invite), { status: 200 })));
    const { container } = render(<AcceptInvitePage />);
    const pw = await waitFor(() => { const i = container.querySelector('input[type="password"]'); if (!i) throw new Error('form not shown yet'); return i; });
    fireEvent.change(pw, { target: { value: 'D2-long-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: /accept invitation/i }));
    expect(await screen.findByText('Could not accept the invitation - try again shortly')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled(); expectNoRawError();
  });
});
