/**
 * The pay-run review grid (master plan wave 3, R; M5). Cells commit one PUT each and the
 * server's recalculated lines replace what is on screen: the grid never computes PAYE or
 * net. `fetch` is stubbed, so the real apiFetch/apiJson run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import {
  RUN_URL, PLAN_URL, INPUTS_URL, OVERTIME, UNION, line, runBody, planBody, inputsBody, ok, fail,
} from './payroll/payrollRunFixtures';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const TWO_LINES = [line('1', 'Riaan Smit'), line('2', 'Thandi Nkosi')];
const twoRuns = (over: Record<string, unknown> = {}) => runBody({ lines: TWO_LINES, ...over });

const fetchMock = vi.fn();
type Handler = (init: RequestInit) => Response | Promise<Response>;
function serve(put: Handler, opts: { run?: Record<string, unknown>; inputs?: Record<string, unknown>; preview?: unknown } = {}) {
  const run = opts.run ?? twoRuns();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === INPUTS_URL && init?.method === 'PUT') return put(init);
    if (url === INPUTS_URL) return ok(inputsBody(run, opts.inputs));
    if (url === RUN_URL) return ok(run);
    if (url === PLAN_URL) return ok(opts.preview ?? planBody());
    throw new Error(`unexpected fetch ${url}`);
  });
}
const puts = () => fetchMock.mock.calls.filter(([u, i]) => u === INPUTS_URL && i?.method === 'PUT');
const body = (n: number) => JSON.parse(String(puts()[n]![1].body)) as Record<string, unknown>;

async function cell(name: string, column = 'Once-off earning') {
  return await screen.findByLabelText(`${column}, ${name}`) as HTMLInputElement;
}
function type(input: HTMLInputElement, text: string) {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
}
const rowOf = (name: string) => screen.getAllByRole('row').find((r) => within(r).queryByText(name))!;

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PayRunReviewGrid', () => {
  it('sends one PUT per commit, in rand, for the component picked in the header', async () => {
    serve(() => ok(inputsBody(twoRuns())));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1 000');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toEqual({ employeeId: 'e-1', componentId: OVERTIME.id, amount: 1000 });
    fireEvent.blur(input); // nothing changed since
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText(/^Saved/);
    expect(puts()).toHaveLength(1);
  });

  it('the returned lines replace the row and it says Saved; the grid works nothing out', async () => {
    // Figures no client arithmetic would reach from the 1 000 typed.
    const updated = [line('1', 'Riaan Smit', [], { grossPay: 76000, paye: 12345.67, netPay: 50000.11 }), line('2', 'Thandi Nkosi')];
    serve(() => ok(inputsBody(twoRuns({ lines: updated, totalNet: 91681.66 }), {
      amounts: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: 1000, conflict: false }],
    })));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1000');
    fireEvent.blur(input);
    await waitFor(() => expect(within(rowOf('Riaan Smit')).getByText(/^Saved/)).toBeTruthy());
    expect(within(rowOf('Riaan Smit')).getByText('R 50 000.11')).toBeTruthy();
    expect(within(rowOf('Riaan Smit')).getByText('R 12 345.67')).toBeTruthy();
    expect(screen.getAllByText('R 91 681.66')).toHaveLength(2); // the stat card and the table's footer
    expect(within(rowOf('Thandi Nkosi')).queryByText(/^Saved/)).toBeNull();
  });

  it('moves up and down the column with the arrow keys and Enter, committing once on the way', async () => {
    serve(() => ok(inputsBody(twoRuns())));
    render(<PayrollRunDetailPage />);
    const [first, second] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowDown' }); // last row: stays
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    type(first, '50');
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(second);
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it('sends the second commit only after the first has answered', async () => {
    let answerFirst: (r: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => { answerFirst = resolve; });
    let n = 0;
    serve(() => (n++ === 0 ? first : ok(inputsBody(twoRuns()))));
    render(<PayrollRunDetailPage />);
    const [a, b] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    type(a, '1');
    fireEvent.blur(a);
    await waitFor(() => expect(puts()).toHaveLength(1));
    type(b, '2');
    fireEvent.blur(b);
    await new Promise((r) => setTimeout(r, 20));
    expect(puts()).toHaveLength(1);
    answerFirst(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(body(1)).toMatchObject({ employeeId: 'e-2', amount: 2 });
  });

  it('a refusal shows the server\'s reason on the row and puts the stored amount back', async () => {
    serve(() => fail(409, 'Edit this on the employee page: more than one amount'), {
      inputs: { amounts: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: 300, conflict: false }] },
    });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    expect(input.value).toBe('300.00');
    type(input, '999');
    fireEvent.blur(input);
    expect(await within(rowOf('Riaan Smit')).findByText(/Edit this on the employee page/)).toBeTruthy();
    await waitFor(() => expect(input.value).toBe('300.00'));
  });

  it('refused text never reaches the server', async () => {
    serve(() => ok(inputsBody(twoRuns())));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1,234');
    fireEvent.blur(input);
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(puts()).toHaveLength(0);
  });

  it('sends 0 when a cell is cleared', async () => {
    serve(() => ok(inputsBody(twoRuns())), {
      inputs: { amounts: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: 300, conflict: false }] },
    });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toMatchObject({ amount: 0 });
  });

  it('a cell with several rows links to the employee page instead of editing', async () => {
    serve(() => ok(inputsBody(twoRuns())), {
      inputs: { amounts: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: null, conflict: true }] },
    });
    render(<PayrollRunDetailPage />);
    await cell('Thandi Nkosi');
    expect(screen.queryByLabelText('Once-off earning, Riaan Smit')).toBeNull();
    const link = within(rowOf('Riaan Smit')).getByRole('link', { name: /employee page/i });
    expect(link.getAttribute('href')).toBe('/payroll/employees/e-1');
  });

  it('an employee the run only pays severance has no cell', async () => {
    serve(() => ok(inputsBody(twoRuns())), { inputs: { employeeIds: ['e-2'] } });
    render(<PayrollRunDetailPage />);
    await cell('Thandi Nkosi');
    expect(screen.queryByLabelText('Once-off earning, Riaan Smit')).toBeNull();
  });

  it('picking another component rebinds the column to its amounts', async () => {
    const commission = { ...OVERTIME, id: 'c-co', name: 'Commission', sarsSourceCode: '3606' };
    serve(() => ok(inputsBody(twoRuns())), {
      inputs: {
        components: [commission, OVERTIME, UNION],
        amounts: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: 300, conflict: false }],
      },
    });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    expect(input.value).toBe('');
    fireEvent.change(screen.getByLabelText('Once-off earning component'), { target: { value: OVERTIME.id } });
    await waitFor(async () => expect((await cell('Riaan Smit')).value).toBe('300.00'));
  });

  it('says so when no deduction can be edited here', async () => {
    serve(() => ok(inputsBody(twoRuns())), { inputs: { components: [OVERTIME] } });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit');
    expect(screen.getByText(/No deduction can be edited on a pay run/)).toBeTruthy();
    expect(screen.queryByLabelText('Once-off deduction, Riaan Smit')).toBeNull();
  });

  it('an approved run stays the read-only table and asks for no inputs', async () => {
    serve(() => ok({}), { run: twoRuns({ status: 'approved', journalEntryId: 'je-1' }) });
    render(<PayrollRunDetailPage />);
    await screen.findByText('Riaan Smit');
    expect(screen.queryByLabelText(/Once-off earning/)).toBeNull();
    expect(fetchMock.mock.calls.filter(([u]) => u === INPUTS_URL)).toHaveLength(0);
  });

  it('when the inputs cannot load the figures stay, read-only, and it says so', async () => {
    fetchMock.mockImplementation(async (url: string) => (url === RUN_URL ? ok(twoRuns()) : fail(500, 'nope')));
    render(<PayrollRunDetailPage />);
    expect(await screen.findByText(/amounts cannot be edited right now/i)).toBeTruthy();
    expect(screen.getByText('Riaan Smit')).toBeTruthy();
  });

  it('Review & approve waits for a save in flight, so the plan it opens includes it', async () => {
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /review & approve/i }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.filter(([u]) => u === PLAN_URL)).toHaveLength(0);
    answer(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === PLAN_URL)).toHaveLength(1));
  });
});

describe('the approval summary', () => {
  const open = async () => {
    render(<PayrollRunDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
    return screen.findByRole('dialog');
  };

  it('reads the plan: its employee count, its net and its labour debit', async () => {
    // ETI 100 used: gross 75 000 + UIF 177.12 + SDL 750 would say 75 927.12, and the run says another net.
    serve(() => ok({}), {
      run: twoRuns({ totalNet: 1 }),
      preview: planBody(null, { plan: {
        employeeCount: 12, periodMonth: 11, periodYear: 2026, totalDebit: 498120, totalCredit: 498120,
        totals: { gross: 75000, paye: 1, uif: 354.24, sdl: 750, eti: 100, etiUsed: 100, net: 412300, employerUif: 177.12, otherDeductions: 0 },
      } }),
    });
    const dialog = await open();
    expect(await within(dialog).findByText(
      'Paying 12 employees R 412 300.00 net for November 2026. Cost to the company R 498 120.00 (gross plus employer UIF and SDL, less ETI used).',
    )).toBeTruthy();
  });

  it('one employee is singular', async () => {
    serve(() => ok({}), { preview: planBody() });
    const dialog = await open();
    expect(await within(dialog).findByText(/^Paying 1 employee R /)).toBeTruthy();
  });

  it('does not offer a payment approval will not make', async () => {
    serve(() => ok({}), { preview: planBody({ code: 'closed_period', detail: 'The period is closed.' }) });
    const dialog = await open();
    await within(dialog).findByText('The period is closed.');
    expect(within(dialog).queryByText(/^Paying /)).toBeNull();
  });
});
