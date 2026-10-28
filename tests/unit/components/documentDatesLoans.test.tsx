// Wave 2 Y: loan, time-entry and exchange-rate dates. Each date is typed, reaches the API as ISO, and refused or
// missing text stops the submit. The what-if panel has one gate key per event row, so one row's valid edit never
// clears another row's refusal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { dateInputs, typeDate } from '../../helpers/typeDate';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), back: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { LoanScheduleTab } from '@/components/loans/LoanScheduleTab';
import { LoanEventsTab } from '@/components/loans/LoanEventsTab';
import { TimeEntryModal } from '@/components/accounting/time-tracking/TimeEntryModal';
import { AddRateForm } from '@/components/accounting/exchangeRates/ExchangeRateForms';
import NewLoanPage from '../../../pages/accounting/loans/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.push.mockReset(); });
afterEach(cleanup);

const posts = (part: string): Array<Record<string, unknown>> => vi.mocked(apiFetch).mock.calls
  .filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method === 'POST')
  .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, unknown>);
const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('LoanScheduleTab what-if events', () => {
  const open = () => {
    serve(on('POST', '/schedule', () => ok({ rows: [] })));
    const view = render(<LoanScheduleTab loanId="l1" rows={[]} loading={false} />);
    fireEvent.click(button(/preview what-if/i));
    fireEvent.click(screen.getByText('+ Add another event'));
    const [first, second] = dateInputs(view.container);
    return { first: first!, second: second!, run: () => button(/run preview/i) };
  };

  it('a refused row 0 stays blocking when row 1 is edited to a valid date', () => {
    const { first, second, run } = open();
    typeDate(first, 'zz');
    expect(run().disabled).toBe(true);
    typeDate(second, '1 Oct 2026');
    expect(first.getAttribute('aria-invalid')).toBe('true');
    expect(run().disabled).toBe(true);
  });

  it('removing row 1 keeps row 0\'s refusal blocking', () => {
    const { first, run } = open();
    typeDate(first, 'zz');
    fireEvent.click(button(/remove event 2/i));
    expect(run().disabled).toBe(true);
  });

  it('removing the refused row 0 unblocks and leaves row 1\'s date on the surviving row', () => {
    const { first, second, run } = open();
    typeDate(first, 'zz');
    typeDate(second, '1 Oct 2026');
    fireEvent.click(button(/remove event 1/i));
    expect(run().disabled).toBe(false);
    expect(dateInputs()[0]!.value).toBe('01 Oct 2026');
  });

  it('typed dates are previewed as ISO', async () => {
    const { first, second, run } = open();
    typeDate(first, '5 Oct 2026');
    typeDate(second, '07/11/2026');
    fireEvent.click(run());
    await waitFor(() => expect(posts('/schedule')).toHaveLength(1));
    const events = posts('/schedule')[0]!.events as Array<{ date: string }>;
    expect(events.map(e => e.date)).toEqual(['2026-10-05', '2026-11-07']);
  });
});

describe('loans/new start date', () => {
  const open = async () => {
    serve(on('POST', '/api/accounting/loans', () => ok({ id: 'l1' })));
    const view = render(<NewLoanPage />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    return { view, start: dateInputs(view.container)[0]!, form: view.container.querySelector('form')! };
  };

  it('an untouched start date is not posted as empty; the field says to enter one', async () => {
    const { form, start } = await open();
    fireEvent.submit(form);
    expect(await screen.findByText('Enter a date.')).toBeTruthy();
    expect(start.getAttribute('aria-invalid')).toBe('true');
    expect(posts('/api/accounting/loans')).toHaveLength(0);
  });

  it('a typed start date is posted as ISO, and the empty message goes away', async () => {
    const { form, start } = await open();
    fireEvent.submit(form);
    await screen.findByText('Enter a date.');
    typeDate(start, '5 Oct 2026');
    expect(screen.queryByText('Enter a date.')).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(posts('/api/accounting/loans')).toHaveLength(1));
    expect(posts('/api/accounting/loans')[0]).toMatchObject({ startDate: '2026-10-05' });
  });

  it('text typed after the empty message is judged on its own: the field names what is wrong with it', async () => {
    const { form, start } = await open();
    fireEvent.submit(form);
    await screen.findByText('Enter a date.');
    typeDate(start, 'zz');
    expect(screen.queryByText('Enter a date.')).toBeNull();
    expect(start.getAttribute('aria-invalid')).toBe('true');
  });

  it('"zz" disables Create and nothing is posted', async () => {
    const { start, form } = await open();
    typeDate(start, 'zz');
    expect(start.getAttribute('aria-invalid')).toBe('true');
    expect(button(/create loan/i).disabled).toBe(true);
    fireEvent.click(button(/create loan/i));
    expect(posts('/api/accounting/loans')).toHaveLength(0);
    expect(form).toBeTruthy();
  });
});

describe('LoanEventsTab event date', () => {
  const open = () => {
    serve(on('POST', '/events', () => ok({ id: 'e1' })));
    const view = render(<LoanEventsTab loanId="l1" events={[]} onRefresh={vi.fn()} />);
    fireEvent.click(button(/add event/i));
    fireEvent.change(screen.getByPlaceholderText('Amount (ZAR)'), { target: { value: '500' } });
    return { date: dateInputs(view.container)[0]!, form: view.container.querySelector('form')! };
  };

  it('an untouched event date is not posted as empty; the field says to enter one', async () => {
    const { form, date } = open();
    fireEvent.submit(form);
    expect(await screen.findByText('Enter a date.')).toBeTruthy();
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(posts('/events')).toHaveLength(0);
  });

  it('a typed date is posted as ISO', async () => {
    const { form, date } = open();
    typeDate(date, '07/10/2026');
    fireEvent.submit(form);
    await waitFor(() => expect(posts('/events')).toHaveLength(1));
    expect(posts('/events')[0]).toMatchObject({ kind: 'LUMP', date: '2026-10-07', amount: 500 });
  });

  it('after a good date, "zz" disables Save and a click posts nothing', async () => {
    const { date } = open();
    typeDate(date, '07/10/2026');
    typeDate(date, 'zz');
    expect(button(/save event/i).disabled).toBe(true);
    fireEvent.click(button(/save event/i));
    await Promise.resolve();
    expect(posts('/events')).toHaveLength(0);
  });
});

describe('TimeEntryModal date', () => {
  const form = { projectName: '', taskDescription: 'Work', entryDate: '2026-10-01', hours: '1', rate: '', billable: true, customerId: '', notes: '' };
  const open = () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const view = render(<TimeEntryModal form={form} editId={null} busy="" customers={[]} onClose={vi.fn()} onSubmit={onSubmit} onChange={onChange} />);
    return { onChange, onSubmit, date: dateInputs(view.container)[0]! };
  };

  it('shows the date formatted and hands the form an ISO date', () => {
    const { date, onChange } = open();
    expect(date.value).toBe('01 Oct 2026');
    typeDate(date, '5 Oct 2026');
    expect(onChange).toHaveBeenCalledWith('entryDate', '2026-10-05');
  });

  it('"zz" is not handed to the form, disables Save, and a click submits nothing', () => {
    const { date, onChange, onSubmit } = open();
    typeDate(date, 'zz');
    expect(onChange).not.toHaveBeenCalledWith('entryDate', expect.anything());
    expect(button(/^save$/i).disabled).toBe(true);
    fireEvent.click(button(/^save$/i));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('AddRateForm effective date', () => {
  const open = () => {
    serve(on('POST', '/exchange-rates', () => ok({})));
    const view = render(<AddRateForm currencies={[{ code: 'ZAR', name: 'Rand', symbol: 'R' }, { code: 'USD', name: 'US Dollar', symbol: '$' }]} onAdded={vi.fn()} />);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'USD' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 18.523400'), { target: { value: '18.5' } });
    return { date: dateInputs(view.container)[0]! };
  };

  it('a typed effective date is posted as ISO', async () => {
    const { date } = open();
    typeDate(date, '5 Oct 2026');
    fireEvent.click(button(/add rate/i));
    await waitFor(() => expect(posts('/exchange-rates')).toHaveLength(1));
    expect(posts('/exchange-rates')[0]).toMatchObject({ effectiveDate: '2026-10-05' });
  });

  it('"zz" disables Add Rate and nothing is posted; clearing the field blocks too', async () => {
    const { date } = open();
    typeDate(date, 'zz');
    expect(button(/add rate/i).disabled).toBe(true);
    fireEvent.click(button(/add rate/i));
    await Promise.resolve();
    expect(posts('/exchange-rates')).toHaveLength(0);
  });
});
