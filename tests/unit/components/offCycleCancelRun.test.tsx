/**
 * Wave 6 OC, UI review #1620 L2: closing the Cancel run dialog (Escape or Keep run) returns focus to the "Cancel run"
 * button that opened it, never to the page body. The button shows only for an owner or admin on a draft or calculated
 * off-cycle run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', () => ({
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, m: string) => m,
}));

import { CancelOffCycleRun } from '@/components/payroll/offCycle/CancelOffCycleRun';

afterEach(() => cleanup());
const offCycle = { runKind: 'off_cycle', status: 'calculated' };

describe('CancelOffCycleRun', () => {
  it('Escape and Keep run each close the dialog and put focus back on the Cancel run button', async () => {
    render(<CancelOffCycleRun runId="r1" run={offCycle} companyRole="owner" onCancelled={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'Cancel run' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this off-cycle run?' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep run' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('shows for an owner or admin on a draft or calculated off-cycle run only', () => {
    const shown = (run: { runKind?: string; status: string }, role: string) => {
      const r = render(<CancelOffCycleRun runId="r1" run={run} companyRole={role} onCancelled={() => undefined} />);
      const n = screen.queryAllByRole('button', { name: 'Cancel run' }).length;
      r.unmount();
      return n;
    };
    expect(shown(offCycle, 'admin')).toBe(1);
    expect(shown({ runKind: 'off_cycle', status: 'draft' }, 'owner')).toBe(1);
    expect(shown(offCycle, 'manager')).toBe(0);
    expect(shown({ runKind: 'off_cycle', status: 'approved' }, 'owner')).toBe(0);
    expect(shown({ runKind: 'regular', status: 'calculated' }, 'owner')).toBe(0);
  });
});
