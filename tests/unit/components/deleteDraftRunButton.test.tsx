/**
 * Wave 6 FQd: deleting a draft pay run from its page. Confirm first; DELETE /api/payroll/runs/[id]; on success the
 * page goes back to the runs list; a refusal is shown and nothing navigates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DeleteDraftRunButton } from '@/components/payroll/DeleteDraftRunButton';

const router = vi.hoisted(() => ({ push: vi.fn(async () => true) }));
vi.mock('next/router', () => ({ useRouter: () => ({ ...router, query: {}, isReady: true, pathname: '/' }) }));

const fetchMock = vi.fn();
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }), { status });
beforeEach(() => {
  fetchMock.mockReset();
  router.push.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DeleteDraftRunButton', () => {
  it('asks first; Keep sends nothing', () => {
    render(<DeleteDraftRunButton runId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    expect(screen.getByText('Delete this draft run?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes with DELETE and returns to the runs list', async () => {
    fetchMock.mockResolvedValue(json({ id: 'r1', deleted: true }));
    render(<DeleteDraftRunButton runId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/payroll/runs'));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect([String(url), init?.method]).toEqual(['/api/payroll/runs/r1', 'DELETE']);
  });

  it('shows the refusal and stays on the page', async () => {
    fetchMock.mockResolvedValue(json({ code: 'CONFLICT', message: 'This pay run cannot be deleted: it has been calculated.' }, 409));
    render(<DeleteDraftRunButton runId="r1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This pay run cannot be deleted: it has been calculated.')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });
});
