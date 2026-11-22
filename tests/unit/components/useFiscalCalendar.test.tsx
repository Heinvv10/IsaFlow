import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
const company = vi.hoisted(() => ({ id: 'c1' as string | null, fy: 3 as unknown }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: company.id ? { id: company.id, financialYearStart: company.fy } : null }),
}));
import { useFiscalCalendar, resetFiscalCalendarCache } from '@/components/ui/useFiscalCalendar';

const periods = [
  { periodName: 'Mar 2026', fiscalYear: 2027, periodNumber: 1, startDate: '2026-03-01', endDate: '2026-03-31', status: 'closed' },
  { periodName: 'Nov 2026', fiscalYear: 2027, periodNumber: 9, startDate: '2026-11-01', endDate: '2026-11-30', status: 'open' },
];
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

function Probe({ iso }: { iso: string }) {
  const cal = useFiscalCalendar();
  const r = cal.check(iso, '2026-11-22');
  return <output data-testid="o">{`${cal.ready}|${r.level}|${r.code}`}</output>;
}
const out = () => screen.getByTestId('o').textContent;

beforeEach(() => { resetFiscalCalendarCache(); company.id = 'c1'; company.fy = 3; vi.mocked(apiFetch).mockReset().mockImplementation(async () => ok(periods)); });
afterEach(cleanup);

describe('useFiscalCalendar', () => {
  it('judges nothing until the periods arrive, then blocks a closed one', async () => {
    render(<Probe iso="2026-03-15" />);
    expect(out()).toBe('false|null|null');
    await waitFor(() => expect(out()).toBe('true|block|closed-period'));
  });
  it('one request serves every field on the page, and a second mount reuses it', async () => {
    render(<><Probe iso="2026-03-15" /><Probe iso="2026-11-10" /></>);
    await waitFor(() => expect(screen.getAllByTestId('o')[0]!.textContent).toBe('true|block|closed-period'));
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Probe iso="2026-03-15" />);
    await waitFor(() => expect(out()).toBe('true|block|closed-period'));
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
  });
  it('is per company', async () => {
    const { unmount } = render(<Probe iso="2026-03-15" />);
    await waitFor(() => expect(out()).toBe('true|block|closed-period'));
    unmount(); company.id = 'c2';
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    render(<Probe iso="2026-03-15" />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(out()).toBe('true|null|null')); // company 2 has no closed March: not blocked
  });
  it('switching company while mounted drops the old company\'s periods at once and loads the new ones', async () => {
    const { rerender } = render(<Probe iso="2026-03-15" />);
    await waitFor(() => expect(out()).toBe('true|block|closed-period'));
    company.id = 'c2';
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    rerender(<Probe iso="2026-03-15" />);
    expect(out()).toBe('false|null|null'); // never c1's closed March under c2
    await waitFor(() => expect(out()).toBe('true|null|null'));
  });
  it('a failed load never blocks: the server still judges', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('{}', { status: 500 }));
    render(<Probe iso="2026-03-15" />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(out()).toBe('false|null|null');
  });
  it('with no active company it makes no request', () => {
    company.id = null;
    render(<Probe iso="2026-03-15" />);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
    expect(out()).toBe('false|null|null');
  });
  it.each([13, 0, -1, 3.5, '3'])('a stored financial-year start of %s does not throw; the default month (March) is used', (bad) => {
    company.fy = bad;
    function FY() { const f = useFiscalCalendar(false).fiscalYear('2026-11-22'); return <output data-testid="o">{`${f.start}|${f.end}`}</output>; }
    render(<FY />);
    expect(out()).toBe('2026-03-01|2027-02-28');
  });
});
