/** Wave 5 L3u: the VAT201 field drill drawer. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Vat201FieldsSection } from '@/components/accounting/sars/Vat201FieldsSection';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

const base = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-28', outputInvoices: [], inputInvoices: [] };
const fields = [
  { field: '4', label: 'Standard-rated output', amount: 150, kind: 'tax', group: 'output-supplies' },
  { field: '1', label: 'Standard rate', amount: 1000, kind: 'value', group: 'output-supplies' },
  { field: '2', label: 'Zero rate', amount: 0, kind: 'value', group: 'output-supplies' },
  { field: '5', label: 'Change in use', amount: null, kind: 'tax', group: 'output-adjustments', note: 'Not tracked in IsaFlow' },
];
const row = (n: number) => ({ lineId: `l${n}`, journalEntryId: `j${n}`, entryNumber: `JE-${n}`, entryDate: '2026-01-15', accountCode: '2200', accountName: 'VAT Output', vatType: 'standard', box: '1', tax: 75, journalBase: 500, residual: false });
const env = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data }), json: async () => ({ data }) });
const refusal = (status: number, message: string, retryAfter?: string) => ({
  ok: false, status, headers: new Headers(retryAfter ? { 'Retry-After': retryAfter } : {}), text: async () => JSON.stringify({ error: { message } }),
});
const lines = (page: number, over: Record<string, unknown> = {}) => ({
  field: '4', label: 'Output tax', source: 'tax-lines', amount: 150, rowsTotal: 150, ties: true, page, pageSize: 200, rowCount: 400, hasMore: page < 2,
  periodStart: '2026-01-01', periodEnd: '2026-02-28', rows: [row(page * 2 - 1), row(page * 2)], ...over,
});
const pageOf = (u: string) => Number(new URL(u, 'http://x').searchParams.get('page'));

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);

const mount = (data: Record<string, unknown> = {}) => render(<Vat201FieldsSection data={{ ...base, ...data, sarsFields: fields } as never} />);
const openField = (f = '4') => fireEvent.click(screen.getByLabelText(`Show the lines behind field ${f}`));

it('field 4 opens a drawer of its lines with journal links, 200 a page, day-only dates', async () => {
  apiFetch.mockResolvedValue(env(lines(1)));
  mount(); openField();
  const table = await screen.findByTestId('return-drill-lines');
  expect(within(table).getByRole('link', { name: 'JE-1' }).getAttribute('href')).toBe('/accounting/journal-entries/j1');
  expect(screen.getByTestId('return-drill-total').textContent).toMatch(/matches the field/);
  expect(screen.getByTestId('return-drill-range').textContent).toBe('Showing 1–200 of 400');
  const url = String(apiFetch.mock.calls[0]![0]);
  expect(url).toContain('pageSize=200');
  expect(url).toContain('from=2026-01-01&');
});

it('links only where there is something to drill: no link for a null or R 0.00 field; the note stays', () => {
  mount();
  expect(screen.queryByLabelText('Show the lines behind field 5')).toBeNull();
  expect(screen.queryByLabelText('Show the lines behind field 2')).toBeNull();
  expect(screen.getByText('Not tracked in IsaFlow')).toBeTruthy();
});

it('Next fetches page 2, Previous returns, and each page change scrolls the drawer to its top', async () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  apiFetch.mockImplementation(async (u: string) => env(lines(pageOf(u))));
  mount(); openField();
  await screen.findByText('JE-1');
  scroll.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('JE-3');
  expect(screen.getByTestId('return-drill-range').textContent).toBe('Showing 201–400 of 400');
  expect(scroll).toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  await screen.findByText('JE-1');
});

it('the pager is disabled while a page loads, so a double click cannot skip one', async () => {
  let release: (v: unknown) => void = () => undefined;
  apiFetch.mockImplementationOnce(async () => env(lines(1)))
    .mockImplementationOnce(() => new Promise((r) => { release = r; }));
  mount(); openField();
  await screen.findByText('JE-1');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await waitFor(() => expect(screen.queryByTestId('return-drill-lines')).toBeNull());
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  const previous = screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement;
  expect(previous.disabled).toBe(true);
  fireEvent.click(previous);
  expect(apiFetch).toHaveBeenCalledTimes(2);
  await act(async () => { release(env(lines(2))); });
  await screen.findByText('JE-3');
});

it('page 2, then another field: one request, for page 1, and the old rows never show', async () => {
  apiFetch.mockImplementation(async (u: string) => env(String(u).includes('field=1&')
    ? { ...lines(pageOf(u)), field: '1', rows: [row(77)], ties: null, rowCount: 1, hasMore: false } : lines(pageOf(u))));
  mount(); openField();
  await screen.findByText('JE-1');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText('JE-3');
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  apiFetch.mockClear();
  openField('1');
  await screen.findByText('JE-77');
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(String(apiFetch.mock.calls[0]![0])).toContain('field=1&');
  expect(String(apiFetch.mock.calls[0]![0])).toContain('page=1&');
});

it('a stale response that arrives after a newer one is not shown', async () => {
  const pending: Record<string, (v: unknown) => void> = {};
  apiFetch.mockImplementation((u: string) => new Promise((r) => { pending[`${new URL(u, 'http://x').searchParams.get('field')}`] = r; }));
  mount(); openField('4');
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  openField('1');
  await act(async () => { pending['1']!(env({ ...lines(1), field: '1', rows: [row(5)] })); });
  await screen.findByText('JE-5');
  await act(async () => { pending['4']!(env(lines(1, { rows: [row(9)] }))); });
  expect(screen.queryByText('JE-9')).toBeNull();
  expect(screen.getByText('JE-5')).toBeTruthy();
});

it('a 429 keeps the pager, says how long to wait, and Retry loads the page', async () => {
  apiFetch.mockResolvedValueOnce(refusal(429, 'Too many requests.', '30')).mockResolvedValueOnce(env(lines(1)));
  mount(); openField();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('Too many requests. Try again in 30 seconds.');
  expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
  expect(screen.queryByTestId('return-drill-lines')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('JE-1');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a failed load shows the server message, not an empty table', async () => {
  apiFetch.mockResolvedValue(refusal(500, 'Rate limited'));
  mount(); openField();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Rate limited'));
  expect(screen.queryByTestId('return-drill-lines')).toBeNull();
});

it('a no-source answer shows its note', async () => {
  apiFetch.mockResolvedValue(env({ field: '4', label: 'x', source: 'none', amount: null, note: 'No source in IsaFlow' }));
  mount(); openField();
  expect((await screen.findByTestId('return-drill-note')).textContent).toBe('No source in IsaFlow');
});

it('a component list drills into a component, shows a minus sign as negative, and Back returns', async () => {
  apiFetch.mockImplementation(async (u: string) => env(String(u).includes('field=12&')
    ? { ...lines(1), field: '12' }
    : { field: '4', label: 'Sum', source: 'components', amount: 150, sum: 150,
      components: [{ field: '12', label: 'Other', sign: 1, amount: 150 }, { field: '19', label: 'Input', sign: -1, amount: 40 }] }));
  mount(); openField();
  expect((await screen.findByRole('button', { name: /19 Input/ })).parentElement!.textContent).toMatch(/[-−]R\s?40\.00/);
  fireEvent.click(screen.getByRole('button', { name: /12 Other/ }));
  await screen.findByTestId('return-drill-lines');
  expect(String(apiFetch.mock.calls[1]![0])).toContain('field=12');
  fireEvent.click(screen.getByRole('button', { name: 'Back to field 4' }));
  await screen.findByTestId('return-drill-components');
});

it('fields 1 and 1A say what each figure is and point at the field the VAT ties to', async () => {
  apiFetch.mockResolvedValue(env({ ...lines(1), field: '1', ties: null, rowsTotal: 150, amount: 1000 }));
  mount(); openField('1');
  const t = (await screen.findByTestId('return-drill-total')).textContent!;
  expect(t).toMatch(/VAT column adds up to .*150\.00/);
  expect(t).toMatch(/value of supplies including VAT/);
  expect(t).toMatch(/tie to field 4/);
});

it('a period over 400 days says so up front and offers no links', () => {
  mount({ periodStart: '2025-01-01', periodEnd: '2026-03-01' });
  expect(screen.getByTestId('vat201-drill-window-note').textContent).toMatch(/up to 400 days; narrow the period/);
  expect(screen.queryByLabelText('Show the lines behind field 4')).toBeNull();
});

it('after a failed load Next is disabled (Retry is the way forward)', async () => {
  apiFetch.mockResolvedValueOnce(env(lines(1))).mockResolvedValueOnce(refusal(500, 'Boom'));
  mount(); openField();
  await screen.findByText('JE-1');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

it('the sideways-scroll hint shows only when there are rows', async () => {
  apiFetch.mockResolvedValueOnce(env(lines(1)));
  mount(); openField();
  await screen.findByText('JE-1');
  expect(screen.getByText('Scroll sideways for every column.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  apiFetch.mockResolvedValueOnce(env(lines(1, { field: '1', rows: [], rowCount: 0, hasMore: false, rowsTotal: 0, ties: null })));
  openField('1');
  await screen.findByText('No lines in this period.');
  expect(screen.queryByText('Scroll sideways for every column.')).toBeNull();
});
