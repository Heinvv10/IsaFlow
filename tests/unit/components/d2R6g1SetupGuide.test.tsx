/**
 * D2 round 6 (g1): SetupGuideButton ticks. Two quick ticks must both persist (the write is built from the latest set,
 * not a closed-over copy), writes go one after another so a later one can never be overtaken by an earlier one, and a
 * refused write takes back ONLY its own tick. REAL assertOk / apiErrorMessage over the scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/onboarding/SetupGuideDrawer', () => ({
  SetupGuideDrawer: ({ completedTasks, onMarkDone }: { completedTasks: Set<string>; onMarkDone: (id: string) => void }) => (
    <div>
      <button onClick={() => onMarkDone('A')}>tick A</button>
      <button onClick={() => onMarkDone('B')}>tick B</button>
      <p>done: {[...completedTasks].sort().join(',')}</p>
    </div>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import { SetupGuideButton } from '../../../src/components/onboarding/SetupGuideButton';

useApiJsonOverMock();
type Gate = { resolve: (r: Response) => void };
let gates: Gate[] = [];
let bodies: string[][] = [];
const MANUAL = 'setup-guide-manual-done';

/** Loads are answered at once; each PUT waits on a gate the test opens (or answers at once when `auto`). */
function serve(auto?: (n: number) => Response | undefined) {
  gates = []; bodies = [];
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET') !== 'PUT') return String(url).includes('setup-guide') ? ok({ completedTasks: [] }) : ok({ 'setup-guide-first-seen': new Date().toISOString() });
    const prefs = (JSON.parse(String(init?.body)) as { preferences: Record<string, string> }).preferences;
    if (prefs[MANUAL]) bodies.push(JSON.parse(prefs[MANUAL]) as string[]);
    const n = bodies.length;
    const now = auto?.(n);
    return now ?? new Promise<Response>((resolve) => { gates.push({ resolve }); });
  });
}
const open = async () => { render(<SetupGuideButton />); await screen.findByText(/^done:/); };
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('SetupGuideButton ticks', () => {
  it('two quick ticks both persist: the last write holds both, and only one write is in flight at a time', async () => {
    serve();
    await open();
    fireEvent.click(screen.getByText('tick A'));
    fireEvent.click(screen.getByText('tick B'));
    await waitFor(() => expect(gates.length).toBe(1));
    expect(bodies.length).toBe(1);                     // B's write waits for A's
    await act(async () => { gates[0]!.resolve(ok({})); });
    await waitFor(() => expect(gates.length).toBe(2));
    await act(async () => { gates[1]!.resolve(ok({})); });
    expect([...bodies.at(-1)!].sort()).toEqual(['A', 'B']);
    expect(screen.getByText('done: A,B')).toBeTruthy();
  });

  it('a refused write takes back only its own tick; the other stays and is saved without it', async () => {
    serve((n) => (n === 1 ? new Response('', { status: 500 }) : ok({})));
    await open();
    fireEvent.click(screen.getByText('tick A'));
    fireEvent.click(screen.getByText('tick B'));
    expect(await screen.findByText('Could not save that task - try again')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('done: B')).toBeTruthy());
    expect(bodies.at(-1)).toEqual(['B']);
  });

  it('a refused write shows the server message', async () => {
    serve(() => new Response(JSON.stringify({ success: false, error: { code: 'X', message: 'D2 server says no' } }), { status: 400 }));
    await open();
    fireEvent.click(screen.getByText('tick A'));
    expect(await screen.findByText('D2 server says no')).toBeTruthy();
    expect(screen.getByText('done:')).toBeTruthy();
  });

  it('a failing setup-guide endpoint (500) hides the guide quietly: no tick UI, no crash', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => String(url).includes('setup-guide')
      ? new Response(JSON.stringify({ success: false, error: { code: 'INTERNAL', message: 'boom' } }), { status: 500 })
      : ok({}));
    const { container } = render(<SetupGuideButton />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(container.innerHTML).toBe('');
    expect(screen.queryByText(/^done:/)).toBeNull();
  });
});
