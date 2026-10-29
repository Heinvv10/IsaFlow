/**
 * The headcount panel (P4 decision 7): months × payroll actives / planned hires / total for the
 * company or a cost centre, with the payroll read's "as of" stamp. COUNTS ONLY: anything else in
 * an answer (a name, a salary) is never rendered. A planned hire is edited inline (a role label,
 * never a name) and saved through the workspace's write path with the version token; Refresh
 * headcount POSTs the token too; both read the counts again after.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeadcountPanel } from '@/components/accounting/budgets/drivers/HeadcountPanel';
import type { DriverActions } from '@/components/accounting/budgets/drivers/useDriverActions';
import { installNetwork, ok } from '../workspace/workspaceHarness';
import { ID, MONTHS, TOKEN } from './driverFixture';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const HC = '/api/accounting/budget-drivers/headcount';
const HIRES = '/api/accounting/budget-drivers/planned-hires';
const HIRE = { id: 'e0000000-0000-4000-8000-000000000001', label: 'Sales rep', costCentreId: null, startMonth: MONTHS[3]!, endMonth: null, fte: 1, updatedAt: TOKEN };
const counts = (scope: string | null) => ({
  costCentreId: scope,
  months: MONTHS.map((month, i) => ({ month, payroll: scope ? 2 : 7, hires: i >= 3 ? 1 : 0, total: (scope ? 2 : 7) + (i >= 3 ? 1 : 0) })),
  asOf: '2026-10-29T07:15:00.000Z',
  // Never sent by the route; here to prove the panel renders counts only.
  employees: [{ name: 'Thandi Mokoena', salary: 41000 }],
});

/** The workspace's runWrite as it behaves on success: the write gets the version and token. */
const runWrite = vi.fn<DriverActions['runWrite']>(async (write) => {
  const r = await write(ID.version, TOKEN);
  return r.ok ? null : { message: r.message };
});

function setup() {
  const net = installNetwork();
  net.on((u) => u.startsWith(`${HC}?`), (u) => ok(counts(new URL(u, 'http://x').searchParams.get('costCentreId'))));
  net.on((u, m) => u.startsWith(`${HIRES}?`) && m === 'GET', () => ok({ hires: [HIRE] }));
  net.on((u, m) => u === HIRES && m === 'PUT', (_u, b) => ok({ hire: { ...HIRE, ...(b as object), updatedAt: '2026-10-29T08:00:00.000001Z' }, updatedAt: 'T2', recomputed: 3, warnings: [] }));
  net.on((u, m) => u === HC && m === 'POST', () => ok({ headcountAsOf: '2026-10-29T08:00:00.000Z', updatedAt: 'T2', recomputed: 0, warnings: [] }));
  const onCountsChanged = vi.fn();
  render(<HeadcountPanel versionId={ID.version} months={MONTHS} costCentres={[{ id: ID.m1, label: 'CC-A Alpha' }]} editable
    runWrite={runWrite} onCountsChanged={onCountsChanged} />);
  return { net, onCountsChanged };
}

describe('HeadcountPanel', () => {
  it('shows payroll actives, planned hires and total per month, as of the read, and nothing else', async () => {
    const { net } = setup();
    const table = await screen.findByTestId('headcount-table');
    const row = (label: string) => within(table).getByRole('rowheader', { name: label }).closest('tr')!;
    expect(within(row('Payroll actives')).getAllByRole('cell').map((c) => c.textContent)).toEqual(MONTHS.map(() => '7'));
    expect(within(row('Planned hires')).getAllByRole('cell').map((c) => c.textContent)).toEqual(MONTHS.map((_, i) => (i >= 3 ? '1' : '0')));
    expect(within(row('Total')).getAllByRole('cell')[5]).toHaveTextContent('8');
    expect(screen.getByTestId('headcount-as-of')).toHaveTextContent('as of 2026-10-29 07:15 UTC');
    expect(document.body.textContent).not.toMatch(/Thandi|Mokoena|41\s?000/);

    fireEvent.change(screen.getByRole('combobox', { name: 'Headcount of' }), { target: { value: ID.m1 } });
    await waitFor(() => expect(within(row('Payroll actives')).getAllByRole('cell')[0]).toHaveTextContent('2'));
    expect(net.sent.some((s) => s.url === `${HC}?versionId=${ID.version}&costCentreId=${ID.m1}`)).toBe(true);
  });

  it('edits a planned hire inline: PUT with the token, then the counts are read again', async () => {
    const { net, onCountsChanged } = setup();
    const label = await screen.findByRole('textbox', { name: 'Role of Sales rep' });
    expect(label).toHaveAttribute('placeholder', expect.stringContaining("never a person's name"));
    fireEvent.change(label, { target: { value: 'Senior sales rep' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'FTE of Senior sales rep' }), { target: { value: '0.5' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Cost centre of Senior sales rep' }), { target: { value: ID.m1 } });
    fireEvent.change(screen.getByRole('combobox', { name: 'End month of Senior sales rep' }), { target: { value: MONTHS[9] } });
    const reads = net.sent.filter((s) => s.url.startsWith(`${HC}?`)).length;
    fireEvent.click(within(label.closest('li')!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(net.sent.some((s) => s.url === HIRES && s.method === 'PUT')).toBe(true));
    expect(net.sent.find((s) => s.url === HIRES && s.method === 'PUT')!.body).toEqual({
      versionId: ID.version, expectedUpdatedAt: TOKEN, id: HIRE.id, label: 'Senior sales rep', costCentreId: ID.m1,
      startMonth: MONTHS[3], endMonth: MONTHS[9], fte: 0.5,
    });
    await waitFor(() => expect(net.sent.filter((s) => s.url.startsWith(`${HC}?`)).length).toBe(reads + 1));
    expect(onCountsChanged).toHaveBeenCalled();
  });

  it('a hire with a bad FTE is refused before anything is sent; Refresh headcount POSTs the token', async () => {
    const { net } = setup();
    const fte = await screen.findByRole('textbox', { name: 'FTE of Sales rep' });
    fireEvent.change(fte, { target: { value: '0' } });
    fireEvent.click(within(fte.closest('li')!).getByRole('button', { name: 'Save' }));
    expect(await within(fte.closest('li')!).findByRole('alert')).toHaveTextContent('FTE is more than 0');
    expect(net.sent.some((s) => s.url === HIRES && s.method === 'PUT')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh headcount' }));
    await waitFor(() => expect(net.sent.find((s) => s.url === HC && s.method === 'POST')?.body).toEqual({ versionId: ID.version, expectedUpdatedAt: TOKEN }));
  });
});
