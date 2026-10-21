/**
 * AP-01: a 'pending' or 'unknown' Netcash submission keeps its batch closed until someone has checked Netcash. The
 * submissions page must say so on the row, and must not offer a status poll or a merchant link for a row whose
 * batch_reference is our own batch number (Netcash never gave one).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' }, companyRole: 'admin' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import NetcashSubmissionsPage from '../../../pages/accounting/netcash/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); company.companyRole = 'admin'; });

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

  it('an admin gets a Resolve control on every row that holds the batch (pending, unknown, submitted, processing), polled or not; not on completed/failed', async () => {
    route(() => ok({ items: [
      sub('p', 'pending'), sub('u', 'unknown'),
      { ...sub('f', 'submitted'), netcash_response: { pollFailure: { status: 'rejected' }, latestPoll: { status: 'rejected' } } },
      sub('c', 'submitted'), sub('r', 'processing'), sub('d', 'completed'), sub('x', 'failed'),
    ], total: 7 }));
    render(<NetcashSubmissionsPage />);
    expect(await screen.findByText(/Netcash reported a failure on the last check/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Resolve/ })).toHaveLength(5);
  });

  it('resolving a submitted row warns about paying twice and shows the last poll answer', async () => {
    route(() => ok({ items: [{ ...sub('s', 'submitted'), netcash_response: { latestPoll: { status: 'Processing - 0 errors', at: '2026-10-20T10:00:00.000Z' } } }], total: 1 }));
    render(<NetcashSubmissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Resolve/ }));
    expect(screen.getByText(/paid twice/i)).toBeTruthy();
    expect(screen.getByText(/Processing - 0 errors/)).toBeTruthy();
    expect(screen.queryByLabelText(/Netcash has this batch/i)).toBeNull();
  });

  it('a row Netcash answered after it was resolved says so (lateSendResult)', async () => {
    route(() => ok({ items: [
      { ...sub('l', 'failed'), netcash_response: { lateSendResult: { status: 'submitted' } } }, sub('q', 'failed'),
    ], total: 2 }));
    render(<NetcashSubmissionsPage />);
    expect(await screen.findByText(/Netcash answered this send \(submitted\) after it was resolved/)).toBeTruthy();
    expect(screen.getAllByText(/after it was resolved/)).toHaveLength(1);
  });

  it('round 16: a reference too long for the column links the merchant page by the one kept in netcash_response; an unusable one gets no link', async () => {
    const long = `NC-${'R'.repeat(147)}`;
    route(() => ok({ items: [
      { ...sub('l', 'submitted'), batch_reference: null, netcash_response: { batchReference: long } },
      { ...sub('u', 'submitted'), batch_reference: null, netcash_response: { batchReference: 'NC-\u0007-bell' } },
    ], total: 2 }));
    render(<NetcashSubmissionsPage />);
    await screen.findAllByRole('button', { name: /Check status/ });
    const links = [...document.querySelectorAll('a[href*="merchant.netcash.co.za"]')].map((a) => a.getAttribute('href'));
    expect(links).toEqual([`https://merchant.netcash.co.za/batch/${long}`]);
  });

  it('a manager sees the notes but no Resolve control', async () => {
    company.companyRole = 'manager';
    route(() => ok({ items: [sub('p', 'pending')], total: 1 }));
    render(<NetcashSubmissionsPage />);
    expect(await screen.findByText(/in flight|not recorded/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Resolve/ })).toBeNull();
  });

  it('opening Resolve puts the form in its own full-width row, not in the Actions cell (it must not squeeze the columns)', async () => {
    route(() => ok({ items: [sub('u', 'unknown')], total: 1 }));
    render(<NetcashSubmissionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Resolve/ }));
    const note = screen.getByLabelText(/What did you find at Netcash/i);
    const cell = note.closest('td')!;
    expect(cell.getAttribute('colspan')).toBe('7');
    expect(cell.closest('tr')!.querySelectorAll('td')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByLabelText(/What did you find at Netcash/i)).toBeNull();
  });
});
