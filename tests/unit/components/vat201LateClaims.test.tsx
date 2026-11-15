/** Wave 6 LC: the VAT201 late-claims section. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VAT201LateClaimsSection } from '@/components/accounting/sars/VAT201LateClaimsSection';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

const env = (data: unknown) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data }), json: async () => ({ data }) });
const refusal = (status: number, message: string) => ({ ok: false, status, headers: new Headers(), text: async () => JSON.stringify({ error: { message } }) });
const claim = {
  journalEntryId: 'c1', entryNumber: 'JE-20', claimDate: '2026-11-01', kind: 'claim',
  original: { journalEntryId: 'o1', entryNumber: 'JE-10', entryDate: '2026-10-12' },
  document: { supplierInvoiceId: 's1', invoiceNumber: 'INV-7', supplierName: 'Acme' },
  filedPeriod: { start: '2026-09-01', end: '2026-10-31' }, boxes: ['15'], vat: 15000,
};
const reversal = { ...claim, journalEntryId: 'r1', entryNumber: 'JE-21', kind: 'reversal', vat: -3000, document: null };
const data = (rows: unknown[], total: number) => ({ periodStart: '2026-11-01', periodEnd: '2026-12-31', rows, total, lateClaimInputTax: total });

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);

it('lists each claim with links to its journal and its original, the reversal marked, and the total', async () => {
  apiFetch.mockResolvedValue(env(data([claim, reversal], 12000)));
  render(<VAT201LateClaimsSection from="2026-11-01T00:00:00.000Z" to="2026-12-31" />);
  const table = await screen.findByTestId('vat201-late-claims-rows');
  expect(within(table).getByRole('link', { name: 'JE-20' }).getAttribute('href')).toBe('/accounting/journal-entries/c1');
  expect(within(table).getAllByRole('link', { name: 'JE-10' })[0]!.getAttribute('href')).toBe('/accounting/journal-entries/o1');
  expect(within(table).getByText('(reversal)')).toBeTruthy();
  expect(within(table).getByText(/INV-7 \(Acme\)/)).toBeTruthy();
  expect(screen.getByTestId('vat201-late-claims-total').textContent).toMatch(/12[\s ,]?000\.00/);
  expect(String(apiFetch.mock.calls[0]![0])).toBe('/api/accounting/sars/vat201-late-claims?from=2026-11-01&to=2026-12-31');
});

it('says so when the period has no late claims', async () => {
  apiFetch.mockResolvedValue(env(data([], 0)));
  render(<VAT201LateClaimsSection from="2026-11-01" to="2026-12-31" />);
  expect((await screen.findByTestId('vat201-late-claims-empty')).textContent).toBe('No late claims in this period.');
  expect(screen.queryByTestId('vat201-late-claims-rows')).toBeNull();
});

it('a server refusal shows its words and Retry loads again', async () => {
  apiFetch.mockResolvedValueOnce(refusal(500, 'the late claims listed total R1.00')).mockResolvedValueOnce(env(data([claim], 15000)));
  render(<VAT201LateClaimsSection from="2026-11-01" to="2026-12-31" />);
  expect((await screen.findByRole('alert')).textContent).toContain('the late claims listed total R1.00');
  expect(screen.queryByTestId('vat201-late-claims-rows')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('vat201-late-claims-rows')).toBeTruthy();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('a new period reloads, and a stale answer for the old one is dropped', async () => {
  let resolveOld: (v: unknown) => void = () => {};
  apiFetch.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; })).mockResolvedValueOnce(env(data([], 0)));
  const v = render(<VAT201LateClaimsSection from="2026-09-01" to="2026-10-31" />);
  v.rerender(<VAT201LateClaimsSection from="2026-11-01" to="2026-12-31" />);
  await screen.findByTestId('vat201-late-claims-empty');
  resolveOld(env(data([claim], 15000)));
  await new Promise((r) => setTimeout(r, 10));
  expect(screen.queryByTestId('vat201-late-claims-rows')).toBeNull();
});
