/**
 * The approve dialog's warning sentence must not say the run's warnings "do not block approval" when the pro-rata
 * guard (recurring_needs_pro_rata) is the blocker shown under it: that warning is the one that blocks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const preview = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiJson: vi.fn(async () => preview.value),
}));

import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';

afterEach(cleanup);

const plan = { runId: 'r1', status: 'calculated', entryDate: '2026-12-31', description: 'Payroll', lines: [], totals: {}, advisories: [] };
const renderDialog = () => render(
  <PayrollApproveDialog runId="r1" period="Dec 2026" warningCount={5} open onClose={vi.fn()} onApproved={vi.fn()} onUncertain={vi.fn()} />,
);

describe('PayrollApproveDialog warning sentence', () => {
  it('with the pro-rata blocker: says the pro-rata warning blocks, not that none do', async () => {
    preview.value = { plan, posted: null, replaces: null, planHash: 'h', blocker: { code: 'recurring_needs_pro_rata', detail: 'RD-1 Basic Salary starts on 2026-12-29.' } };
    renderDialog();
    expect(await screen.findByText(/needing a pro-rata blocks approval/i)).toBeTruthy();
    expect(screen.queryByText(/They do not block approval/i)).toBeNull();
  });

  it('without it: the warnings still say they do not block', async () => {
    preview.value = { plan, posted: null, replaces: null, planHash: 'h', blocker: null };
    renderDialog();
    expect(await screen.findByText(/They do not block approval/i)).toBeTruthy();
  });
});
