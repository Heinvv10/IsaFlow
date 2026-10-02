// D2 round 9 (src/components outside accounting): billing tab load error, assertOk sentences, busy flag across a redirect,
// empty-state copy not shown beside a load error, waitlist outcomes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, ok, on, serve } from '../helpers/d2R3a6';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), pathname: '/', asPath: '/' }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));

import { apiFetch } from '@/lib/apiFetch';
import { CompanyBillingTab } from '@/components/admin/companies/CompanyBillingTab';
import { ConvertTrialModal } from '@/components/admin/ConvertTrialModal';
import { PaystackMandateCard } from '@/components/admin/billing/PaystackMandateCard';
import { ImpersonationBanner } from '@/components/layout/ImpersonationBanner';
import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import { CostCentreAssignmentCard } from '@/components/payroll/CostCentreAssignmentCard';
import { LoanEventsTab } from '@/components/loans/LoanEventsTab';
import { TopUpModal } from '@/components/billing/TopUpModal';
import { WaitlistForm } from '@/components/landing/WaitlistForm';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CompanyBillingTab subscription load', () => {
  it('a 500 on subscriptions shows only the error and a Retry, not the empty states', async () => {
    serve(on('GET', 'subscriptions', empty500), on('GET', 'invoices', () => ok({ items: [] })));
    render(<CompanyBillingTab companyId="c-1" />);
    expect(await screen.findByText('Could not load the subscription - try again')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('No active subscription');
    expect(document.body.textContent).not.toMatch(/No invoices/i);
    expectNoJargon();
  });
  it('Retry reloads and shows the no-subscription state when the load works', async () => {
    let fail = true;
    serve(on('GET', 'subscriptions', () => (fail ? empty500() : ok({ items: [] }))));
    render(<CompanyBillingTab companyId="c-1" />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    fail = false;
    fireEvent.click(retry);
    expect(await screen.findByText('No active subscription')).toBeTruthy();
  });
});

describe('plain sentences for an empty 5xx', () => {
  it('ConvertTrialModal', async () => {
    serve(on('GET', 'plans', () => ok([{ id: 'p1', name: 'Pro', code: 'pro', monthly_price_cents: 100, currency: 'ZAR' }])), on('POST', 'trials/convert', empty500));
    render(<ConvertTrialModal companyId="c1" companyName="Co" onClose={vi.fn()} onConverted={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: /convert/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    expect(await screen.findByText('Could not convert the trial - try again')).toBeTruthy();
    expectNoJargon();
  });
  it('LoanEventsTab', async () => {
    serve(on('POST', '/events', empty500));
    render(<LoanEventsTab loanId="l1" events={[]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /add event/i }));
    const date = document.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2026-01-01' } });
    const amount = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    if (amount) fireEvent.change(amount, { target: { value: '10' } });
    fireEvent.submit(date.closest('form') as HTMLFormElement);
    expect(await screen.findByText('Could not add the loan event - try again')).toBeTruthy();
    expectNoJargon();
  });
});

describe('busy flag stays set after a redirect starts', () => {
  const stubHref = () => {
    const loc = { href: 'http://x/' } as unknown as Location;
    vi.stubGlobal('location', loc);
    return loc;
  };
  it('PaystackMandateCard: authorise keeps the button disabled once the redirect is set', async () => {
    const loc = stubHref();
    window.prompt = () => '1500';
    serve(on('GET', 'mandate/status', () => ok({ mandate: null, charges: [] })), on('POST', 'mandate/create', () => ok({ checkoutUrl: 'https://pay.example/x' })));
    render(<PaystackMandateCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Authorise debit order' }));
    await waitFor(() => expect(loc.href).toBe('https://pay.example/x'));
    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByRole('button', { name: /starting/i }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('PaystackMandateCard: an empty 500 frees the button again with a plain sentence', async () => {
    window.prompt = () => '1500';
    serve(on('GET', 'mandate/status', () => ok({ mandate: null, charges: [] })), on('POST', 'mandate/create', empty500));
    render(<PaystackMandateCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Authorise debit order' }));
    expect(await screen.findByText('Could not start the debit order authorisation - try again')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Authorise debit order' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('ImpersonationBanner: stays busy after a successful return redirect', async () => {
    document.cookie = 'is_impersonating=1';
    const loc = stubHref();
    vi.stubGlobal('fetch', async () => ok({ redirect: '/admin' }));
    render(<ImpersonationBanner />);
    fireEvent.click(await screen.findByRole('button', { name: /return to my session/i }));
    await waitFor(() => expect(loc.href).toBe('/admin'));
    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    document.cookie = 'is_impersonating=; max-age=0';
  });
  it('TopUpModal: bundle buttons stay disabled after the checkout redirect starts; an empty 500 frees them', async () => {
    const loc = stubHref();
    let reply: () => Response = () => ok({ mode: 'paystack_transaction', checkoutUrl: 'https://pay.example/t' });
    serve(on('GET', 'bundles', () => ok([{ id: 'b1', name: 'Starter', flows: 10, priceCents: 1000 }])), on('POST', 'purchase', () => reply()));
    render(<TopUpModal open onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Starter/ }));
    await waitFor(() => expect(loc.href).toBe('https://pay.example/t'));
    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByRole('button', { name: /Starter/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    reply = empty500;
    render(<TopUpModal open onClose={vi.fn()} onSuccess={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Starter/ }));
    expect(await screen.findByText('Could not start the purchase - try again')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /Starter/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('empty-state copy is not shown beside a load error', () => {
  it('ApplyPackageCard', async () => {
    serve(on('GET', 'pay-packages', empty500));
    render(<ApplyPackageCard employeeId="e1" onApplied={vi.fn()} />);
    expect(await screen.findByText('Could not load packages - try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('No active packages');
  });
  it('ApplyPackageCard: a real empty list still says so', async () => {
    serve(on('GET', 'pay-packages', () => ok([])));
    render(<ApplyPackageCard employeeId="e1" onApplied={vi.fn()} />);
    expect(await screen.findByText(/No active packages/)).toBeTruthy();
  });
  it('CostCentreAssignmentCard', async () => {
    serve(on('GET', 'cost-centres', empty500), on('GET', 'cost-allocations', () => ok([])));
    render(<CostCentreAssignmentCard employeeId="e1" currentCostCentreId={null} onChange={vi.fn()} />);
    expect(await screen.findByText('Could not load the cost centres and allocations - try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('No active cost centres');
  });
});

describe('WaitlistForm', () => {
  const submit = async (reply: () => Response | Promise<Response>) => {
    vi.stubGlobal('fetch', async () => reply());
    render(<WaitlistForm />);
    const email = document.querySelector('input[name="email"]') as HTMLInputElement;
    fireEvent.change(email, { target: { value: 'a@b.co' } });
    fireEvent.submit(email.closest('form') as HTMLFormElement);
  };
  it('empty 500: a plain sentence', async () => {
    await submit(empty500);
    expect(await screen.findByText('Could not join the waitlist - try again')).toBeTruthy();
    expectNoJargon();
  });
  it('network rejection: a plain sentence, no raw text', async () => {
    await submit(() => { throw new Error('socket hang up'); });
    expect(await screen.findByText('Could not join the waitlist - try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('socket hang up');
  });
  it('200: no error shows', async () => {
    await submit(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
    await waitFor(() => expect(document.body.textContent).not.toContain('Could not join'));
  });
});
