/**
 * The approval dialog in dark mode (#1f2937): gray-500 headings measured 3.03:1 and red-500 refusals 3.9:1
 * (browser QA, axe). Each carries a dark-mode colour that clears AA.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';
import { PLAN_URL, RUN_ID, planBody, ok, fail } from './payroll/payrollRunFixtures';

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const open = async (answer: Response) => {
  fetchMock.mockImplementation(async (url: string) => (url === PLAN_URL ? answer : fail(404, 'no')));
  render(<PayrollApproveDialog runId={RUN_ID} period="Sep 2026" warningCount={0} open onClose={() => undefined} onApproved={() => undefined} onUncertain={() => undefined} />);
  return screen.findByRole('dialog');
};

describe('approval dialog contrast in dark mode', () => {
  it('the journal table headings: not gray-500 alone', async () => {
    const dialog = await open(ok(planBody()));
    expect((await within(dialog).findByText('Debit')).closest('tr')!.className).toContain('dark:text-gray-300');
  });

  it('a blocker: not red-500 alone', async () => {
    const dialog = await open(ok(planBody({ code: 'closed_period', detail: 'The period is closed.' })));
    expect((await within(dialog).findByText('The period is closed.')).className).toContain('dark:text-red-400');
  });

  it('a preview that will not load: not red-500 alone', async () => {
    const dialog = await open(fail(400, 'Could not read the plan'));
    expect((await within(dialog).findByText(/Could not read the plan/)).className).toContain('dark:text-red-400');
  });
});
