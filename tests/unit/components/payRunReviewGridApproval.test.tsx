/**
 * What stands between the review grid and the approval preview (master plan wave 3, R).
 * `fetch` is stubbed, so the real apiFetch/apiJson run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { OVERTIME, UNION, RUN_URL, inputsBody, ok, fail } from './payroll/payrollRunFixtures';
import { cell, fetchMock, pressApprove, previews, puts, rowOf, serve, settle, twoRuns, type } from './payroll/payRunGridHarness';

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: { id: '11111111-1111-4111-8111-111111111111' }, push: vi.fn() }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'admin' }) }));

import PayrollRunDetailPage from '@/../pages/payroll/runs/[id]';

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

  it('a commit made while it waits is waited for too', async () => {
    const answers: Array<(r: Response) => void> = [];
    serve(() => new Promise<Response>((resolve) => { answers.push(resolve); }));
    render(<PayrollRunDetailPage />);
    const [a, b] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    type(a, '1');
    fireEvent.blur(a);
    await waitFor(() => expect(puts()).toHaveLength(1));
    pressApprove();
    type(b, '2');
    fireEvent.blur(b);
    answers[0]!(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(puts()).toHaveLength(2));
    await settle();
    expect(previews()).toHaveLength(0);
    answers[1]!(ok(inputsBody(twoRuns())));
    await waitFor(() => expect(previews()).toHaveLength(1));
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

  it('a second press while the first waits is ignored: it cannot take the failure the first is about to report', async () => {
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    pressApprove();
    pressApprove();
    answer(fail(400, 'refused'));
    expect(await screen.findByText(/A save failed/)).toBeTruthy();
    await settle();
    expect(previews()).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refused text an amount from the server has replaced holds nothing', async () => {
    const amount = { employeeId: 'e-1', componentId: OVERTIME.id, amount: 500, conflict: false };
    serve(() => ok(inputsBody(twoRuns(), { amounts: [amount] })));
    render(<PayrollRunDetailPage />);
    const [refused, other] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    type(refused, '1,234');
    fireEvent.blur(refused);
    await waitFor(() => expect(refused.getAttribute('aria-invalid')).toBe('true'));
    type(other, '2');
    fireEvent.blur(other);
    await waitFor(() => expect(refused.value).toBe('500.00'));
    pressApprove();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('refused text in a cell that has become a conflict holds nothing', async () => {
    const conflict = { employeeId: 'e-1', componentId: OVERTIME.id, amount: null, conflict: true };
    serve(() => ok(inputsBody(twoRuns(), { amounts: [conflict] })));
    render(<PayrollRunDetailPage />);
    const [refused, other] = [await cell('Riaan Smit'), await cell('Thandi Nkosi')];
    type(refused, '1,234');
    fireEvent.blur(refused);
    await waitFor(() => expect(refused.getAttribute('aria-invalid')).toBe('true'));
    type(other, '2');
    fireEvent.blur(other);
    await within(rowOf('Riaan Smit')).findByRole('link', { name: /employee page/i });
    pressApprove();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('refused text a reset has cleared holds nothing', async () => {
    let answer: (r: Response) => void = () => undefined;
    serve(() => new Promise<Response>((resolve) => { answer = resolve; }));
    render(<PayrollRunDetailPage />);
    const input = await cell('Riaan Smit');
    type(input, '1');
    fireEvent.blur(input);
    await waitFor(() => expect(puts()).toHaveLength(1));
    type(input, '1,234'); // typed while the save is on its way to failing
    fireEvent.blur(input);
    answer(fail(409, 'refused'));
    await within(rowOf('Riaan Smit')).findByText('refused');
    await waitFor(() => expect(input.value).toBe(''));
    pressApprove();
    await screen.findByText(/A save failed/);
    pressApprove();
    expect(await screen.findByRole('dialog')).toBeTruthy();
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
