/**
 * NeedsAttention: the dashboard's one "needs attention" list. Rows are real
 * links; a failed load shows the message and Retry, never an all-clear; the
 * empty state respects the setup checklist; more than six rows fold behind a toggle.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => <a href={href} className={className}>{children}</a>,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: Response, fallback: string) => { if (!res.ok) throw new Error(fallback); },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { NeedsAttention } from '@/components/accounting/dashboard/NeedsAttention';
import { formatMoney } from '@/lib/money/formatMoney';
import type { AttentionItem } from '@/modules/accounting/services/dashboard/attentionShape';

const ok = (items: AttentionItem[]) => new Response(JSON.stringify({ success: true, data: { asAt: '2026-11-12', items } }), { status: 200 });
const fail500 = () => new Response('', { status: 500 });
const row = (i: number, over: Partial<AttentionItem> = {}): AttentionItem =>
  ({ key: `k${i}`, area: 'Sales', label: `Row ${i}`, severity: 'info', href: `/row/${i}`, ...over });
const calls = () => apiFetch.mock.calls.filter(([u]) => String(u) === '/api/accounting/dashboard/attention').length;

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);

describe('NeedsAttention rows', () => {
  it('each row is a link to its href, with the amount, due date, badge and as-at caption', async () => {
    apiFetch.mockResolvedValueOnce(ok([
      row(1, { label: '3 overdue invoices', severity: 'overdue', amount: 12345.67, href: '/accounting/customer-invoices?filter=overdue' }),
      row(2, { label: 'VAT return due', detail: 'Sep–Oct 2026', area: 'VAT', severity: 'due_soon', dueAt: '2026-11-25', href: '/accounting/sars/vat201' }),
    ]));
    render(<NeedsAttention />);
    const first = (await screen.findByText('3 overdue invoices')).closest('a')!;
    expect(first.getAttribute('href')).toBe('/accounting/customer-invoices?filter=overdue');
    expect(first.textContent).toContain(formatMoney(12345.67));
    expect(first.textContent).toContain('Overdue');
    const vat = screen.getByText('VAT return due').closest('a')!;
    expect(vat.getAttribute('href')).toBe('/accounting/sars/vat201');
    expect(vat.textContent).toContain('Due 25 Nov 2026');
    expect(vat.textContent).toContain('Due soon');
    expect(vat.textContent).toContain('Sep–Oct 2026');
    expect(screen.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeTruthy();
    expect(screen.getByText('As at 12 Nov 2026. Overdue first.')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
  });

  it('adds the extra rows, ordered by severity with the server rows', async () => {
    apiFetch.mockResolvedValueOnce(ok([row(1, { label: 'Server info' })]));
    render(<NeedsAttention extra={[row(9, { label: 'Missing invoices', severity: 'overdue', href: '/accounting/suppliers/missing-invoices' })]} />);
    await screen.findByText('Server info');
    const labels = Array.from(document.querySelectorAll('li')).map((li) => li.textContent);
    expect(labels[0]).toContain('Missing invoices');
    expect(labels[1]).toContain('Server info');
  });

  it('shows six of eight rows, and "Show all 8" reveals the rest', async () => {
    apiFetch.mockResolvedValueOnce(ok(Array.from({ length: 8 }, (_, i) => row(i + 1))));
    render(<NeedsAttention />);
    await screen.findByText('Row 1');
    expect(document.querySelectorAll('li')).toHaveLength(6);
    const toggle = screen.getByRole('button', { name: 'Show all 8' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(document.querySelectorAll('li')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Show fewer' }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('NeedsAttention on a 500', () => {
  it('shows the message and Retry, no all-clear and no rows; Retry refetches', async () => {
    apiFetch.mockResolvedValueOnce(fail500());
    render(<NeedsAttention extra={[row(9, { label: 'Client row' })]} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Could not load the attention list - try again')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
    expect(screen.queryByText('Finish setup to see your daily tasks')).toBeNull();
    expect(screen.queryByText('Client row')).toBeNull();
    expect(document.querySelectorAll('li')).toHaveLength(0);
    apiFetch.mockResolvedValueOnce(ok([row(1, { label: 'Back again' })]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Back again')).toBeTruthy();
    expect(calls()).toBe(2);
  });
});

describe('NeedsAttention empty', () => {
  it('all caught up when setup is done', async () => {
    apiFetch.mockResolvedValueOnce(ok([]));
    render(<NeedsAttention />);
    expect(await screen.findByText('All caught up!')).toBeTruthy();
    expect(screen.getByText('Nothing overdue, nothing due this week and nothing waiting in drafts.')).toBeTruthy();
  });

  it('"Finish setup" while setup is open', async () => {
    apiFetch.mockResolvedValueOnce(ok([]));
    render(<NeedsAttention setupOpen />);
    expect(await screen.findByText('Finish setup to see your daily tasks')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
  });

  it('neither while setup is unknown', async () => {
    apiFetch.mockResolvedValueOnce(ok([]));
    render(<NeedsAttention setupOpen setupUnknown />);
    expect(await screen.findByText('Daily tasks will show here once your setup status is confirmed')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
    expect(screen.queryByText('Finish setup to see your daily tasks')).toBeNull();
  });

  it('an extra row alone is not "all caught up"', async () => {
    apiFetch.mockResolvedValueOnce(ok([]));
    render(<NeedsAttention extra={[row(9, { label: 'Provisional' })]} />);
    expect(await screen.findByText('Provisional')).toBeTruthy();
    expect(screen.queryByText('All caught up!')).toBeNull();
  });
});
