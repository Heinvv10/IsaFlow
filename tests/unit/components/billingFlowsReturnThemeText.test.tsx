// The Paystack return page (a tenant lands here after paying): its status paragraphs sit on the page background. They used text-gray-500, which the app shell leaves
// unmapped (#6b7280): 3.67:1 on the dark page, under the 4.5 small text needs. They use the secondary theme token (9.6 dark / 7.5 light).
import type { ReactNode } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ ref: 'p1' as string | undefined, status: 'pending' as string | 'throw' }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: state.ref ? { ref: state.ref } : {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => {
    if (state.status === 'throw') return new Response(JSON.stringify({ success: false, message: 'down' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ success: true, data: { purchaseId: 'p1', status: state.status, flows: 50, priceCents: 10000 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }),
}));

import Page from '../../../pages/accounting/settings/billing/flows/return';

const cls = (el: Element) => el.className.split(' ');
const GRAYS = /^text-(gray|slate|zinc)-\d+$/;
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(10); }); };
beforeEach(() => { vi.useFakeTimers(); state.ref = 'p1'; state.status = 'pending'; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

/** The status paragraph under the page's heading. */
const para = (): HTMLElement => screen.getByRole('heading', { level: 1 }).parentElement!.querySelector('p')!;
const expectToken = (p: HTMLElement) => { expect(cls(p)).toContain('text-[var(--ff-text-secondary)]'); expect(cls(p).filter((c) => GRAYS.test(c))).toEqual([]); };

describe('Flows return page status text on the page background', () => {
  it('reference missing', async () => {
    state.ref = undefined;
    render(<Page />); await settle();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Payment reference missing');
    expectToken(para());
  });

  it('confirming (pending)', async () => {
    render(<Page />); await settle();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Confirming your payment');
    expectToken(para());
  });

  it('payment confirmed', async () => {
    state.status = 'succeeded';
    render(<Page />); await settle();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Payment confirmed');
    expectToken(para());
  });

  it('payment not completed', async () => {
    state.status = 'failed';
    render(<Page />); await settle();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Payment not completed');
    expectToken(para());
  });

  it("still confirming (the webhook has not landed inside the minute)", async () => {
    render(<Page />); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(70_000); });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Still confirming');
    expectToken(para());
  });

  it("couldn't check status (the status call failed)", async () => {
    state.status = 'throw';
    render(<Page />); await settle();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain("Couldn't check status");
    expectToken(para());
  });
});
