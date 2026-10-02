// D2 round 7 (k3): aging panel, payroll cards, practice time entry, onboarding company check.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const logs = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: logs }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/components/practice/BulkRangeModal', () => ({ BulkRangeModal: () => null }));
vi.mock('@/components/onboarding/SmartSetupChoice', () => ({ SmartSetupChoice: () => <p>smart setup choice</p> }));
const form = vi.hoisted(() => ({ result: '' }));
vi.mock('@/components/practice/TimeEntryForm', () => ({
  TimeEntryForm: ({ onSubmit }: { onSubmit: (i: unknown) => Promise<void> }) => (
    <div>
      <button onClick={() => { onSubmit({ hours: 1 }).then(() => { form.result = 'saved'; }).catch((e: Error) => { form.result = e.message; }); }}>stub save</button>
    </div>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import { AgingInvoicesPanel } from '../../../src/components/accounting/AgingInvoicesPanel';
import { EmployeeHistoryCard } from '../../../src/components/payroll/EmployeeHistoryCard';
import { PayScaleCard } from '../../../src/components/payroll/PayScaleCard';
import TimeEntryPage from '../../../pages/accounting/practice/time-entry/index';
import OnboardingWizard from '../../../pages/onboarding/index';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); Object.values(logs).forEach(f => f.mockClear()); form.result = ''; });
afterEach(() => { cleanup(); });
const inTable = (ui: ReactNode) => render(<table><tbody>{ui}</tbody></table>);

describe('AgingInvoicesPanel: one plain sentence, no nesting', () => {
  const panel = () => inTable(<AgingInvoicesPanel side="ar" entityId="e1" entityName="Acme" asAtDate="2026-05-31" colSpan={6} />);
  it('400: the server message alone', async () => {
    script(() => refuse()); panel();
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(document.body.textContent).not.toMatch(/Could not load invoices for/);
  });
  it('empty 500: exactly the plain sentence, no "(...)" wrapper', async () => {
    script(() => empty500()); panel();
    expect(await screen.findByText('Could not load the invoices - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Could not load invoices for|request failed|\(/); expectNoRawError();
  });
  it('transport error: the same sentence, never "Failed to fetch"', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('Failed to fetch')); panel();
    expect(await screen.findByText('Could not load the invoices - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Failed to fetch/);
  });
});

describe('EmployeeHistoryCard', () => {
  const ENTRY = { id: 'h1', fieldName: 'department', oldValue: 'A', newValue: 'D2 Dept', effectiveFrom: '2026-01-01', changeReason: null, changedByName: null, createdAt: '2026-01-01' };
  it('400 / empty 500: the message or a sentence instead of "No recorded changes yet"', async () => {
    script(() => refuse()); const { unmount } = render(<EmployeeHistoryCard employeeId="e1" />);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(screen.queryByText(/No recorded changes yet/)).toBeNull(); unmount();
    script(() => empty500()); render(<EmployeeHistoryCard employeeId="e1" />);
    expect(await screen.findByText('Could not load the change history - try again')).toBeTruthy(); expectNoRawError();
  });
  it('200 lists the entries; a failing reload for another employee clears them', async () => {
    script(u => (u.includes('/e1/') ? ok([ENTRY]) : empty500()));
    const { rerender } = render(<EmployeeHistoryCard employeeId="e1" />);
    expect(await screen.findByText('D2 Dept')).toBeTruthy();
    rerender(<EmployeeHistoryCard employeeId="e2" />);
    expect(await screen.findByText('Could not load the change history - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Dept')).toBeNull();
  });
});

describe('PayScaleCard', () => {
  const SCALE = { id: 's1', code: 'G1', name: 'D2 Scale', gradeLevel: 1, minSalary: 1, midSalary: 2, maxSalary: 3, isActive: true };
  it('load 400 / empty 500: the message or a sentence, not "No active pay scales"', async () => {
    script(() => refuse()); const { unmount } = render(<PayScaleCard employeeId="e1" currentPayScaleId={null} onChange={vi.fn()} />);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(screen.queryByText(/No active pay scales/)).toBeNull(); unmount();
    script(() => empty500()); render(<PayScaleCard employeeId="e1" currentPayScaleId={null} onChange={vi.fn()} />);
    expect(await screen.findByText('Could not load pay scales - try again')).toBeTruthy(); expectNoRawError();
  });
  const pick = async (patch: () => Response, onChange = vi.fn()) => {
    script((_u, m) => (m === 'PATCH' ? patch() : ok([SCALE])));
    render(<PayScaleCard employeeId="e1" currentPayScaleId={null} onChange={onChange} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 's1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    return onChange;
  };
  it('save 400: the server message, onChange not called', async () => {
    const onChange = await pick(refuse); expect(await screen.findByText(MSG)).toBeTruthy(); expect(onChange).not.toHaveBeenCalled();
  });
  it('save empty 500: a sentence (was "Save failed")', async () => {
    await pick(empty500); expect(await screen.findByText('Could not save the pay scale - try again')).toBeTruthy(); expectNoRawError();
  });
  it('save 200: onChange called with the id', async () => {
    const onChange = await pick(() => ok({})); await waitFor(() => expect(onChange).toHaveBeenCalledWith('s1'));
  });
});

describe('practice time entry', () => {
  const ENTRIES = { entries: [] };
  const route = (init: (u: string) => Response | undefined, save?: () => Response) => script((u, m) => {
    if (m === 'POST' && u.includes('/time-entries')) return save?.() ?? ok({});
    return init(u) ?? (u.includes('/time-entries') ? ok(ENTRIES) : u.includes('/clients') ? ok({ clients: [] }) : ok([]));
  });
  const stubSave = async () => { fireEvent.click(await screen.findByRole('button', { name: 'stub save' })); };
  it('clients/categories load 400: the server message, not "Failed to load clients or categories: ..."', async () => {
    route(u => (u.includes('/clients') ? refuse() : undefined)); render(<TimeEntryPage />);
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(document.body.textContent).not.toMatch(/Failed to load clients/);
  });
  it('clients/categories load transport error: a plain sentence', async () => {
    route(u => { if (u.includes('/job-categories')) throw new TypeError('Failed to fetch'); return undefined; }); render(<TimeEntryPage />);
    expect(await screen.findByText('Could not load the clients or categories - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Failed to/);
  });
  it('save 400: the form gets the server message; empty 500 a sentence; no reload after a refusal', async () => {
    route(() => undefined, refuse); render(<TimeEntryPage />); await stubSave();
    await waitFor(() => expect(form.result).toBe(MSG)); cleanup();
    route(() => undefined, empty500); render(<TimeEntryPage />); await stubSave();
    await waitFor(() => expect(form.result).toBe('Could not save the time entry - try again'));
  });
  it('save 200: completes and the day is reloaded', async () => {
    route(() => undefined); render(<TimeEntryPage />); await screen.findByRole('button', { name: 'stub save' });
    const gets = () => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes('/time-entries') && !i?.method).length;
    const before = gets(); await stubSave();
    await waitFor(() => expect(form.result).toBe('saved')); expect(gets()).toBe(before + 1);
  });
  it('entries load empty 500: a sentence for the day', async () => {
    route(u => (u.includes('/time-entries?') ? empty500() : undefined)); render(<TimeEntryPage />);
    expect(await screen.findByText('Could not load entries for this day - try again')).toBeTruthy(); expectNoRawError();
  });
});

describe('onboarding: legacy user-companies check', () => {
  const me = (companies: () => Response) => script(u => (u.includes('/api/auth/me') ? ok({ user: { onboarding_completed: null } }) : u.includes('user-companies') ? companies() : undefined));
  it('a failing check is logged and the wizard still shows (non-fatal)', async () => {
    me(empty500); render(<OnboardingWizard />);
    expect(await screen.findByText('smart setup choice')).toBeTruthy();
    expect(logs.warn).toHaveBeenCalledWith('Could not load the user companies during onboarding', { status: 500 }, 'onboarding');
  });
  it('a good empty list shows the wizard without a warning', async () => {
    me(() => ok({ items: [] })); render(<OnboardingWizard />);
    expect(await screen.findByText('smart setup choice')).toBeTruthy(); expect(logs.warn).not.toHaveBeenCalled();
  });
});
