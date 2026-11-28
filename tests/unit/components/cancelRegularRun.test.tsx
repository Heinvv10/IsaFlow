/**
 * Wave 7 CX (W28): cancelling a calculated regular run from its page. Only a calculated regular run, only an owner or
 * admin; confirm first; POST /api/payroll/runs/[id]/cancel; on success back to the runs list (the run is gone); a
 * refusal is shown and nothing navigates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CancelRegularRun } from '@/components/payroll/CancelRegularRun';

const router = vi.hoisted(() => ({ push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => ({ ...router, query: {}, isReady: true, pathname: '/' }) }));

const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status });
const calculated = { runKind: 'regular', status: 'calculated' };
beforeEach(() => {
  fetchMock.mockReset();
  router.push.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CancelRegularRun', () => {
  it('renders only for a calculated regular run and an owner or admin', () => {
    const cases: Array<[{ runKind: string; status: string }, string, boolean]> = [
      [calculated, 'owner', true], [calculated, 'admin', true], [calculated, 'manager', false], [calculated, 'viewer', false],
      [{ runKind: 'regular', status: 'draft' }, 'owner', false], [{ runKind: 'regular', status: 'approved' }, 'owner', false],
      [{ runKind: 'regular', status: 'paid' }, 'owner', false], [{ runKind: 'off_cycle', status: 'calculated' }, 'owner', false],
    ];
    for (const [run, role, shown] of cases) {
      const { unmount } = render(<CancelRegularRun runId="r1" run={run} companyRole={role} />);
      expect(screen.queryByRole('button', { name: 'Cancel run' }) != null, `${run.runKind}/${run.status}/${role}`).toBe(shown);
      unmount();
    }
  });

  it('asks first; Keep run sends nothing', () => {
    render(<CancelRegularRun runId="r1" run={calculated} companyRole="owner" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(screen.getByText('Cancel this pay run?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep run' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels with POST and returns to the runs list', async () => {
    fetchMock.mockResolvedValue(json({ runId: 'r1', deleted: true }));
    render(<CancelRegularRun runId="r1" run={calculated} companyRole="admin" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this run' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/runs'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect([String(url), init?.method]).toEqual(['/api/payroll/runs/r1/cancel', 'POST']);
  });

  it('shows the refusal and stays on the page', async () => {
    const message = 'This pay run cannot be cancelled: it was reopened after an approval.';
    fetchMock.mockResolvedValue(json({ code: 'CONFLICT', message, details: { code: 'RUN_NOT_CANCELLABLE' } }, 409));
    render(<CancelRegularRun runId="r1" run={calculated} companyRole="owner" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this run' }));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});
