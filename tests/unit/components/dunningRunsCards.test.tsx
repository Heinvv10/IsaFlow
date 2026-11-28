// AR dunning send history: the table becomes labelled cards below lg; the Back link and the response filter chips are 44px and wrap.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sends: [] as unknown[] }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: { sends: state.sends } }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Page from '../../../pages/accounting/ar/dunning/runs';

const send = (id: string, status: 'sent' | 'failed', resp: string | null) => ({ id, invoice_number: 'INV-001', customer_name: 'Acme (Pty) Ltd', template_name: 'First reminder', template_tone: 'polite', sent_at: '2026-11-20T08:00:00Z', sent_to_email: 'a@b.co', rendered_subject: 's', trigger_source: 'cron', email_status: status, email_error: null, response_action: resp, response_received_at: null, response_note: null, message_token: 't' });
afterEach(() => { cleanup(); state.sends = [send('s1', 'sent', 'paid'), send('s2', 'failed', null)]; });
state.sends = [send('s1', 'sent', 'paid'), send('s2', 'failed', null)];
const cls = (el: Element) => el.className.split(' ');
const HEADS = ['Sent', 'Invoice', 'Customer', 'Tone', 'Trigger', 'Status', 'Response'];

describe('Dunning send history on touch', () => {
  it('turns the table into labelled cards matching its headers', async () => {
    const { container } = render(<Page />);
    await screen.findAllByText('INV-001');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(HEADS);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    for (const tr of rows) expect([...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual(HEADS);
  });

  it('centres the empty-state cell in card mode', async () => {
    state.sends = [];
    render(<Page />);
    const cell = (await screen.findByText('No sends yet.')).closest('td')!;
    expect(cls(cell)).toEqual(expect.arrayContaining(['max-lg:!text-center', 'max-lg:!py-8']));
    expect(cell.hasAttribute('data-label')).toBe(false);
  });

  it('makes the Back link and every filter chip 44px; the chip row wraps', async () => {
    render(<Page />);
    await screen.findAllByText('INV-001');
    expect(cls(screen.getByRole('link', { name: /Back to templates/ }))).toEqual(expect.arrayContaining(['max-lg:min-h-11']));
    const chips = ['All', 'Awaiting response', 'Paid', 'Promised', 'Disputed', 'Silent'].map((n) => screen.getByRole('button', { name: n }));
    for (const c of chips) expect(cls(c), c.textContent ?? '').toContain('max-lg:min-h-11');
    expect(cls(chips[0].parentElement!)).toContain('max-lg:flex-wrap');
  });
});
