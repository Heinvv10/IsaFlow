import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'c1', financialYearStart: 3 } }) }));
import { DateField, type DateFieldProps } from '@/components/ui/DateField';
import { resetFiscalCalendarCache } from '@/components/ui/useFiscalCalendar';

const TODAY = (): Date => new Date('2026-11-22T10:00:00Z');
const P = (n: number, start: string, end: string, status: string, name: string) =>
  ({ periodName: name, fiscalYear: 2027, periodNumber: n, startDate: start, endDate: end, status });
const PERIODS = [
  P(1, '2026-03-01', '2026-03-31', 'closed', 'Mar 2026'),
  P(2, '2026-04-01', '2026-04-30', 'locked', 'Apr 2026'),
  P(3, '2026-05-01', '2026-05-31', 'open', 'May 2026'),
  P(9, '2026-11-01', '2026-11-30', 'open', 'Nov 2026'),
  P(12, '2027-02-01', '2027-02-28', 'open', 'Feb 2027'),
];
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

function Harness(props: Partial<DateFieldProps> & { initial?: string | null; spy?: DateFieldProps['onChange'] }) {
  const { initial = null, spy, ...rest } = props;
  const [value, setValue] = useState<string | null>(initial);
  return (
    <>
      <DateField label="Invoice date" value={value} getToday={TODAY} onChange={(v, validity) => { spy?.(v, validity); setValue(v); }} {...rest} />
      <output data-testid="out">{value ?? 'null'}</output>
    </>
  );
}
const input = () => screen.getByRole('textbox', { name: /Invoice date/ }) as HTMLInputElement;
const out = () => screen.getByTestId('out').textContent;
const type = (t: string) => { fireEvent.focus(input()); fireEvent.change(input(), { target: { value: t } }); fireEvent.blur(input()); };
const loaded = async () => { await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled()); await new Promise((r) => setTimeout(r, 10)); };

beforeEach(() => { resetFiscalCalendarCache(); vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(PERIODS)); });
afterEach(cleanup);

describe('DateField postingDate: closed periods', () => {
  it('refuses a date in a closed or locked period, naming it, and reports the code', async () => {
    const spy = vi.fn(); render(<Harness postingDate spy={spy} />);
    await loaded();
    type('15 Mar 2026');
    expect(screen.getByRole('alert').textContent).toMatch(/Mar 2026.*closed/);
    expect(spy).toHaveBeenLastCalledWith(null, expect.objectContaining({ valid: false, code: 'closed-period' }));
    type('2 Apr 2026');
    expect(screen.getByRole('alert').textContent).toMatch(/Apr 2026.*locked/);
    type('10 May 2026'); expect(out()).toBe('2026-05-10');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('a field without postingDate neither fetches nor blocks', () => {
    render(<Harness />);
    type('15 Mar 2026');
    expect(out()).toBe('2026-03-15');
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it('before the periods load, or when they fail to, a date is accepted (the server still judges)', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('{}', { status: 500 }));
    render(<Harness postingDate />);
    await loaded();
    type('15 Mar 2026');
    expect(out()).toBe('2026-03-15');
  });
  it('a closed month in the popup is disabled with its reason and cannot be picked', async () => {
    render(<Harness postingDate initial="2026-05-10" />);
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: /choose date/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' })); // April
    const cell = (iso: string) => screen.getByRole('grid').querySelector<HTMLElement>(`[data-iso="${iso}"]`)!;
    expect(cell('2026-04-15').getAttribute('aria-disabled')).toBe('true');
    expect(cell('2026-04-15').getAttribute('title')).toMatch(/Apr 2026.*locked/);
    fireEvent.click(cell('2026-04-15'));
    expect(out()).toBe('2026-05-10');
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(cell('2026-05-20'));
    expect(out()).toBe('2026-05-20');
  });
});

describe('DateField postingDate: outside the financial year', () => {
  it('warns (amber, not an error) and still accepts the date', async () => {
    const spy = vi.fn(); render(<Harness postingDate spy={spy} />);
    await loaded();
    type('15 Mar 2027');
    expect(out()).toBe('2027-03-15');
    const note = screen.getByText(/outside the current financial year/);
    expect(note.getAttribute('role')).toBe('status');
    expect(note.textContent).toMatch(/outside the current financial year \(1 Mar 2026 to 28 Feb 2027\)/);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input().getAttribute('aria-invalid')).toBe('false');
    expect(input().getAttribute('aria-describedby')).toContain(note.id);
    type('10 May 2026');
    expect(screen.queryByText(/outside the current financial year/)).toBeNull();
  });
});

describe('DateField y / r shortcuts (financial year)', () => {
  it('y is the first day and r the last day of the financial year, with or without postingDate', () => {
    render(<Harness />);
    type('y'); expect(out()).toBe('2026-03-01');
    type('r'); expect(out()).toBe('2027-02-28');
    type('Y'); expect(out()).toBe('2026-03-01');
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it('they use the periods when loaded, and the closed-period rule still applies to the result', async () => {
    render(<Harness postingDate />);
    await loaded();
    type('y'); // 1 Mar 2026 is in the closed March
    expect(screen.getByRole('alert').textContent).toMatch(/Mar 2026.*closed/);
    type('r'); expect(out()).toBe('2027-02-28');
  });
  it('the popup hint lists them', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /choose date/i }));
    expect(screen.getByText(/y financial year start/)).toBeTruthy();
  });
});
