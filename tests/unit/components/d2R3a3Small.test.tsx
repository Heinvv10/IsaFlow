/**
 * D2 round 3 (a3): assets/new submit, below-threshold expense, receipt-match confirm, dunning save/deactivate.
 * A 400 shows the server's message, an empty-body 500 a plain sentence (never a JSON parse error), a 200 takes
 * effect; a failed load clears the old rows and never renders an empty-but-valid view.
 */
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const push = vi.fn();
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push, replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import AssetNewPage from '../../../pages/accounting/assets/new';
import BelowThresholdPage from '../../../pages/accounting/assets/below-threshold';
import ReceiptMatchPage from '../../../pages/accounting/ar/receipt-match/index';
import DunningPage from '../../../pages/accounting/ar/dunning/index';
import { MSG, bad, boom, expectNoRawJsonError, ok } from '../helpers/d2CensusG4';
import { trio3 } from '../helpers/d2R3a3';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.unstubAllGlobals(); });

const isGet = (init?: RequestInit) => !init?.method || init.method === 'GET';
const clickBtn = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));

describe('assets/new submit', () => {
  trio3({ name: 'create asset', render: () => render(<AssetNewPage />), drive: async () => { await screen.findByRole('button', { name: /./ }); fireEvent.submit(document.querySelector('form')!); },
    match: (u, i) => u.endsWith('/accounting/assets') && i?.method === 'POST', data: { id: 'a1' },
    others: u => (u.includes('assets-categories') ? ok([]) : undefined), plain: 'Could not create the asset - try again',
    succeeds: async () => { await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/assets')); },
    stays: () => { expect(push).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: /^(save|create)/i })).toBeTruthy(); } });
});

const ASSET = { id: 'a1', asset_number: 'A-D2-1', name: 'D2 Drill', cost: 1200, threshold: 5000, category_name: 'Tools', status: 'available',
  created_at: '2026-01-15', belowThreshold: true, expensed: false, suggestedTreatment: 'expense' };

describe('below-threshold', () => {
  it('a failed load clears the rows and does not claim there are no assets', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => boom());
    render(<BelowThresholdPage />);
    expect(await screen.findByText('Could not load assets - try again')).toBeTruthy();
    expect(screen.queryByText(/No assets below the capitalization threshold/)).toBeNull();
    expectNoRawJsonError();
  });
  trio3({ name: 'expense asset', render: () => render(<BelowThresholdPage />), drive: async () => { await clickBtn(/post to gl/i); },
    match: (u, i) => i?.method === 'POST', data: {}, others: (u, i) => (isGet(i) ? ok([ASSET]) : undefined),
    plain: 'Could not post the expense - try again', succeeds: async () => { expect(await screen.findByText('Expensed')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Expensed')).toBeNull(); } });
});

const TX = { id: 'tx-1', transactionDate: '2031-03-01', amount: 500, description: 'D2 Receipt Acme', reference: 'R1' };
const CAND = { type: 'customer_invoice', id: 'inv-1', label: 'INV-D2-9', amount: 500, date: '2031-03-01', score: 90 };
const rmOthers = (u: string, i?: RequestInit) => {
  if (u.includes('bank-transactions')) return ok({ transactions: [TX] });
  if (u.includes('receipt-match/tx-1') && isGet(i)) return ok({ candidates: [CAND], bankTransaction: TX });
  return undefined;
};

describe('receipt-match', () => {
  it('a failed receipts load clears the list and does not say all receipts are allocated', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => bad());
    render(<ReceiptMatchPage />);
    expect((await screen.findAllByText(MSG)).length).toBeGreaterThan(0);
    expect(screen.queryByText('All receipts allocated')).toBeNull();
  });
  trio3({ name: 'confirm match', render: () => render(<ReceiptMatchPage />), drive: async () => { await clickBtn(/^confirm/i); },
    match: (u, i) => u.endsWith('/confirm') && i?.method === 'POST', data: {}, others: rmOthers, plain: 'Could not confirm the match - try again',
    succeeds: async () => { expect(await screen.findByText('All receipts allocated')).toBeTruthy(); },
    stays: () => { expect(screen.getByText('D2 Receipt Acme')).toBeTruthy(); expect(screen.queryByText('All receipts allocated')).toBeNull(); } });
});

const TPL = { id: 't-1', name: 'D2 Polite Nudge', tone: 'polite', escalation_order: 1, days_overdue_min: 1, days_overdue_max: 7, subject_template: 's', body_template: 'b',
  send_weekdays_only: true, active: true };
const dnOthers = (u: string, i?: RequestInit) => {
  if (u.includes('dunning/settings')) return ok({ settings: { auto_send_enabled: false, min_outstanding_zar: 100 } });
  if (u.includes('dunning/templates') && isGet(i)) return ok({ templates: [TPL] });
  return undefined;
};

describe('dunning', () => {
  it('a failed load clears the templates and settings and does not say none are configured', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => (String(url).includes('dunning/templates') && ++gets > 0 ? boom() : ok({ settings: null })));
    render(<DunningPage />);
    expect(await screen.findByText('Could not load dunning templates - try again')).toBeTruthy();
    expect(screen.queryByText(/No templates configured/)).toBeNull();
    expect(screen.queryByText('D2 Polite Nudge')).toBeNull();
    expectNoRawJsonError();
  });
  trio3({ name: 'save template', render: () => render(<DunningPage />), drive: async () => { fireEvent.click(await screen.findByLabelText('Edit D2 Polite Nudge')); await clickBtn(/^save/i); },
    match: (u, i) => u.includes('dunning/templates/t-1') && i?.method === 'PUT', data: { ...TPL, name: 'D2 Renamed Nudge' }, others: dnOthers,
    plain: 'Could not save the template - try again', succeeds: async () => { expect(await screen.findByText('D2 Renamed Nudge')).toBeTruthy(); expect(screen.queryByRole('button', { name: /^save/i })).toBeNull(); },
    stays: () => { expect(screen.getByRole('button', { name: /^save/i })).toBeTruthy(); } });
  trio3({ name: 'deactivate template', render: () => { vi.stubGlobal('confirm', () => true); return render(<DunningPage />); },
    drive: async () => { fireEvent.click(await screen.findByLabelText('Deactivate D2 Polite Nudge')); },
    match: (u, i) => u.includes('dunning/templates/t-1') && i?.method === 'DELETE', data: {}, others: dnOthers,
    plain: 'Could not deactivate the template - try again', succeeds: async () => { expect(await screen.findByText('inactive')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('inactive')).toBeNull(); } });
});
