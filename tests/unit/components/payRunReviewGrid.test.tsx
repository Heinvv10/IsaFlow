/**
 * The pay-run review grid (master plan wave 3, R; M5). Cells commit one PUT each and the
 * server's recalculated lines replace what is on screen: the grid never computes PAYE or
 * net. `fetch` is stubbed, so the real apiFetch/apiJson run. What happens when a save
 * fails, and what holds the approval preview, is in payRunReviewGridSaves.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { INPUTS_URL, RUN_URL, OVERTIME, UNION, line, inputsBody, planBody, ok, fail } from './payroll/payrollRunFixtures';
import { body, cell, fetchMock, puts, rowOf, serve, settle, twoRuns, type } from './payroll/payRunGridHarness';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

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
    expect(body(0)).toEqual({ employeeId: 'e-1', componentId: OVERTIME.id, amount: 1000, expectedAmount: 0 });
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
    await within(rowOf('Riaan Smit')).findByText(/^Saved/);
    await settle();
    expect(puts()).toHaveLength(1);
  });

  it('skips a row with no cell going down and coming back up', async () => {
    const three = twoRuns({ lines: [line('1', 'Riaan Smit'), line('2', 'Thandi Nkosi'), line('3', 'Anna Botha')] });
    serve(() => ok(inputsBody(three)), {
      run: three,
      inputs: { amounts: [{ employeeId: 'e-2', componentId: OVERTIME.id, amount: null, conflict: true }] },
    });
    render(<PayrollRunDetailPage />);
    const [first, third] = [await cell('Riaan Smit'), await cell('Anna Botha')];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(third);
  });

  it('keeps focus and typed text in the next row when the save answers, though the recalculation made new line ids', async () => {
    // replaceRunLines deletes and re-inserts: a row keyed by the line id would remount under the cursor.
    const fresh = [line('91', 'Riaan Smit', [], { employeeId: 'e-1' }), line('92', 'Thandi Nkosi', [], { employeeId: 'e-2' })];
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<PayrollRunDetailPage />);
    const [first, second] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    type(first, '10');
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => expect(puts()).toHaveLength(1));
    fireEvent.change(second, { target: { value: '25' } });
    answer(ok(inputsBody(twoRuns({ lines: fresh }))));
    await within(rowOf('Riaan Smit')).findByText(/^Saved/);
    expect(await cell('Thandi Nkosi')).toBe(second);
    expect(document.activeElement).toBe(second);
    expect(second.value).toBe('25');
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
        components: [OVERTIME, commission, UNION],
        amounts: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: 300, conflict: false }],
      },
    });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    expect(input.value).toBe('300.00');
    fireEvent.change(screen.getByLabelText('Once-off earning component'), { target: { value: commission.id } });
    await waitFor(async () => expect((await cell('Riaan Smit')).value).toBe(''));
  });

  describe('the default earning', () => {
    const named = (name: string, sarsSourceCode: string) => ({ ...OVERTIME, id: `c-${sarsSourceCode}`, name, sarsSourceCode });
    const [salary, commission, overtime] = [named('Basic Salary', '3601'), named('Commission', '3606'), named('Overtime', '3607')];
    const picker = async () => {
      await screen.findByText('Riaan Smit');
      return await screen.findByLabelText('Once-off earning component') as HTMLSelectElement;
    };

    it.each([
      ['overtime before all', [salary, commission, overtime], overtime.id],
      ['commission when there is no overtime', [salary, commission], commission.id],
    ])('%s', async (_what, components, expected) => {
      serve(() => ok({}), { inputs: { components } });
      render(<PayrollRunDetailPage />);
      expect((await picker()).value).toBe(expected);
    });

    it('never Basic Salary: with nothing else there is no column to type in until one is chosen', async () => {
      serve(() => ok(inputsBody(twoRuns())), { inputs: { components: [salary] } });
      render(<PayrollRunDetailPage />);
      const select = await picker();
      expect(select.value).toBe('');
      expect(screen.queryByLabelText('Once-off earning, Riaan Smit')).toBeNull();
      fireEvent.change(select, { target: { value: salary.id } });
      expect(await cell('Riaan Smit')).toBeTruthy();
    });
  });

  it('shows what the run pays every month on the component, for that employee only', async () => {
    serve(() => ok({}), { inputs: { recurring: [{ employeeId: 'e-1', componentId: OVERTIME.id, amount: 20000 }] } });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    const recurring = within(rowOf('Riaan Smit')).getByText('Plus R 20 000.00 recurring');
    expect(input.getAttribute('aria-describedby')).toContain(recurring.id);
    expect(within(rowOf('Thandi Nkosi')).queryByText(/recurring/)).toBeNull();
  });

  it('with no deduction editable there is no column and no note about it', async () => {
    serve(() => ok(inputsBody(twoRuns())), { inputs: { components: [OVERTIME] } });
    render(<PayrollRunDetailPage />);
    await cell('Riaan Smit');
    expect(screen.queryByText(/deduction can be edited/i)).toBeNull();
    expect(screen.queryByText('Once-off deduction')).toBeNull();
    expect(screen.queryByLabelText('Once-off deduction component')).toBeNull();
    const [groups, heads] = screen.getAllByRole('row').slice(0, 2);
    const span = (el: Element) => Number(el.getAttribute('colspan') ?? 1);
    expect([...groups!.children].reduce((n, c) => n + span(c), 0)).toBe(heads!.children.length);
  });

  it('with one editable the column and its picker are there', async () => {
    serve(() => ok(inputsBody(twoRuns())));
    render(<PayrollRunDetailPage />);
    expect(await cell('Riaan Smit', 'Once-off deduction')).toBeTruthy();
    expect(screen.getByLabelText('Once-off deduction component')).toBeTruthy();
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
});

describe('the approval summary', () => {
  const open = async () => {
    render(<PayrollRunDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: /review & approve/i }));
    return screen.findByRole('dialog');
  };

  it('reads the plan: the employees it pays, its net and its labour debit', async () => {
    // ETI 100 used: gross 75 000 + UIF 177.12 + SDL 750 would say 75 927.12, and the run says another net.
    serve(() => ok({}), {
      run: twoRuns({ totalNet: 1 }),
      preview: planBody(null, { plan: {
        employeeCount: 13, paidEmployeeCount: 12, periodMonth: 11, periodYear: 2026, totalDebit: 498120, totalCredit: 498120,
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

  it('neither the dialog nor the page says warnings never block when one is blocking', async () => {
    const flagged = line('1', 'Riaan Smit', [{ code: 'DEDUCTIONS_EXCEED_PAY', severity: 'warning', message: 'Over' }]);
    const blocked = planBody({ code: 'deductions_exceed_pay', detail: 'Deductions and tax exceed pay.' });
    serve(() => ok({}), { run: twoRuns({ lines: [flagged] }), preview: blocked });
    const dialog = await open();
    await within(dialog).findByText('Deductions and tax exceed pay.');
    expect(within(dialog).queryByText(/do not block approval/)).toBeNull();
    expect(screen.queryByText(/do not block the run/)).toBeNull();
    expect(screen.getByText(/Deductions above pay block approval/)).toBeTruthy();
  });

  it('does not offer a payment approval will not make', async () => {
    serve(() => ok({}), { preview: planBody({ code: 'closed_period', detail: 'The period is closed.' }) });
    const dialog = await open();
    await within(dialog).findByText('The period is closed.');
    expect(within(dialog).queryByText(/^Paying /)).toBeNull();
  });
});
