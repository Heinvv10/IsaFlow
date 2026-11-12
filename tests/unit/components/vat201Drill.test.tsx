/** Wave 5 L3u: the VAT201 field drill drawer. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Vat201FieldsSection } from '@/components/accounting/sars/Vat201FieldsSection';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

const base = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-28', outputInvoices: [], inputInvoices: [] };
const fields = [
  { field: '4', label: 'Standard-rated output', amount: 150, kind: 'tax', group: 'output-supplies' },
  { field: '5', label: 'Change in use', amount: null, kind: 'tax', group: 'output-adjustments', note: 'Not tracked in IsaFlow' },
];
const row = (n: number) => ({ lineId: `l${n}`, journalEntryId: `j${n}`, entryNumber: `JE-${n}`, entryDate: '2026-01-15', accountCode: '2200', accountName: 'VAT Output', vatType: 'standard', box: '1', tax: 75, journalBase: 500, residual: false });
const env = (data: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, headers: new Headers(), text: async () => JSON.stringify({ data }), json: async () => ({ data }) });
const lines = (page: number, hasMore: boolean) => ({
  field: '4', label: 'Output tax', source: 'tax-lines', amount: 150, rowsTotal: 150, ties: true, page, pageSize: 50, rowCount: 2, hasMore,
  periodStart: '2026-01-01', periodEnd: '2026-02-28', rows: [row(page * 2 - 1), row(page * 2)],
});

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);

const open = () => { render(<Vat201FieldsSection data={{ ...base, sarsFields: fields } as never} />); fireEvent.click(screen.getByLabelText('Show the lines behind field 4')); };

it('field 4 opens a drawer of its lines with journal links, sending day-only dates', async () => {
  apiFetch.mockResolvedValue(env(lines(1, false)));
  open();
  const table = await screen.findByTestId('return-drill-lines');
  expect(within(table).getByRole('link', { name: 'JE-1' }).getAttribute('href')).toBe('/accounting/journal-entries/j1');
  expect(screen.getByTestId('return-drill-total').textContent).toMatch(/matches the field/);
  const url = String(apiFetch.mock.calls[0]![0]);
  expect(url).toContain('field=4');
  expect(url).toContain('from=2026-01-01&');
});

it('a field with no amount has no link; its note stays on the row', () => {
  render(<Vat201FieldsSection data={{ ...base, sarsFields: fields } as never} />);
  expect(screen.queryByLabelText('Show the lines behind field 5')).toBeNull();
  expect(screen.getByText('Not tracked in IsaFlow')).toBeTruthy();
});

it('Next fetches page 2 and Previous returns to page 1', async () => {
  apiFetch.mockImplementation(async (u: string) => env(lines(new URL(u, 'http://x').searchParams.get('page') === '2' ? 2 : 1, !u.includes('page=2'))));
  open();
  await screen.findByText('JE-1');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('JE-3');
  expect(screen.queryByText('JE-1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  await screen.findByText('JE-1');
});

it('a failed load shows the error, not an empty table', async () => {
  apiFetch.mockResolvedValue({ ...env({}, false), text: async () => JSON.stringify({ error: { message: 'Rate limited' } }) });
  open();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Rate limited'));
  expect(screen.queryByTestId('return-drill-lines')).toBeNull();
});

it('a no-source answer shows its note; a component list drills into a component', async () => {
  apiFetch.mockResolvedValueOnce(env({ field: '4', label: 'x', source: 'none', amount: null, note: 'No source in IsaFlow' }));
  open();
  expect((await screen.findByTestId('return-drill-note')).textContent).toBe('No source in IsaFlow');
  cleanup();
  apiFetch.mockReset();
  apiFetch.mockResolvedValueOnce(env({ field: '4', label: 'Sum', source: 'components', amount: 150, sum: 150, components: [{ field: '12', label: 'Other', sign: 1, amount: 150 }] }))
    .mockResolvedValueOnce(env({ ...lines(1, false), field: '12' }));
  open();
  fireEvent.click(await screen.findByRole('button', { name: /12 Other/ }));
  await screen.findByTestId('return-drill-lines');
  expect(String(apiFetch.mock.calls[1]![0])).toContain('field=12');
});
