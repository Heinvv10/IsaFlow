/**
 * Wave 7 PRA (W29, review #1901 M2): the run page's card for a share beside a once-off earning. It lists each employee's
 * pair with the server's sentence; an owner or admin acknowledges one (POST { employeeId }) and the list reloads; anyone
 * else sees no button; a refused acknowledgement shows the server's message; with no pairs it renders nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecurringShareCard } from '@/components/payroll/RecurringShareCard';

const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status });
const pair = (acknowledged: boolean) => ({
  employeeId: 'e1', employeeNumber: 'E-1', employeeName: 'Raj Raise', acknowledged, pairKey: 'k',
  message: 'Basic Salary (11 of 21 working days (0.5238)) ran for part of this period and is paid its share, and a once-off earning is paid in the same period (Annual bonus 1000.00).',
});
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('RecurringShareCard', () => {
  it('names the pair; Acknowledge posts { employeeId } and reloads', async () => {
    let acked = false;
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'POST') { acked = true; return json(pair(true)); }
      return json({ pairs: [pair(acked)] });
    });
    render(<RecurringShareCard runId="r1" canAcknowledge />);
    expect(await screen.findByText(/11 of 21 working days .*Annual bonus 1000\.00/)).toBeTruthy();
    expect(screen.getByText('E-1 Raj Raise')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge for Raj Raise' }));
    expect(await screen.findByText('Acknowledged')).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect([String(post[0]), JSON.parse(String(post[1].body))]).toEqual(['/api/payroll/runs/r1/recurring-share', { employeeId: 'e1' }]);
  });

  it('shows no button to anyone but an owner or admin', async () => {
    fetchMock.mockResolvedValue(json({ pairs: [pair(false)] }));
    render(<RecurringShareCard runId="r1" canAcknowledge={false} />);
    expect(await screen.findByText(/Annual bonus 1000\.00/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it("a refused acknowledgement shows the server's message and keeps the button", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => (init?.method === 'POST'
      ? json({ code: 'CONFLICT', message: 'This run is approved: a share beside a once-off is acknowledged before approval.' }, 409)
      : json({ pairs: [pair(false)] })));
    render(<RecurringShareCard runId="r1" canAcknowledge />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge for Raj Raise' }));
    expect((await screen.findByRole('alert')).textContent).toContain('acknowledged before approval');
    expect(screen.getByRole('button', { name: 'Acknowledge for Raj Raise' })).toBeTruthy();
  });

  it('renders nothing without pairs', async () => {
    fetchMock.mockResolvedValue(json({ pairs: [] }));
    const { container } = render(<RecurringShareCard runId="r1" canAcknowledge />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
