// A GatedDateField binds in its own render, after the parent has read gate.blocked, so a date the parent sets itself
// needs gate.reset(key). The forms below clear their dates after a save, with the field still on screen, and a
// refusal typed while the save was in flight must not outlive it as red text behind an open gate.
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';
import { typeDate } from '../helpers/dateFields';
import { GatedDateField, useDateGate } from '@/components/forms/GatedDateField';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true, pathname: '/' }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co1' }, loading: false, companyRole: 'owner' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import { VatPeriodLockForm } from '@/components/accounting/sars/VatPeriodLockForm';
import TasksPage from '../../../pages/accounting/practice/tasks/index';
import StaffRatesPage from '../../../pages/accounting/practice/staff-rates/index';
import StaffCostRatesPage from '../../../pages/accounting/practice/staff-cost-rates/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => vi.mocked(apiFetch).mockReset());
afterEach(cleanup);

const field = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const heldSave = () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
};
const users = [{ id: 'u1', displayName: 'Ann' }];

function Form() {
  const [date, setDate] = useState('2026-10-01');
  const gate = useDateGate();
  const fill = (iso: string) => { gate.reset('when'); setDate(iso); };
  return (
    <>
      <GatedDateField gate={gate} gateKey="when" label="When" value={date || null} onValue={setDate} />
      <button type="button" disabled={gate.blocked}>Save</button>
      <button type="button" onClick={() => setDate('2026-11-02')}>Fill without reset</button>
      <button type="button" onClick={() => fill('2026-11-02')}>Fill</button>
      <button type="button" onClick={() => fill('2026-10-01')}>Fill same</button>
      <button type="button" onClick={() => fill('')}>Clear</button>
    </>
  );
}

describe('a date the parent sets over refused text', () => {
  const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  const refuse = async () => {
    render(<Form />);
    typeDate(field('When'), 'zz');
    await waitFor(() => expect(save().disabled).toBe(true));
  };

  it('without a reset, the text changes but the parent still holds the blocked it read before the field bound', async () => {
    await refuse();
    fireEvent.click(screen.getByRole('button', { name: 'Fill without reset' }));
    await waitFor(() => expect(field('When').value).toBe('02 Nov 2026'));
    expect(save().disabled).toBe(true);
  });

  it.each([
    ['a new date', 'Fill', '02 Nov 2026'],
    ['the date it already held', 'Fill same', '01 Oct 2026'],
    ['nothing', 'Clear', ''],
  ])('with a reset, %s replaces the text and opens the gate in that render', async (_what, button, shown) => {
    await refuse();
    fireEvent.click(screen.getByRole('button', { name: button }));
    await waitFor(() => expect(field('When').value).toBe(shown));
    expect(field('When').getAttribute('aria-invalid')).toBe('false');
    expect(save().disabled).toBe(false);
  });
});

describe('a form that clears its dates after a save, with refused text typed during the save', () => {
  it('VAT period lock', async () => {
    serve(on('GET', '/api/accounting/sars/vat-exceptions', () => ok({ totalExceptions: 0 })));
    const { held, release } = heldSave();
    render(<VatPeriodLockForm onLock={async () => { await held; return null; }} />);
    typeDate(field(/Period start/), '1 Mar 2026');
    typeDate(field(/Period end/), '31 Mar 2026');
    fireEvent.click(screen.getByRole('button', { name: /lock period/i }));
    typeDate(field(/Period start/), 'zz');
    typeDate(field(/Period end/), 'yy');
    release();
    await waitFor(() => expect(field(/Period start/).value).toBe(''));
    expect(field(/Period start/).getAttribute('aria-invalid')).toBe('false');
    expect(field(/Period end/).value).toBe('');
  });

  it('practice task quick add: the refused due date is not left over a form that would post no date', async () => {
    const { held, release } = heldSave();
    serve(
      on('POST', '/api/accounting/practice/tasks', async () => { await held; return ok({ id: 't1' }); }),
      on('GET', '/api/accounting/practice/tasks', () => ok({ tasks: [] })),
      on('GET', '/api/accounting/practice/jobs', () => ok({ jobs: [] })),
      on('GET', '/api/accounting/practice/users', () => ok(users)),
    );
    render(<TasksPage />);
    fireEvent.change(screen.getByPlaceholderText('Task title…'), { target: { value: 'File it' } });
    typeDate(field('Due date'), '1 Mar 2026');
    fireEvent.submit(screen.getByPlaceholderText('Task title…').closest('form')!);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
    typeDate(field('Due date'), 'zz');
    release();
    await waitFor(() => expect(field('Due date').value).toBe(''));
    expect(field('Due date').getAttribute('aria-invalid')).toBe('false');
  });

  it('staff rates', async () => {
    const { held, release } = heldSave();
    serve(
      on('POST', '/api/accounting/practice/staff-rates', async () => { await held; return ok({ id: 'r1' }); }),
      on('GET', '/api/accounting/practice/staff-rates', () => ok([])),
      on('GET', '/api/accounting/practice/users', () => ok(users)),
    );
    render(<StaffRatesPage />);
    fireEvent.change(await screen.findByPlaceholderText('e.g. 850.00'), { target: { value: '100' } });
    const from = field(/Effective From/);
    const shown = from.value;
    typeDate(field(/Effective To/), '30 Mar 2099');
    fireEvent.submit(from.closest('form')!);
    await waitFor(() => expect(screen.getByRole('button', { name: /Saving/ })).toBeTruthy());
    typeDate(from, 'zz');
    typeDate(field(/Effective To/), 'yy');
    release();
    await waitFor(() => expect(from.value).toBe(shown));
    expect(from.getAttribute('aria-invalid')).toBe('false');
    expect(field(/Effective To/).value).toBe('');
  });

  it('staff cost rates', async () => {
    const { held, release } = heldSave();
    serve(
      on('POST', '/api/accounting/practice/staff-cost-rates', async () => { await held; return ok({ id: 'r1' }); }),
      on('GET', '/api/accounting/practice/staff-cost-rates', () => ok([])),
      on('GET', '/api/accounting/practice/users', () => ok(users)),
    );
    render(<StaffCostRatesPage />);
    await screen.findByRole('option', { name: 'Ann' });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'u1' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '100' } });
    const from = field(/Effective from/);
    const shown = from.value;
    typeDate(field(/Effective to/), '30 Mar 2099');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
    typeDate(from, 'zz');
    typeDate(field(/Effective to/), 'yy');
    release();
    await waitFor(() => expect(from.value).toBe(shown));
    expect(from.getAttribute('aria-invalid')).toBe('false');
    expect(field(/Effective to/).value).toBe('');
  });
});
