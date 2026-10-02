/**
 * D2 error envelope, group g2b: migration hub / validate, opening balances, staff rates,
 * recurring journals and Sage migration show the server's message from a real
 * { success:false, error:{ code, message } } envelope instead of a generic fallback.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'admin' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import MigrationHubPage from '../../../pages/accounting/migration';
import ValidatePage from '../../../pages/accounting/migration/validate';
import OpeningBalancesIndexPage from '../../../pages/accounting/opening-balances';
import StaffRatesPage from '../../../pages/accounting/practice/staff-rates';
import RecurringJournalsPage from '../../../pages/accounting/recurring-journals';
import SageMigrationPage from '../../../pages/accounting/sage-migration';

void mockedApiFetchModule;
useApiJsonOverMock();

type Handler = (url: string, init?: RequestInit) => Response | undefined;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (message: string, status = 422) => json({ success: false, error: { code: 'VALIDATION_ERROR', message } }, status);

/** `handler` answers what the test cares about; everything else is an empty success. */
function script(handler: Handler) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => handler(String(url), init) ?? ok({}));
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

it('migration hub: a refused session create shows the server message', async () => {
  const MSG = 'D2 server says no: a migration session is already running for this company';
  script((u, init) => {
    if (u.includes('/migration/session')) return init?.method === 'POST' ? refuse(MSG, 409) : ok(null);
    return undefined;
  });
  render(<MigrationHubPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Sage Business Cloud/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed to start migration')).toBeNull();
});

const SESSION = { session: { id: 's-1', status: 'active' } };

it('migration validate: a refused validation run shows the server message', async () => {
  const MSG = 'D2 server says no: validation needs the chart of accounts imported first';
  script((u) => {
    if (u.includes('/migration/validate')) return refuse(MSG);
    if (u.includes('/migration/session')) return ok(SESSION);
    return undefined;
  });
  render(<ValidatePage />);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Validation failed')).toBeNull();
});

it('migration validate: a refused completion shows the server message', async () => {
  const MSG = 'D2 server says no: 2 unposted opening-balance journals block go-live';
  script((u, init) => {
    if (u.includes('/migration/validate')) return ok({ sessionId: 's-1', allPassed: true, checks: [{ id: 'c1', label: 'TB balances', passed: true, status: 'pass' }] });
    if (u.includes('/migration/session')) return init?.method === 'POST' ? refuse(MSG, 409) : ok(SESSION);
    return undefined;
  });
  render(<ValidatePage />);
  fireEvent.click(await screen.findByRole('button', { name: /Complete Migration/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed to complete migration')).toBeNull();
});

it('opening balances: a refused save shows the server message', async () => {
  const MSG = 'D2 server says no: opening balances already posted for FY2026';
  const acct = (id: string, code: string, d: number, c: number) => ({ id, account_code: code, account_name: code, account_type: 'asset', normal_balance: 'debit', opening_debit: d, opening_credit: c });
  script((u, init) => {
    if (u.includes('/opening-balances')) {
      return init?.method === 'POST' ? refuse(MSG, 409) : ok({ accounts: [acct('a1', '1000', 50, 0), acct('a2', '3000', 0, 50)] });
    }
    return undefined;
  });
  render(<OpeningBalancesIndexPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Save Opening Balances/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed to save')).toBeNull();
  expect(screen.queryByText('Save request failed')).toBeNull();
});

it.each([
  ['the server message', 'D2 server says no: this rate overlaps an existing rate period', 'D2 server says no: this rate overlaps an existing rate period'],
  ['a plain sentence for an empty 500', '', 'Could not add the rate - try again'],
])('staff rates: a refused add shows %s', async (_n, MSG, EXPECTED) => {
  script((u, init) => {
    if (u.includes('/practice/users')) return ok([{ id: 'u-1', email: 'a@b.co', firstName: 'A', lastName: 'B', displayName: 'A B', companyRole: 'admin' }]);
    if (u.includes('/practice/staff-rates')) return init?.method === 'POST' ? (MSG ? refuse(MSG) : new Response('', { status: 500 })) : ok([]);
    return undefined;
  });
  const { container } = render(<StaffRatesPage />);
  const rate = await screen.findByPlaceholderText('e.g. 850.00');
  fireEvent.change(rate, { target: { value: '900' } });
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(EXPECTED)).toBeTruthy();
  expect(screen.queryByText(/^HTTP \d+$/)).toBeNull();
});

it('recurring journals: a refused template save shows the server message', async () => {
  const MSG = 'D2 server says no: next run date is inside a closed fiscal period';
  const item = { id: 'r-1', templateName: 'Monthly rent', frequency: 'monthly', nextRunDate: '2027-06-01', runCount: 0, status: 'active', totalAmount: 1000, lines: [] };
  script((u, init) => {
    if (u.includes('/recurring-journals')) return init?.method === 'PUT' ? refuse(MSG) : ok({ items: [item] });
    return undefined;
  });
  const { container } = render(<RecurringJournalsPage />);
  await screen.findByText('Monthly rent');
  fireEvent.click(screen.getByTitle('Edit'));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed')).toBeNull();
});

const STATUS = {
  accounts: { sageTotal: 10, mapped: 5, unmapped: 5, autoMapped: 0 },
  ledger: { sageTotal: 10, imported: 0, pending: 10, failed: 0, dateRange: { earliest: null, latest: null } },
  invoices: { sageTotal: 10, imported: 0, pending: 10, failed: 0 },
  lastRuns: [],
};

it('sage migration: a refused status load shows the server message', async () => {
  const MSG = 'D2 server says no: Sage sync tables are locked by a running sync';
  script((u) => (u.includes('/sage-migration') ? refuse(MSG, 503) : undefined));
  render(<SageMigrationPage />);
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Failed to load')).toBeNull();
});

it('sage migration: a refused action shows the server message', async () => {
  const MSG = 'D2 server says no: 5 Sage accounts are unmapped, auto-map cannot run';
  script((u) => {
    if (u.includes('/sage-migration-action')) return refuse(MSG, 409);
    if (u.includes('/sage-migration')) return ok(STATUS);
    return undefined;
  });
  render(<SageMigrationPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Auto-Map/ }));
  expect(await screen.findByText(MSG)).toBeTruthy();
  expect(screen.queryByText('Action failed')).toBeNull();
});

it('success: migration hub renders the data it received', async () => {
  script((u, init) => {
    if (u.includes('/migration/session')) return init?.method === 'POST' ? ok({ session: { id: 's-9', sourceSystem: 'Zeta Books Ledger', status: 'active', startedAt: '2026-05-01', stepsCompleted: {} } }) : ok(null);
    return undefined;
  });
  render(<MigrationHubPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Sage Business Cloud/ }));
  expect(await screen.findByText(/From: Zeta Books Ledger/)).toBeTruthy();
});

it('success: migration validate renders the data it received', async () => {
  script((u) => {
    if (u.includes('/migration/validate')) return ok({ sessionId: 's-1', allPassed: true, checks: [{ id: 'c1', label: 'Zeta trial balance foots', passed: true, status: 'pass' }] });
    if (u.includes('/migration/session')) return ok(SESSION);
    return undefined;
  });
  render(<ValidatePage />);
  expect(await screen.findByText('Zeta trial balance foots')).toBeTruthy();
});

it('success: migration validate completion completes', async () => {
  script((u, init) => {
    if (u.includes('/migration/validate')) return ok({ sessionId: 's-1', allPassed: true, checks: [{ id: 'c1', label: 'TB balances', passed: true, status: 'pass' }] });
    if (u.includes('/migration/session')) return init?.method === 'POST' ? ok({}) : ok(SESSION);
    return undefined;
  });
  render(<ValidatePage />);
  fireEvent.click(await screen.findByRole('button', { name: /Complete Migration/ }));
  expect(await screen.findByText('Migration Complete!')).toBeTruthy();
});

it('success: opening balances renders the data it received and the save completes', async () => {
  const acct = (id: string, name: string, d: number, c: number) => ({ id, account_code: id, account_name: name, account_type: 'asset', normal_balance: 'debit', opening_debit: d, opening_credit: c });
  script((u, init) => {
    if (u.includes('/opening-balances')) return init?.method === 'POST' ? ok({}) : ok({ accounts: [acct('a1', 'Zeta Cash Float', 50, 0), acct('a2', 'Zeta Equity', 0, 50)] });
    return undefined;
  });
  render(<OpeningBalancesIndexPage />);
  expect(await screen.findByText('Zeta Cash Float')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Save Opening Balances/ }));
  expect(await screen.findByText('Opening balances saved as journal entry')).toBeTruthy();
});

it('success: staff rates renders the data it received after an add', async () => {
  let added = false;
  script((u, init) => {
    if (u.includes('/practice/users')) return ok([{ id: 'u-1', email: 'a@b.co', firstName: 'A', lastName: 'B', displayName: 'A B', companyRole: 'admin' }]);
    if (u.includes('/practice/staff-rates')) {
      if (init?.method === 'POST') { added = true; return ok({}); }
      return ok(added ? [{ id: 'r-1', rate: 777.77, currency: 'ZAR', effectiveFrom: '2026-01-01', effectiveTo: null, createdAt: '2026-01-01' }] : []);
    }
    return undefined;
  });
  const { container } = render(<StaffRatesPage />);
  fireEvent.change(await screen.findByPlaceholderText('e.g. 850.00'), { target: { value: '777.77' } });
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText(/ZAR 777[.,\s]77 \/hr/)).toBeTruthy();
});

it('success: recurring journals renders the data it received and the save completes', async () => {
  let name = 'Monthly rent';
  const item = () => ({ id: 'r-1', templateName: name, frequency: 'monthly', nextRunDate: '2027-06-01', runCount: 0, status: 'active', totalAmount: 1000, lines: [] });
  script((u, init) => {
    if (u.includes('/recurring-journals')) {
      if (init?.method === 'PUT') { name = 'Zeta quarterly fee'; return ok({}); }
      return ok({ items: [item()] });
    }
    return undefined;
  });
  const { container } = render(<RecurringJournalsPage />);
  await screen.findByText('Monthly rent');
  fireEvent.click(screen.getByTitle('Edit'));
  fireEvent.submit(container.querySelector('form')!);
  expect(await screen.findByText('Zeta quarterly fee')).toBeTruthy();
  expect(screen.queryByPlaceholderText('Template Name *')).toBeNull();
});

it('success: sage migration renders the status it received', async () => {
  script((u) => (u.includes('/sage-migration') ? ok({ ...STATUS, accounts: { sageTotal: 73, mapped: 5, unmapped: 68, autoMapped: 0 } }) : undefined));
  render(<SageMigrationPage />);
  expect(await screen.findByText(/5\/73 accounts mapped/)).toBeTruthy();
});

it('success: sage migration action completes', async () => {
  script((u) => {
    if (u.includes('/sage-migration-action')) return ok({ succeeded: 68, failed: 0, skipped: 5 });
    if (u.includes('/sage-migration')) return ok(STATUS);
    return undefined;
  });
  render(<SageMigrationPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Auto-Map/ }));
  expect(await screen.findByText(/auto_map: 68 succeeded, 0 failed, 5 skipped/)).toBeTruthy();
});
