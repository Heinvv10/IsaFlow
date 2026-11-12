/** Wave 5 L3u: the EMP201 total drill drawer. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Emp201ReturnForm } from '@/components/accounting/sars/emp201/Emp201ReturnForm';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

const RUN = '11111111-1111-4111-8111-111111111111';
const data = {
  periodStart: '2026-09-01', periodEnd: '2026-09-30', totalPAYE: 1500, totalETI: 0, payePayable: 1500,
  etiCarry: { broughtForward: 0, used: 0, carriedForward: 0, refundClaimable: 0 },
  totalUIF_employee: 100, totalUIF_employer: 100, totalUIF: 200, totalSDL: 0, employeeCount: 2,
  totalTaxableRemuneration: 30000, totalDeductions: 1700, payrollRuns: [], directivePayments: [],
};
const row = (n: number) => ({ runId: RUN, periodYear: 2026, periodMonth: 9, employeeId: `e${n}`, employeeNumber: `E${n}`, employeeName: `Emp ${n}`, amount: 750 });
const drill = (over: Record<string, unknown> = {}) => ({
  field: 'paye', periodStart: '2026-09-01', periodEnd: '2026-09-30', total: 1500, rowsTotal: 1500, ties: true,
  runs: [{ runId: RUN, periodYear: 2026, periodMonth: 9, status: 'approved', headerTotal: 1500, linesTotal: 1500, difference: 0 }],
  directivePayments: [], page: 1, pageSize: 200, rowCount: 2, hasMore: false, rows: [row(1), row(2)], ...over,
});
const env = (d: unknown) => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: d }), json: async () => ({ data: d }) });
const refusal = (status: number, message: string) => ({ ok: false, status, headers: new Headers(), text: async () => JSON.stringify({ error: { message } }) });

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);
const mount = (props: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => render(<Emp201ReturnForm data={{ ...data, ...d } as never} canDrill {...props} />);

it('PAYE opens a drawer of its runs and employee lines, each run linked to its pay run', async () => {
  apiFetch.mockResolvedValue(env(drill()));
  mount();
  fireEvent.click(screen.getByLabelText('Show the lines behind PAYE (Pay As You Earn)'));
  const table = await screen.findByTestId('return-drill-lines');
  expect(within(table).getByText(/E1 Emp 1/)).toBeTruthy();
  expect(within(screen.getByTestId('emp201-drill-runs')).getByRole('link', { name: '2026-09' }).getAttribute('href')).toBe(`/payroll/runs/${RUN}`);
  expect(within(table).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([`/payroll/runs/${RUN}`, `/payroll/runs/${RUN}`]);
  expect(screen.getByTestId('return-drill-total').textContent).toMatch(/matches the amount/);
  const url = String(apiFetch.mock.calls[0]![0]);
  expect(url).toContain('return=emp201&field=paye&from=2026-09-01&to=2026-09-30');
  expect(url).toContain('pageSize=200');
});

it('links only on non-zero totals, and only when the role may read payroll detail', () => {
  mount();
  expect(screen.getByLabelText('Show the lines behind Total UIF')).toBeTruthy();
  expect(screen.getByLabelText('Show the lines behind Total taxable remuneration')).toBeTruthy();
  expect(screen.queryByLabelText('Show the lines behind ETI for the period')).toBeNull();
  expect(screen.queryByLabelText('Show the lines behind SDL (Skills Development Levy)')).toBeNull();
  cleanup();
  mount({ canDrill: false });
  expect(screen.queryByLabelText('Show the lines behind PAYE (Pay As You Earn)')).toBeNull();
});

it('a refusal (Login-as, agent, role) is shown in the server words with Retry, never an empty table', async () => {
  apiFetch.mockResolvedValueOnce(refusal(403, 'Payroll detail is not available while signed in as another user.')).mockResolvedValueOnce(env(drill()));
  mount();
  fireEvent.click(screen.getByLabelText('Show the lines behind PAYE (Pay As You Earn)'));
  expect((await screen.findByRole('alert')).textContent).toBe('Payroll detail is not available while signed in as another user.');
  expect(screen.queryByTestId('return-drill-lines')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByTestId('return-drill-lines');
});

it('a run whose stored total and lines disagree is flagged; directive payments are listed', async () => {
  apiFetch.mockResolvedValue(env(drill({
    ties: false, rowsTotal: 1400,
    runs: [{ runId: RUN, periodYear: 2026, periodMonth: 9, status: 'approved', headerTotal: 1500, linesTotal: 1400, difference: 100 }],
    directivePayments: [{ paymentId: 'd1', directiveNumber: 'IRP3-9', employeeName: 'Dee Rector', paymentDate: '2026-09-10', amount: 50 }],
  })));
  mount();
  fireEvent.click(screen.getByLabelText('Show the lines behind PAYE (Pay As You Earn)'));
  await screen.findByTestId('return-drill-lines');
  expect(screen.getByTestId('return-drill-total').textContent).toMatch(/does not match/);
  expect(within(screen.getByTestId('emp201-drill-runs')).getAllByRole('row')[1]!.textContent).toMatch(/100\.00/);
  expect(screen.getByText(/Dee Rector, directive IRP3-9/)).toBeTruthy();
});

it('Next loads page 2 and a different total starts again at page 1 with one request', async () => {
  apiFetch.mockImplementation(async (u: string) => env(drill({
    page: Number(new URL(u, 'http://x').searchParams.get('page')), rowCount: 400, hasMore: !u.includes('page=2'),
    rows: [row(u.includes('field=uif') ? 70 : u.includes('page=2') ? 3 : 1)],
  })));
  mount();
  fireEvent.click(screen.getByLabelText('Show the lines behind PAYE (Pay As You Earn)'));
  await screen.findByText(/E1 Emp 1/);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  await screen.findByText(/E3 Emp 3/);
  expect(screen.getByTestId('return-drill-range').textContent).toBe('Showing 201–400 of 400');
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  apiFetch.mockClear();
  fireEvent.click(screen.getByLabelText('Show the lines behind Total UIF'));
  await screen.findByText(/E70 Emp 70/);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(String(apiFetch.mock.calls[0]![0])).toContain('page=1&');
});

it('a period over 400 days says so and offers no links', () => {
  mount({}, { periodStart: '2025-01-01', periodEnd: '2026-03-01' });
  expect(screen.getByTestId('emp201-drill-window-note').textContent).toMatch(/up to 400 days; narrow the period/);
  expect(screen.queryByLabelText('Show the lines behind PAYE (Pay As You Earn)')).toBeNull();
});
