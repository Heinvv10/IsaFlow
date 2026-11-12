/**
 * Audit P3.2: Reverse on the journal detail page asks first, offers the original
 * date or a chosen one (sent as reversal_date), and a refused reversal keeps the
 * entry and its lines on screen with the error above them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { dateInputs, typeDate } from '../../helpers/typeDate';

const routerState = vi.hoisted(() => ({ query: { entryId: 'je-1' } as Record<string, string> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: routerState.query, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/gl/LinkTaxInvoiceButton', () => ({ LinkTaxInvoiceButton: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import JournalEntryDetailPage from '../../../pages/accounting/journal-entries/[entryId]';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const LINES = [
  { id: 'l1', glAccountId: 'a1', accountCode: '6100', accountName: 'Rent', debit: 1500, credit: 0, description: 'Rent line' },
  { id: 'l2', glAccountId: 'a2', accountCode: '1000', accountName: 'Bank', debit: 0, credit: 1500, description: 'Bank line' },
];
const ENTRY = {
  id: 'je-1', entryNumber: 'JE-0042', entryDate: '2026-01-15', status: 'posted', source: 'manual',
  createdBy: 'u1', description: 'Rent', lines: LINES,
};
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'POST');

function serve(onPost: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) =>
    ((init?.method ?? 'GET').toUpperCase() === 'POST' ? onPost() : ok(ENTRY)));
}

async function openDialog() {
  render(<JournalEntryDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^reverse$/i }));
  return screen.findByRole('dialog');
}

describe('journal reverse confirmation', () => {
  it('the first click only opens the dialog, naming the entry, date, total and line count', async () => {
    serve(() => ok({}));
    const dialog = await openDialog();
    expect(posts()).toHaveLength(0);
    expect(dialog.textContent).toContain('JE-0042');
    expect(dialog.textContent).toMatch(/15 Jan 2026/);
    expect(dialog.textContent).toMatch(/1[\s,]?500\.00/);
    expect(dialog.textContent).toMatch(/2 lines/);
  });

  it('Cancel posts nothing', async () => {
    serve(() => ok({}));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });

  it('original date omits reversal_date', async () => {
    serve(() => ok({}));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /reverse journal/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ id: 'je-1', action: 'reverse' });
  });

  it('a chosen date is sent as reversal_date, and Confirm waits for it', async () => {
    serve(() => ok({}));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByLabelText('Another date'));
    const confirm = within(dialog).getByRole('button', { name: /reverse journal/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    typeDate(dateInputs(dialog)[0]!, '2026-02-01');
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ id: 'je-1', action: 'reverse', reversal_date: '2026-02-01' });
  });

  it('a refused reversal keeps the entry and its lines visible, with the error above them', async () => {
    const MSG = 'The reversal date falls in a closed period.';
    serve(() => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 }));
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: /reverse journal/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(MSG);
    expect(screen.getByText('Rent line')).toBeTruthy();
    expect(screen.getByText('Bank line')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
