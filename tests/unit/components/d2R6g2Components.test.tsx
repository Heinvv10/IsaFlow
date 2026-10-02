/**
 * D2 round 6 (g2): components. A 5xx/empty body is a plain sentence, a 4xx shows the server message, and no
 * false state: a bill submitted for approval whose refresh fails is not "submission failed"; a termination
 * form whose stored values never loaded cannot Save blanks back; a failed WhatsApp status load is not
 * "No verified number"; a failed feature check is not an upgrade prompt; the portal login says when sign-in
 * is down rather than blaming the password.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('@/components/admin/UpgradePrompt', () => ({ UpgradePrompt: () => <div>UPGRADE-PROMPT</div> }));

import { apiFetch } from '@/lib/apiFetch';
import { SupplierInvoiceApprovalPanel } from '@/components/accounting/ap/SupplierInvoiceApprovalPanel';
import { EmployeeTerminationCard } from '@/components/payroll/EmployeeTerminationCard';
import { WhatsAppVerificationSection } from '@/components/accounting/capture/WhatsAppVerificationSection';
import { FeatureGate } from '@/components/admin/FeatureGate';
import PortalPage from '../../../pages/portal/index';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to|Network error/);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('SupplierInvoiceApprovalPanel', () => {
  const approval = { state: 'required', requiredRole: 'admin' } as never;
  const submit = async (reply: () => Response, onChanged = vi.fn(async () => {})) => {
    vi.mocked(apiFetch).mockImplementation(async () => reply());
    render(<SupplierInvoiceApprovalPanel invoiceId="i1" approval={approval} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /submit for approval/i }));
    return onChanged;
  };
  it('400: the server message and no refresh', async () => {
    const changed = await submit(bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(changed).not.toHaveBeenCalled();
  });
  it('empty 500: a plain sentence', async () => {
    await submit(empty500);
    expect(await screen.findByText('Could not submit the bill for approval - try again')).toBeTruthy();
    noRaw();
  });
  it('submitted, then the refresh throws: says it was submitted, not that it failed; the button is not left busy', async () => {
    await submit(() => ok({}), vi.fn(async () => { throw new Error('reload blew up'); }));
    expect(await screen.findByText(/was submitted for approval, but the page could not refresh/)).toBeTruthy();
    expect(screen.queryByText(/Could not submit/)).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: /submit for approval/i }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('EmployeeTerminationCard', () => {
  const stored = { details: { reason: 'resignation', noticePeriodDays: 30 }, context: { endDate: '2026-09-30', monthlySalary: 1000, annualLeaveBalance: 1, yearsOfService: null, hasApprovedSeveranceDirective: false }, preview: null };
  it('the stored values did not load: a plain sentence and Save is off (no blank defaults written back)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<EmployeeTerminationCard employeeId="e1" endDate="2026-09-30" />);
    expect(await screen.findByText('Could not load the termination details - try again')).toBeTruthy();
    expect((screen.getByRole('button', { name: /save termination details/i }) as HTMLButtonElement).disabled).toBe(true);
    noRaw();
  });
  it('saved, then the refresh fails: keeps the success message and adds that the refresh failed', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') return ok({});
      return ++gets === 1 ? ok(stored) : empty500();
    });
    render(<EmployeeTerminationCard employeeId="e1" endDate="2026-09-30" />);
    const save = await screen.findByRole('button', { name: /save termination details/i });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    expect(await screen.findByText('Termination details saved, but the details could not be refreshed - reload the page')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
  it('a refused save: the server message', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u: unknown, init?: RequestInit) => (init?.method === 'PUT' ? bad400() : ok(stored)));
    render(<EmployeeTerminationCard employeeId="e1" endDate="2026-09-30" />);
    const save = await screen.findByRole('button', { name: /save termination details/i });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('WhatsAppVerificationSection', () => {
  it('a failed status load: a plain sentence and no "No verified WhatsApp number"', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<WhatsAppVerificationSection />);
    expect(await screen.findByText('Could not load the WhatsApp status - try again')).toBeTruthy();
    expect(screen.queryByText('No verified WhatsApp number.')).toBeNull();
    noRaw();
  });
  it('a refused start: the server message', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u: unknown, init?: RequestInit) => (init?.method === 'POST' ? bad400() : ok({ active: null, pending: null })));
    render(<WhatsAppVerificationSection />);
    await screen.findByText('No verified WhatsApp number.');
    fireEvent.change(screen.getByLabelText('WhatsApp Business number'), { target: { value: '+27821234567' } });
    fireEvent.click(screen.getByRole('button', { name: /start verification/i }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('FeatureGate', () => {
  it('a failed check shows neither the feature nor an upgrade prompt', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<FeatureGate feature="x"><div>FEATURE</div></FeatureGate>);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('FEATURE')).toBeNull();
    expect(screen.queryByText('UPGRADE-PROMPT')).toBeNull();
  });
  it('a real "not enabled" still shows the prompt; enabled shows the feature', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    render(<FeatureGate feature="x"><div>FEATURE</div></FeatureGate>);
    expect(await screen.findByText('UPGRADE-PROMPT')).toBeTruthy();
    cleanup();
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ enabled: true }), { status: 200 }));
    render(<FeatureGate feature="x"><div>FEATURE</div></FeatureGate>);
    expect(await screen.findByText('FEATURE')).toBeTruthy();
  });
});

describe('client portal sign-in', () => {
  const login = async (reply: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async () => reply());
    render(<PortalPage />);
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'a@b.co' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));
  };
  it('a 503 with an empty body says sign-in is unavailable, not "Invalid credentials" or a parse error', async () => {
    await login(() => new Response('', { status: 503 }));
    expect(await screen.findByText('Sign-in is temporarily unavailable - please try again shortly')).toBeTruthy();
    expect(screen.queryByText('Invalid credentials')).toBeNull();
    noRaw();
  });
  it('a 401 keeps the server message', async () => {
    await login(() => new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: MSG } }), { status: 401 }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});
