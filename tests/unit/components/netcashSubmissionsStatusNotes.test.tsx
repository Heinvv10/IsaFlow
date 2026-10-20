/**
 * AP-01: a 'pending' or 'unknown' Netcash submission keeps its batch closed until someone has checked Netcash. The
 * submissions page must say so on the row, and must not offer a status poll or a merchant link for a row whose
 * batch_reference is our own batch number (Netcash never gave one).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));

import NetcashSubmissionsPage from '../../../pages/accounting/netcash/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const sub = (id: string, status: string) => ({ id, submission_type: 'eft_payment', status, batch_reference: `OUR-${id}`,
  total_amount_cents: 100, record_count: 1, submitted_at: null, created_at: '2026-01-01', created_by: null });

describe('netcash submissions page: rows that hold a batch', () => {
  it.each([['pending', /in flight|not recorded/i], ['unknown', /no definite answer/i]])(
    'a %s row explains it and offers no status poll or merchant link', async (status, note) => {
      route(() => ok({ items: [sub('x1', status)], total: 1 }));
      render(<NetcashSubmissionsPage />);
      expect(await screen.findByText(note)).toBeTruthy();
      expect(screen.getAllByText(/check Netcash before resubmitting/i).length).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /Check status/ })).toBeNull();
      expect(document.querySelector('a[href*="merchant.netcash.co.za"]')).toBeNull();
    });

  it('a submitted row still offers the poll and the merchant link', async () => {
    route(() => ok({ items: [sub('x2', 'submitted')], total: 1 }));
    render(<NetcashSubmissionsPage />);
    expect(await screen.findByRole('button', { name: /Check status/ })).toBeTruthy();
    expect(document.querySelector('a[href*="merchant.netcash.co.za"]')).not.toBeNull();
  });
});
