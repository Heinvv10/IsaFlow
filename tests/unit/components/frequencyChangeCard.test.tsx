/**
 * Wave 6 FQd (breaker #1622 M2): the run page's pay-frequency change card. It lists the run's straddles (days paid twice
 * or unpaid) with the once-off instruction; an owner or admin acknowledges one (POST { employeeId }) and the list reloads;
 * anyone else sees no button; with no straddles it renders nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FrequencyChangeCard } from '@/components/payroll/FrequencyChangeCard';

const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status });
const straddle = (acknowledged: boolean) => ({
  employeeId: 'e1', employeeNumber: 'E-1', oldFrequency: 'weekly', oldEnd: '2026-03-01', start: '2026-03-01',
  overlap: { from: '2026-03-01', to: '2026-03-01' }, gap: null, acknowledged,
});
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FrequencyChangeCard', () => {
  it('names the days and the once-off; Acknowledge posts { employeeId } and reloads', async () => {
    let acked = false;
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method === 'POST') { acked = true; return json(straddle(true)); }
      return json({ straddles: [straddle(acked)] });
    });
    render(<FrequencyChangeCard runId="r1" canAcknowledge />);
    expect(await screen.findByText(/2026-03-01 would be paid twice/)).toBeTruthy();
    expect(screen.getByText(/once-off adjustment/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge for E-1' }));
    expect(await screen.findByText('Acknowledged')).toBeTruthy();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect([String(post[0]), JSON.parse(String(post[1].body))]).toEqual(['/api/payroll/runs/r1/frequency-change', { employeeId: 'e1' }]);
    expect(screen.queryByRole('button', { name: 'Acknowledge for E-1' })).toBeNull();
  });

  it('shows no button to anyone but an owner or admin', async () => {
    fetchMock.mockResolvedValue(json({ straddles: [straddle(false)] }));
    render(<FrequencyChangeCard runId="r1" canAcknowledge={false} />);
    expect(await screen.findByText(/would be paid twice/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing without straddles', async () => {
    fetchMock.mockResolvedValue(json({ straddles: [] }));
    const { container } = render(<FrequencyChangeCard runId="r1" canAcknowledge />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
