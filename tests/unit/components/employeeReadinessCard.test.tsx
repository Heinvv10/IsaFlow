/** Wave 4 B: the profile's "Ready to pay" card, and the one line in the employee drawer. Bank is read masked only. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { EmployeeReadinessCard } from '@/components/payroll/EmployeeReadinessCard';
import { EmployeeDrawerBody } from '@/components/payroll/EmployeeDrawerBody';

const EMP = '11111111-1111-4111-8111-111111111111';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ success: false, error: { message: 'no' } }), { status });
const salary = { componentType: 'earning', isTaxable: true, isRecurring: true, componentActive: true, effectiveFrom: '2020-01-01', effectiveTo: null };
const fetchMock = vi.fn();
/** Routes the three reads: bank (masked), the run list, and anything else empty. A Response is read once, so each call builds a new one. */
let runs: unknown[] = [];
const serveBank = (bank: () => Response) => fetchMock.mockImplementation(async (u: string) => {
  const url = String(u);
  if (url.includes('/bank-details')) return bank();
  if (url.endsWith('/api/payroll/runs')) return ok(runs);
  return ok([]);
});
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

beforeEach(() => { runs = []; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const props = { employeeId: EMP, employee: { taxNumber: '0123456789', paymentMethod: 'eft' }, assignments: [salary] };

describe('EmployeeReadinessCard', () => {
  it('says "Ready to pay" once the masked bank read answers with details', async () => {
    serveBank(() => ok({ id: 'b1', accountNumber: '…1234' }));
    render(<EmployeeReadinessCard {...props} />);
    expect(await screen.findByText('Ready to pay')).toBeTruthy();
    expect(urls().filter(u => u.includes('bank-details'))).toEqual([`/api/payroll/employees/${EMP}/bank-details?view=masked`]);
  });

  it('does not claim ready while the bank read is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<EmployeeReadinessCard {...props} />);
    expect(screen.queryByText('Ready to pay')).toBeNull();
    expect(screen.getByText('Checking…')).toBeTruthy();
  });

  it('lists what is missing as links to the fields', async () => {
    serveBank(() => ok(null));
    render(<EmployeeReadinessCard {...props} employee={{ taxNumber: '' }} assignments={[]} />);
    expect(await screen.findByText('3 things before the first pay run: a valid tax number, a salary, bank details')).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links.map(l => l.getAttribute('href'))).toEqual(['#employee-tax-number', '#employee-pay', '#employee-bank']);
  });

  it('a link focuses the field it names', async () => {
    serveBank(() => ok({ id: 'b1' }));
    render(<><input id="employee-tax-number" aria-label="Tax number" /><EmployeeReadinessCard {...props} employee={{ taxNumber: '' }} /></>);
    fireEvent.click(await screen.findByRole('link', { name: 'a valid tax number' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Tax number'));
  });

  it('cash without bank details is ready', async () => {
    serveBank(() => ok(null));
    render(<EmployeeReadinessCard {...props} employee={{ taxNumber: '0123456789', paymentMethod: 'cash' }} />);
    expect(await screen.findByText('Ready to pay')).toBeTruthy();
  });

  it('a failed bank read does not claim bank details are missing', async () => {
    fetchMock.mockResolvedValue(fail(500));
    render(<EmployeeReadinessCard {...props} />);
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull());
    expect(screen.queryByText('Ready to pay')).toBeNull();
    expect(screen.getByText('1 thing before the first pay run: Could not check bank details')).toBeTruthy();
  });

  it('judges the salary against the month after the latest calculated run', async () => {
    runs = [{ periodYear: 2026, periodMonth: 11, status: 'calculated' }];
    serveBank(() => ok({ id: 'b1' }));
    const endsNov = { ...salary, effectiveFrom: '2020-01-01', effectiveTo: '2026-11-30' };
    render(<EmployeeReadinessCard {...props} assignments={[endsNov]} />);
    expect(await screen.findByText('1 thing before the first pay run: a salary')).toBeTruthy();
  });

  it('reads the bank again when the refresh key changes', async () => {
    const answers = [() => ok(null), () => ok({ id: 'b1' })];
    let n = 0;
    serveBank(() => answers[Math.min(n++, 1)]!());
    const { rerender } = render(<EmployeeReadinessCard {...props} refreshKey={0} />);
    expect(await screen.findByText(/1 thing before the first pay run: bank details/)).toBeTruthy();
    rerender(<EmployeeReadinessCard {...props} refreshKey={1} />);
    expect(await screen.findByText('Ready to pay')).toBeTruthy();
  });
});

describe('EmployeeDrawerBody readiness line', () => {
  const employee = { id: EMP, employeeNumber: 'E-1', employmentType: 'permanent', startDate: '2026-03-01', taxNumber: '0123456789', paymentMethod: 'eft' };
  const serve = (bank: Response) => fetchMock.mockImplementation(async (u: string) => {
    if (u.includes('/bank-details')) return bank.clone();
    if (u.endsWith('/api/payroll/runs')) return ok([]);
    if (u.endsWith('/components')) return ok([{ ...salary, id: 'x', componentId: 'c', componentName: 'Basic', amount: 100 }]);
    return ok(employee);
  });

  it('shows the verdict line for a writer', async () => {
    serve(ok(null));
    render(<EmployeeDrawerBody employeeId={EMP} mayWrite />);
    expect(await screen.findByText('1 thing before the first pay run: bank details')).toBeTruthy();
  });

  it('a failed bank read shows the check line, never Ready to pay', async () => {
    serve(fail(500));
    render(<EmployeeDrawerBody employeeId={EMP} mayWrite />);
    expect(await screen.findByText('1 thing before the first pay run: Could not check bank details')).toBeTruthy();
  });

  it('asks for pay and bank together, before either answers', async () => {
    let release: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (u: string) => {
      if (u.endsWith('/components')) return new Promise<Response>(r => { release = r; });
      if (u.includes('/bank-details')) return ok(null);
      if (u.endsWith('/api/payroll/runs')) return ok([]);
      return ok(employee);
    });
    render(<EmployeeDrawerBody employeeId={EMP} mayWrite />);
    await waitFor(() => expect(urls().some(u => u.includes('bank-details'))).toBe(true));
    release(ok([]));
  });

  it('shows no line, and reads no bank, for a names-only role', async () => {
    serve(ok(null));
    render(<EmployeeDrawerBody employeeId={EMP} mayWrite={false} />);
    await screen.findByText('Employee number');
    expect(screen.queryByText(/pay run|Ready to pay/)).toBeNull();
    expect(urls().some(u => u.includes('bank-details'))).toBe(false);
  });
});
