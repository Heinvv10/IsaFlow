/**
 * K2: the profile's bank card. It asks for the masked view only, shows the server's masks as sent, offers buttons by
 * role (owner / admin change; a manager makes a first entry), shows the server's refusal, and names the last change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const role = vi.hoisted(() => ({ current: 'admin' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.current }) }));

import { EmployeeBankCard } from '@/components/payroll/EmployeeBankCard';

const EMP = '11111111-1111-4111-8111-111111111111';
const ROW_ID = '22222222-2222-4222-8222-222222222222';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refusal = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message } }), { status });
const masked = {
  id: ROW_ID, employeeId: EMP, bankName: 'FNB', accountNumber: '…1234', masked: true, accountType: 'cheque',
  branchCode: '…55', accountHolder: 'K…', effectiveFrom: '2026-11-01',
};
const change = (recordedAt: string) => ({
  items: [{ id: 'c1', entityType: 'payroll_bank_detail', entityId: ROW_ID, entityLabel: 'FNB', op: 'create', fields: [],
    actor: 'u1', actorName: 'Hein', channel: 'session', impersonator: null, recordedAt }],
  nextCursor: null,
});

const fetchMock = vi.fn();
const calls = () => fetchMock.mock.calls.map(([u, init]) => [String(u), (init as RequestInit | undefined)?.method ?? 'GET'] as const);
function serve(opts: { details: unknown; history?: unknown; put?: Response }) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/bank-details') && init?.method === 'PUT') return opts.put ?? ok(masked);
    if (u.includes('/bank-details')) return ok(opts.details);
    if (u.includes('/entity-changes')) return ok(opts.history ?? { items: [], nextCursor: null });
    throw new Error(`unexpected ${u}`);
  });
}
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); role.current = 'admin'; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
function fillAll() {
  fill('Bank name *', 'Capitec'); fill('Branch code *', '470010'); fill('Account number *', '1357924680'); fill('Account holder', 'K One');
}

describe('the masked view', () => {
  it('asks for ?view=masked, never the plain read, and shows the masks as the server sent them', async () => {
    serve({ details: masked, history: change(new Date().toISOString()) });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect(await screen.findByText('•••• 1234')).toBeTruthy();
    expect(screen.getByText('FNB')).toBeTruthy();
    expect(screen.getByText('…55')).toBeTruthy();
    expect(screen.getByText('K…')).toBeTruthy();
    const reads = calls().filter(([u]) => u.includes('/bank-details'));
    expect(reads.length).toBeGreaterThan(0);
    for (const [u, m] of reads) { expect(m).toBe('GET'); expect(u).toContain('view=masked'); }
  });

  it('names the last change from the history, as "Changed 2 days ago by Hein"', async () => {
    serve({ details: masked, history: change(new Date(Date.now() - 2 * 86_400_000 - 60_000).toISOString()) });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect(await screen.findByText('Changed 2 days ago by Hein')).toBeTruthy();
    const histories = calls().map(([u]) => u).filter((u) => u.includes('/entity-changes'));
    expect(histories.length).toBeGreaterThan(1); // the last-change line and the timeline
    for (const u of histories) expect(u).toMatch(new RegExp(`entityType=payroll_bank_detail&employeeId=${EMP}`));
    expect(histories.some((u) => u.includes('entityId='))).toBe(false);
  });

  it('shows the server message when the read is refused', async () => {
    fetchMock.mockResolvedValue(refusal(403, 'Login-as cannot read employee bank details.'));
    render(<EmployeeBankCard employeeId={EMP} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Login-as cannot read employee bank details.');
  });
});

describe('buttons by role', () => {
  it('owner / admin with details: Change, no first-entry button', async () => {
    serve({ details: masked });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect(await screen.findByRole('button', { name: 'Change bank details' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add bank details' })).toBeNull();
  });

  it('a manager with details: no edit at all, and a note why', async () => {
    role.current = 'manager';
    serve({ details: masked });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect(await screen.findByText('•••• 1234')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bank details/ })).toBeNull();
    expect(screen.getByText(/Only an owner or admin can change/)).toBeTruthy();
  });

  it.each(['admin', 'manager'])('a %s with no details: Add bank details', async (r) => {
    role.current = r;
    serve({ details: null });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect(await screen.findByRole('button', { name: 'Add bank details' })).toBeTruthy();
    expect(screen.getByText('No bank details yet.')).toBeTruthy();
  });

  it('a manager first entry for an employee who has been paid shows the server refusal and keeps the form', async () => {
    role.current = 'manager';
    const message = 'Only an owner or admin can enter bank details for an employee who has been paid through an approved run.';
    serve({ details: null, put: refusal(403, message) });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add bank details' }));
    fillAll();
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.getByLabelText('Account number *')).toBeTruthy();
  });

  it('a manager first entry for a never-paid employee saves, and the card shows the masked read', async () => {
    role.current = 'manager';
    let saved = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/bank-details') && init?.method === 'PUT') { saved = true; return ok(masked); }
      if (u.includes('/bank-details')) return ok(saved ? masked : null);
      return ok({ items: [], nextCursor: null });
    });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add bank details' }));
    fillAll();
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    expect(await screen.findByText('•••• 1234')).toBeTruthy();
    const put = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({
      bankName: 'Capitec', branchCode: '470010', accountNumber: '1357924680', accountType: 'cheque', accountHolder: 'K One',
    });
  });
});

describe('roles that may not write', () => {
  it.each(['viewer', 'accountant'])('a %s with no details sees no Add button, and no history request is made', async (r) => {
    role.current = r;
    serve({ details: null });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect(await screen.findByText('No bank details yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add bank details' })).toBeNull();
  });

  it.each(['viewer', 'accountant'])('a %s is refused by the server (403): the card shows its message, no buttons, and no history request', async (r) => {
    role.current = r;
    const message = `Your role (${r}) does not allow viewing payroll detail.`;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/bank-details')) return refusal(403, message);
      throw new Error(`unexpected ${String(url)}`);
    });
    render(<EmployeeBankCard employeeId={EMP} />);
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.queryByRole('button')).toBeNull();
    expect(calls().some(([u]) => u.includes('/entity-changes'))).toBe(false);
  });
});

describe('the history', () => {
  it('shows the bank-detail change rows (masked values only) under the details', async () => {
    const withFields = change(new Date().toISOString());
    (withFields.items[0] as { fields: unknown[] }).fields = [{ key: 'account_number', before: null, after: '…1234', masked: true }];
    serve({ details: masked, history: withFields });
    render(<EmployeeBankCard employeeId={EMP} />);
    const history = await screen.findByTestId('bank-history');
    await waitFor(() => expect(history.textContent).toContain('…1234'));
    expect(history.textContent).toContain('Account number');
  });
});

describe('history fields', () => {
  const withBank = () => {
    const c = change(new Date().toISOString());
    (c.items[0] as { fields: unknown[] }).fields = [
      { key: 'employee_id', before: null, after: '61d641dd-0000-4000-8000-000000000000', masked: false },
      { key: 'account_type', before: null, after: 'cheque', masked: false },
      { key: 'account_number', before: null, after: '…1234', masked: true },
    ];
    return c;
  };

  it('leaves out the employee uuid and words the account type as the card does', async () => {
    serve({ details: masked, history: withBank() });
    render(<EmployeeBankCard employeeId={EMP} />);
    const history = await screen.findByTestId('bank-history');
    await waitFor(() => expect(history.textContent).toContain('…1234'));
    expect(history.textContent).not.toContain('61d641dd');
    expect(history.textContent).not.toContain('Employee');
    expect(history.textContent).toContain('Cheque / current');
    expect(history.textContent).not.toMatch(/\bcheque\b/);
  });

  it('offers no Reveal control to an owner or admin on the profile', async () => {
    for (const r of ['owner', 'admin']) {
      cleanup();
      role.current = r;
      serve({ details: masked, history: withBank() });
      render(<EmployeeBankCard employeeId={EMP} />);
      const history = await screen.findByTestId('bank-history');
      await waitFor(() => expect(history.textContent).toContain('…1234'));
      expect(screen.queryByText(/Reveal/)).toBeNull();
    }
  });
});

describe('removing the holder', () => {
  const putBody = () => JSON.parse((fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PUT')![1] as RequestInit).body as string);

  it('the checkbox shows only when the details name a holder', async () => {
    serve({ details: { ...masked, accountHolder: null } });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change bank details' }));
    expect(screen.queryByLabelText('Remove account holder')).toBeNull();
  });

  it('ticked: no retype needed, the holder field is off, and the PUT sends an explicit null', async () => {
    serve({ details: masked });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change bank details' }));
    fill('Branch code *', '470010'); fill('Account number *', '1357924680');
    fireEvent.click(screen.getByLabelText('Remove account holder'));
    expect((screen.getByLabelText('Account holder') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(calls().some(([, m]) => m === 'PUT')).toBe(true));
    expect(putBody().accountHolder).toBeNull();
  });

  it('unticked: the retyped holder is sent as typed', async () => {
    serve({ details: masked });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change bank details' }));
    fill('Branch code *', '470010'); fill('Account number *', '1357924680'); fill('Account holder', 'K One');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(calls().some(([, m]) => m === 'PUT')).toBe(true));
    expect(putBody().accountHolder).toBe('K One');
  });
});

describe('a change keeps the holder', () => {
  it('needs the holder typed again when the details name one, and sends nothing until it is', async () => {
    serve({ details: masked });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change bank details' }));
    fill('Branch code *', '470010'); fill('Account number *', '1357924680');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(screen.getByLabelText('Account holder').getAttribute('aria-invalid')).toBe('true'));
    expect(calls().some(([, m]) => m === 'PUT')).toBe(false);
    fill('Account holder', 'K One');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(calls().some(([, m]) => m === 'PUT')).toBe(true));
  });

  it('does not ask for it when the current details have none', async () => {
    serve({ details: { ...masked, accountHolder: null } });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change bank details' }));
    fill('Branch code *', '470010'); fill('Account number *', '1357924680');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(calls().some(([, m]) => m === 'PUT')).toBe(true));
  });
});

describe('another employee', () => {
  it('a slow answer for the first employee never replaces the second', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes(EMP)) return new Promise<Response>((res) => { release = res; });
      if (u.includes('/bank-details')) return Promise.resolve(ok({ ...masked, bankName: 'Capitec', employeeId: OTHER }));
      return Promise.resolve(ok({ items: [], nextCursor: null }));
    });
    const { rerender } = render(<EmployeeBankCard employeeId={EMP} />);
    rerender(<EmployeeBankCard employeeId={OTHER} />);
    expect(await screen.findByText('Capitec')).toBeTruthy();
    release(ok({ ...masked, bankName: 'FNB' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('FNB')).toBeNull();
  });
});

describe('the reload after a save', () => {
  it('does not land on another employee the page has moved to', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    let release: (r: Response) => void = () => undefined;
    let first = true;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/bank-details') && init?.method === 'PUT') return Promise.resolve(ok(masked));
      if (u.includes(`${EMP}/bank-details`)) {
        if (first) { first = false; return Promise.resolve(ok(null)); }
        return new Promise<Response>((res) => { release = res; }); // the reload after the save, held
      }
      if (u.includes('/bank-details')) return Promise.resolve(ok({ ...masked, bankName: 'Capitec' }));
      return Promise.resolve(ok({ items: [], nextCursor: null }));
    });
    const { rerender } = render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add bank details' }));
    fillAll();
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(calls().filter(([u]) => u.includes(`${EMP}/bank-details`)).length).toBeGreaterThan(2));
    rerender(<EmployeeBankCard employeeId={OTHER} />);
    expect(await screen.findByText('Capitec')).toBeTruthy();
    release(ok({ ...masked, bankName: 'FNB' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('FNB')).toBeNull();
  });
});

describe('the form', () => {
  it('stops a short branch code on the field before any PUT', async () => {
    serve({ details: null });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add bank details' }));
    fillAll(); fill('Branch code *', '123');
    fireEvent.click(screen.getByRole('button', { name: 'Save bank details' }));
    await waitFor(() => expect(screen.getByLabelText('Branch code *').getAttribute('aria-invalid')).toBe('true'));
    expect(calls().some(([, m]) => m === 'PUT')).toBe(false);
  });

  it('a change by an admin starts with the bank name and type, and never the number', async () => {
    serve({ details: masked });
    render(<EmployeeBankCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change bank details' }));
    expect((screen.getByLabelText('Bank name *') as HTMLInputElement).value).toBe('FNB');
    expect((screen.getByLabelText('Account number *') as HTMLInputElement).value).toBe('');
  });
});
