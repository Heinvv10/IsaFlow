/**
 * Audit P3.2: Process Year-End opens a confirmation that names the year, its
 * dates, the closing figures and the Retained Earnings account, and only enables
 * Confirm once the year label is typed exactly. The POST carries confirm: true.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import YearEndPage from '@/../pages/accounting/year-end';

afterEach(() => { cleanup(); });

const YEAR = {
  year_label: '2026', start_date: '2025-03-01', end_date: '2026-02-28', status: 'open',
  periods_open: 0, periods_closed: 12, total_revenue: 5000, total_expenses: 3700, net_income: 1300,
};
const PREVIEW = {
  yearLabel: '2026', alreadyClosed: false, netIncome: 1300, entryDate: '2026-02-28', entryNumber: 'YE-2026',
  retainedEarnings: { accountCode: '3100', accountName: 'Retained Earnings' },
};
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');

function serve(preview: Record<string, unknown>) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) =>
    (init?.method === 'POST' ? ok({ message: 'Year 2026 closed.', unclosedNetIncome: 0 })
      : String(url).includes('preview=') ? ok(preview)
      : ok({ years: [YEAR] })));
}

async function open() {
  render(<YearEndPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Process Year-End/ }));
  const dialog = await screen.findByRole('dialog');
  return {
    dialog,
    input: within(dialog).getByRole('textbox') as HTMLInputElement,
    confirm: within(dialog).getByRole('button', { name: /Process Year-End/ }) as HTMLButtonElement,
  };
}

describe('year-end confirmation', () => {
  it('opening it posts nothing and asks the preview as a read', async () => {
    serve(PREVIEW);
    await open();
    expect(posts()).toHaveLength(0);
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('preview=2026'))).toBe(true));
  });

  it('shows the year, its dates, the figures and the Retained Earnings account', async () => {
    serve(PREVIEW);
    const { dialog } = await open();
    await waitFor(() => expect(within(dialog).getByTestId('ye-confirm-re').textContent).toBe('3100 Retained Earnings'));
    expect(dialog.textContent).toMatch(/1 Mar 2025 to 28 Feb 2026/);
    expect(within(dialog).getByTestId('ye-confirm-revenue').textContent).toMatch(/5[\s,]?000\.00/);
    expect(within(dialog).getByTestId('ye-confirm-expenses').textContent).toMatch(/3[\s,]?700\.00/);
    expect(within(dialog).getByTestId('ye-confirm-net').textContent).toMatch(/1[\s,]?300\.00/);
  });

  it('Confirm stays disabled until the exact year label is typed, then posts confirm: true', async () => {
    serve(PREVIEW);
    const { input, confirm } = await open();
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '2025' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '202' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '2026' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ yearLabel: '2026', action: 'close', confirm: true });
  });

  it('a refusal from the preview is shown and blocks Confirm even with the label typed', async () => {
    serve({ yearLabel: '2026', refusal: 'No Retained Earnings system account is configured.' });
    const { dialog, input, confirm } = await open();
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/No Retained Earnings/);
    fireEvent.change(input, { target: { value: '2026' } });
    expect(confirm.disabled).toBe(true);
    expect(posts()).toHaveLength(0);
  });
});
