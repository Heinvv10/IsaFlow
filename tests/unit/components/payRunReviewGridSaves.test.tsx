/**
 * The review grid when a save goes wrong, and what stands between it and the approval
 * preview (master plan wave 3, R). `fetch` is stubbed, so the real apiFetch/apiJson run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { OVERTIME, UNION, INPUTS_URL, RUN_URL, line, inputsBody, ok, fail } from './payroll/payrollRunFixtures';
import {
  body, cell, fetchMock, pressApprove, previews, puts, rowOf, serve, settle, twoRuns, type,
} from './payroll/payRunGridHarness';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const route = vi.hoisted(() => ({ id: '11111111-1111-4111-8111-111111111111' }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: route.id }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

const held = (amount: number, employeeId = 'e-1') => ({ employeeId, componentId: OVERTIME.id, amount, conflict: false });

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('commits', () => {
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
    await settle();
    expect(puts()).toHaveLength(1);
    answerFirst(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(body(1)).toMatchObject({ employeeId: 'e-2', amount: 2 });
  });

  it('sends the amount the cell held; a queued second edit expects what the first stored, not what the cell first showed', async () => {
    let answerFirst: (r: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => { answerFirst = resolve; });
    let n = 0;
    serve(() => (n++ === 0 ? first : ok(inputsBody(twoRuns(), { amounts: [held(200)] }))), { inputs: { amounts: [held(50)] } });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '100');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0)).toMatchObject({ amount: 100, expectedAmount: 50 });
    type(input, '200');
    fireEvent.blur(input);
    answerFirst(ok(inputsBody(twoRuns(), { amounts: [held(100)] })));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(body(1)).toMatchObject({ amount: 200, expectedAmount: 100 });
  });
});

describe('a failed save', () => {
  it('shows the server\'s reason on the row and puts the stored amount back', async () => {
    serve(() => fail(409, 'Edit this on the employee page: more than one amount'), { inputs: { amounts: [held(300)] } });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    expect(input.value).toBe('300.00');
    type(input, '999');
    fireEvent.blur(input);
    expect(await within(rowOf('Riaan Smit')).findByText(/Edit this on the employee page/)).toBeTruthy();
    await waitFor(() => expect(input.value).toBe('300.00'));
  });

  it('leaves what is typed in every other cell, on that row and on others', async () => {
    serve(() => fail(400, 'refused'));
    render(<PayrollRunDetailPage />);
    const [saved, other, sameRow] = [await cell('Riaan Smit'), await cell('Thandi Nkosi'), await cell('Riaan Smit', 'Once-off deduction')];
    type(other, '777');
    type(sameRow, '888');
    type(saved, '999');
    fireEvent.blur(saved);
    await within(rowOf('Riaan Smit')).findByText('refused');
    await waitFor(() => expect(saved.value).toBe(''));
    expect(other.value).toBe('777');
    expect(sameRow.value).toBe('888');
  });

  it('re-reads the run as well as the amounts: a 5xx may have written', async () => {
    const reread = twoRuns({ lines: [line('1', 'Riaan Smit', [], { netPay: 11111.11 }), line('2', 'Thandi Nkosi')] });
    serve(() => fail(500, 'boom'), { read: () => ok(inputsBody(reread)) });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    expect(await within(rowOf('Riaan Smit')).findByText('R 11 111.11')).toBeTruthy();
  });

  it('keeps the grid and what is typed in it when the re-read fails too, and holds the approval until it can read', async () => {
    let reads = 0;
    serve(() => fail(500, 'boom'), { read: () => (reads++ === 0 ? ok(inputsBody(twoRuns())) : fail(500, 'down')) });
    render(<PayrollRunDetailPage />);
    const [saved, other] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    type(other, '777');
    type(saved, '1');
    fireEvent.blur(saved);
    expect(await screen.findByText(/could not be re-read after a failed save/i)).toBeTruthy();
    expect(screen.getByLabelText('Once-off earning, Thandi Nkosi')).toBe(other);
    expect(other.value).toBe('777');
    for (let press = 0; press < 2; press++) {
      pressApprove();
      expect(await screen.findByText(/Reload the page before you approve/)).toBeTruthy();
    }
    expect(previews()).toHaveLength(0);
  });

  it('a later save on the same row does not hide it; saving that cell does', async () => {
    let n = 0;
    serve(() => (n++ === 0 ? fail(400, 'refused') : ok(inputsBody(twoRuns()))));
    render(<PayrollRunDetailPage />);
    const [earning, deduction] = [await cell('Riaan Smit'), await cell('Riaan Smit', 'Once-off deduction')];
    type(earning, '1');
    fireEvent.blur(earning);
    await within(rowOf('Riaan Smit')).findByText('refused');
    type(deduction, '2');
    fireEvent.blur(deduction);
    await waitFor(() => expect(puts()).toHaveLength(2));
    await settle();
    expect(within(rowOf('Riaan Smit')).getByText('refused')).toBeTruthy();
    type(earning, '3');
    fireEvent.blur(earning);
    await within(rowOf('Riaan Smit')).findByText(/^Saved/);
    expect(within(rowOf('Riaan Smit')).queryByText('refused')).toBeNull();
  });
});

describe('what holds the approval preview', () => {
  it('a save in flight: the preview opens when it answers, and includes it', async () => {
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    pressApprove();
    await settle();
    expect(previews()).toHaveLength(0);
    answer(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(previews()).toHaveLength(1));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('a save that fails while it waits: the dialog stays closed and says why; a second press goes on', async () => {
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    pressApprove();
    answer(fail(400, 'refused'));
    expect(await screen.findByText(/A save failed/)).toBeTruthy();
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(previews()).toHaveLength(0);
    pressApprove();
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.queryByText(/A save failed/)).toBeNull();
  });

  it('refused text in a cell: nothing was sent, so the dialog stays closed until it is corrected', async () => {
    serve(() => ok(inputsBody(twoRuns())));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1,234');
    fireEvent.blur(input);
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    for (let press = 0; press < 2; press++) {
      pressApprove();
      expect(await screen.findByText(/could not be read/)).toBeTruthy();
    }
    expect(previews()).toHaveLength(0);
    type(input, '1234');
    fireEvent.blur(input);
    await within(rowOf('Riaan Smit')).findByText(/^Saved/);
    pressApprove();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('refused text in a column moved to another component is gone, and holds nothing', async () => {
    const commission = { ...OVERTIME, id: 'c-co', name: 'Commission', sarsSourceCode: '3606' };
    serve(() => ok(inputsBody(twoRuns())), { inputs: { components: [OVERTIME, commission, UNION] } });
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1,234');
    fireEvent.blur(input);
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    fireEvent.change(screen.getByLabelText('Once-off earning component'), { target: { value: commission.id } });
    await waitFor(async () => expect((await cell('Riaan Smit')).value).toBe(''));
    pressApprove();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('Recalculate waits for a save in flight', async () => {
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const calculates = () => fetchMock.mock.calls.filter(([u]) => u === `${RUN_URL}/calculate`);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (url === `${RUN_URL}/calculate` ? ok({}) : inner(url, init)));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate' }));
    await settle();
    expect(calculates()).toHaveLength(0);
    answer(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(calculates()).toHaveLength(1));
  });
});

describe('moving to another run', () => {
  const SECOND = '22222222-2222-4222-8222-222222222222';

  it('an answer for the run left behind does not land on the one now open', async () => {
    let answer: (r: Response) => void = () => undefined;
    const otherLines = [line('8', 'Peter Other', [], { employeeId: 'e-8' })];
    const other = twoRuns({ id: SECOND, lines: otherLines });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === INPUTS_URL && init?.method === 'PUT') return new Promise<Response>((resolve) => { answer = resolve; });
      if (url === INPUTS_URL) return ok(inputsBody(twoRuns()));
      if (url === RUN_URL) return ok(twoRuns());
      if (url === `/api/payroll/runs/${SECOND}/inputs`) return ok(inputsBody(other));
      if (url === `/api/payroll/runs/${SECOND}`) return ok(other);
      throw new Error(`unexpected fetch ${url}`);
    });
    const { rerender } = render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    route.id = SECOND;
    rerender(<PayrollRunDetailPage />);
    await cell('Peter Other');
    await act(async () => {
      answer(ok(inputsBody(twoRuns({ lines: [line('1', 'Riaan Smit')] }))));
      await settle();
    });
    expect(screen.queryByText('Riaan Smit')).toBeNull();
    expect(screen.getByText('Peter Other')).toBeTruthy();
    route.id = '11111111-1111-4111-8111-111111111111';
  });
});
