/**
 * WP4a: the transfer re-link (a WRITE, POST bank-relink-transfers) runs the first time each account is selected during a
 * visit to the page, not on every selection. A failed pass is not remembered, so selecting the account again retries it.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const role = vi.hoisted(() => ({ value: 'owner' as string }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.value }) }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { useRelinkTransfers } from '@/components/accounting/bank-transactions/useRelinkTransfers';

const ok = (data: unknown = { linked: 0 }) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const posts = () => vi.mocked(apiFetch).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).bankAccountId as string);

beforeEach(() => { role.value = 'owner'; vi.mocked(apiFetch).mockReset(); vi.mocked(apiFetch).mockImplementation(async () => ok()); });

describe('useRelinkTransfers: once per account per visit', () => {
  it('a, b, a, b again: two POSTs (a and b), not four', async () => {
    const { rerender } = renderHook(({ id }) => useRelinkTransfers(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(posts()).toEqual(['a']));
    for (const id of ['b', 'a', 'b']) { rerender({ id }); await new Promise(r => setTimeout(r, 5)); }
    expect(posts()).toEqual(['a', 'b']);
  });

  it('a failed pass (500) is retried when the account is selected again; a success is not', async () => {
    vi.mocked(apiFetch).mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    const { result, rerender } = renderHook(({ id }) => useRelinkTransfers(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ id: 'b' }); await waitFor(() => expect(posts()).toEqual(['a', 'b']));
    rerender({ id: 'a' }); await waitFor(() => expect(posts()).toEqual(['a', 'b', 'a'])); // a failed: tried again
    await waitFor(() => expect(result.current).toBe(false));
    rerender({ id: 'b' }); rerender({ id: 'a' }); await new Promise(r => setTimeout(r, 5));
    expect(posts()).toEqual(['a', 'b', 'a']); // both succeeded now: nothing more
  });

  it('a pass the server reports as failed (failed: true) is also retried', async () => {
    vi.mocked(apiFetch).mockImplementationOnce(async () => ok({ failed: true, linked: 0 }));
    const { result, rerender } = renderHook(({ id }) => useRelinkTransfers(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ id: 'b' }); rerender({ id: 'a' });
    await waitFor(() => expect(posts().filter(x => x === 'a')).toHaveLength(2));
  });

  it('a new visit (a fresh mount) re-links again', async () => {
    const first = renderHook(() => useRelinkTransfers('a'));
    await waitFor(() => expect(posts()).toEqual(['a']));
    first.unmount();
    renderHook(() => useRelinkTransfers('a'));
    await waitFor(() => expect(posts()).toEqual(['a', 'a']));
  });

  it('a role that may not write never calls it (unchanged)', async () => {
    role.value = 'viewer';
    renderHook(() => useRelinkTransfers('a'));
    await new Promise(r => setTimeout(r, 5));
    expect(posts()).toEqual([]);
  });

  it('a link made reports it once', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok({ linked: 2, batchId: 'bt1' }));
    const onLinked = vi.fn();
    const { rerender } = renderHook(({ id }) => useRelinkTransfers(id, onLinked), { initialProps: { id: 'a' } });
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ linked: 2, batchId: 'bt1' }));
    rerender({ id: 'b' });
    await waitFor(() => expect(onLinked).toHaveBeenCalledTimes(2));
    rerender({ id: 'a' });
    await new Promise(r => setTimeout(r, 5));
    expect(onLinked).toHaveBeenCalledTimes(2); // a and b once each, the repeat of a ran nothing
  });
});

/** A response the test answers by hand, when it likes. */
function manual() {
  const answers: Array<(r: Response) => void> = [];
  vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>((resolve) => { answers.push(resolve); }));
  return answers;
}
const turn = () => new Promise(r => setTimeout(r, 5));

describe('mid-flight (account switched before the answer), failure paths and StrictMode', () => {
  it('a, then b, then a again while a is STILL in flight: a is not posted twice, and its late answer still reports what it linked', async () => {
    const answers = manual();
    const onLinked = vi.fn();
    const { rerender } = renderHook(({ id }) => useRelinkTransfers(id, onLinked), { initialProps: { id: 'a' } });
    await waitFor(() => expect(posts()).toEqual(['a']));
    rerender({ id: 'b' }); await waitFor(() => expect(posts()).toEqual(['a', 'b']));
    rerender({ id: 'a' }); await turn();
    expect(posts()).toEqual(['a', 'b']); // the pass for a is under way: not started again
    answers[0]!(ok({ linked: 3, batchId: 'bt-a' })); // ...and it finally answers, after the user had left and returned
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ linked: 3, batchId: 'bt-a' }));
  });

  it('an answer that arrives after the user moved on is still reported (what it linked is real)', async () => {
    const answers = manual();
    const onLinked = vi.fn();
    const { rerender } = renderHook(({ id }) => useRelinkTransfers(id, onLinked), { initialProps: { id: 'a' } });
    await waitFor(() => expect(posts()).toEqual(['a']));
    rerender({ id: 'b' }); await waitFor(() => expect(posts()).toEqual(['a', 'b']));
    answers[0]!(ok({ linked: 2, batchId: 'bt-a' }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ linked: 2, batchId: 'bt-a' }));
  });

  it('a 500 that arrives after switching away is retried when the account is selected again, and does not flag the account now on screen', async () => {
    const answers = manual();
    const { result, rerender } = renderHook(({ id }) => useRelinkTransfers(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(posts()).toEqual(['a']));
    rerender({ id: 'b' }); await waitFor(() => expect(posts()).toEqual(['a', 'b']));
    answers[0]!(new Response('{}', { status: 500 }));
    await turn();
    expect(result.current).toBe(false); // b is on screen; a's failure is not b's notice
    answers[1]!(ok());
    await turn();
    rerender({ id: 'a' });
    await waitFor(() => expect(posts()).toEqual(['a', 'b', 'a'])); // retried
  });

  it('the failure of the account on screen shows the notice', async () => {
    const answers = manual();
    const { result } = renderHook(() => useRelinkTransfers('a'));
    await waitFor(() => expect(posts()).toEqual(['a']));
    answers[0]!(new Response('{}', { status: 500 }));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('a request that rejects (network) is retried on the next selection of that account', async () => {
    vi.mocked(apiFetch).mockImplementationOnce(async () => { throw new Error('offline'); });
    const { result, rerender } = renderHook(({ id }) => useRelinkTransfers(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current).toBe(true));
    rerender({ id: 'b' }); await waitFor(() => expect(posts()).toEqual(['a', 'b']));
    rerender({ id: 'a' }); await waitFor(() => expect(posts()).toEqual(['a', 'b', 'a']));
  });

  it('REACT STRICTMODE: the effect runs, is cleaned up and runs again, yet the pass is posted ONCE and its result arrives', async () => {
    const answers = manual();
    const onLinked = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useRelinkTransfers('a', onLinked), { wrapper });
    await waitFor(() => expect(posts().length).toBeGreaterThan(0));
    await turn();
    expect(posts()).toEqual(['a']);
    answers[0]!(ok({ linked: 1, batchId: 'bt1' }));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith({ linked: 1, batchId: 'bt1' }));
  });

  it('a 403 is final for the visit: no notice, no retry', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response('{}', { status: 403 }));
    const { result, rerender } = renderHook(({ id }) => useRelinkTransfers(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(posts()).toEqual(['a']));
    rerender({ id: 'b' }); await waitFor(() => expect(posts()).toEqual(['a', 'b']));
    rerender({ id: 'a' }); await turn();
    expect(posts()).toEqual(['a', 'b']); expect(result.current).toBe(false);
  });
});

