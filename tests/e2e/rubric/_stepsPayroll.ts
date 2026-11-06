/**
 * Rubric steps on payroll (master plan wave 4, MW): M5 grid typing, T3 keyboard-only employee create (B's "Ready to
 * pay" once it exists), and T4 the payslip through R-035 (PS's payslip once it exists). Sandbox only.
 *
 * T4 always runs the two-person R-035 path, payslip or not: reporting-qa submits the run for approval, the approver
 * decides it in a session of their own, and the run's stored decision must name them and not be a self-approval.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { Api } from '../golden-paths/_api';
import { notBuilt, Tally, type Evidence, type StepRecord } from './_rubricEvidence';
import type { Seeded } from './_rubricSeed';
import { chooseOption, isFocused, loadedOrReload, payslip, routeMissing, waitForPost } from './_rubricUi';

type RunView = {
  status: string;
  lines: Array<{ employeeId: string; netPay: number; grossPay: number }>;
  approvalDecision?: { selfApprovedSoleApprover: boolean; preparedByDecider: boolean } | null;
};
type Request = { documentType: string; documentId: string; status: string; requestedBy: string; decidedBy: string | null };

const runPage = (runId: string) => `/payroll/runs/${runId}`;

/** M5: type "1 500" in an overtime cell and press Enter. */
export async function measureM5(page: Page, ev: Evidence, api: Api, seed: Seeded): Promise<StepRecord> {
  const { run, employees: [first, second], overtimeId } = seed;
  const view = () => api.get<RunView>(`/api/payroll/runs/${run.id}`);
  const line = async () => (await view()).lines.find((l) => l.employeeId === first!.id)!;
  if ((await view()).status !== 'calculated') return { status: 'skipped', reason: `the run is ${(await view()).status} (a re-run of this run id)` };
  await page.goto(runPage(run.id), { waitUntil: 'domcontentloaded' });
  const picker = page.getByLabel('Once-off earning component');
  const reloadsToOpen = await loadedOrReload(page, picker);
  const pickerKind = await chooseOption(page, picker, /^Overtime \(3607\)/);
  const cell = page.getByLabel(`Once-off earning, ${first!.name}`);
  const below = page.getByLabel(`Once-off earning, ${second!.name}`);
  const before = await line();
  try {
    await cell.click();
    const t0 = Date.now();
    await page.keyboard.type('1 500');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('row').filter({ hasText: first!.employeeNumber }).getByText(/^Saved/)).toBeInViewport({ timeout: 30_000 });
    const msToSaved = Date.now() - t0;
    const enterMovedDown = await isFocused(below);
    const after = await line();
    const screenshot = await ev.shot(page, 'm5-grid-saved');
    await cell.focus();
    await page.keyboard.press('ArrowDown');
    const arrowDownMovesToNextRow = await isFocused(below);
    return {
      status: 'measured', reloadsToOpen, pickerKind, msToSaved, grossDelta: Math.round((after.grossPay - before.grossPay) * 100) / 100,
      grossRoseBy1500: Math.abs(after.grossPay - before.grossPay - 1500) < 0.005, netChanged: after.netPay !== before.netPay,
      enterMovedDown, arrowDownMovesToNextRow, screenshot,
    };
  } finally {
    const { inputs } = await api.get<{ inputs: { amounts: Array<{ employeeId: string; componentId: string; amount: number | null }> } }>(
      `/api/payroll/runs/${run.id}/inputs`);
    const held = inputs.amounts.find((a) => a.employeeId === first!.id && a.componentId === overtimeId);
    await api.put(`/api/payroll/runs/${run.id}/inputs`, { employeeId: first!.id, componentId: overtimeId, amount: 0, expectedAmount: held?.amount ?? 0 });
  }
}

/** Tab (counted) until `target` has focus. */
async function tabTo(tally: Tally, target: Locator): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await isFocused(target)) return;
    await tally.press('Tab');
  }
  throw new Error(`Tab never reached ${await target.getAttribute('aria-label') ?? await target.getAttribute('id') ?? 'a field'}`);
}

/** T3: create an employee with salary and bank by keyboard alone, fields taken in the order the page puts them. */
export async function measureT3(page: Page, ev: Evidence, runId: string): Promise<StepRecord> {
  await page.goto('/payroll/employees/new', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 60_000 });
  const reloadsToForm = await loadedOrReload(page, page.getByLabel(/^Monthly salary/));
  const fields: Array<[RegExp, string]> = [
    [/^First name/, 'Rita'], [/^Last name/, 'Rubric'], [/^Employee number/, `T3-${Date.now().toString(36)}`],
    [/^SARS tax number/, '0123456780'], [/^Monthly salary/, '25 000'], [/^Bank name/, 'FNB'], [/^Branch code/, '250655'],
    [/^Account number/, '62000121234'],
  ];
  const located = await Promise.all(fields.map(async ([label, value]) => {
    const loc = page.getByLabel(label).first();
    const order = await loc.evaluate((el) => [...document.querySelectorAll('*')].indexOf(el));
    return { loc, value, order };
  }));
  located.sort((a, b) => a.order - b.order);

  const tally = new Tally(page);
  for (const { loc, value } of located) {
    await tabTo(tally, loc);
    await tally.type(value);
  }
  await tabTo(tally, page.getByRole('button', { name: 'Create Employee' }));
  const posted = waitForPost(page, '/api/payroll/employees');
  await tally.press('Enter');
  const res = await posted;
  if (!res.ok()) throw new Error(`create employee answered ${res.status()}: ${(await res.text()).slice(0, 300)}`);
  await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const created = tally.summary();
  const reloadsToProfile = await loadedOrReload(page, page.getByTestId('employee-bank-card').getByText('•••• 1234'),
    /^Could not load (this employee|the bank details)/);
  const ready = page.getByText(/Ready to pay|before the first pay run/).first();
  const shown = await ready.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
  const readiness = shown
    ? { status: 'measured', text: (await ready.textContent())?.trim() }
    : notBuilt('B ("Ready to pay" card) has not merged: the profile shows no readiness line');
  const screenshot = await ev.shot(page, 't3-profile');
  return { status: 'measured', keyboardOnly: created.clicks === 0, ...created, reloadsToForm, reloadsToProfile, maskedAccount: '•••• 1234', readiness, screenshot };
}

/** T4: the payslip through R-035, two people, two sessions. */
export async function measureT4(page: Page, approverPage: Page, ev: Evidence, apis: { requester: Api; ids: { requester: string; approver: string } },
  seed: Seeded): Promise<StepRecord> {
  const { requester, ids } = apis;
  const runId = seed.run.id;
  const employeeId = seed.employees[0]!.id;
  const status = (await requester.get<RunView>(`/api/payroll/runs/${runId}`)).status;
  if (status !== 'calculated') return { status: 'skipped', reason: `the run is ${status} (a re-run of this run id)` };
  const payslipsBuilt = !(await routeMissing(requester, `/api/payroll/runs/${runId}/payslips?employeeId=${employeeId}`));
  const draftBefore = payslipsBuilt ? await payslip(requester, runId, employeeId) : null;

  const asker = new Tally(page);
  await page.goto(runPage(runId), { waitUntil: 'domcontentloaded' });
  const submitted = waitForPost(page, '/api/accounting/approval-requests');
  await asker.click(page.getByRole('button', { name: 'Submit for approval' }));
  expect((await submitted).status(), 'the approval request').toBe(200);

  const decider = new Tally(approverPage);
  await approverPage.goto('/accounting/approvals', { waitUntil: 'domcontentloaded' });
  const card = approverPage.locator('div', { hasText: 'Pay run' }).filter({ has: approverPage.getByRole('button', { name: 'Approve', exact: true }) }).last();
  const decided = waitForPost(approverPage, '/api/accounting/approval-requests');
  await decider.click(card.getByRole('button', { name: 'Approve', exact: true }));
  expect((await decided).status(), 'the approver\'s decision').toBe(200);
  const approverScreenshot = await ev.shot(approverPage, 't4-approver-decided');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await asker.click(page.getByRole('button', { name: /review & approve/i }));
  await asker.click(page.getByRole('dialog').getByRole('button', { name: /^Approve/ }));
  await expect.poll(async () => (await requester.get<RunView>(`/api/payroll/runs/${runId}`)).status, { timeout: 60_000 }).toBe('approved');
  // Who requested and who decided: the request itself (every server since R-035). The run's own summary of the decision
  // (`approvalDecision`) came later than the base SHA, so it is read where the server has it.
  const request = (await requester.get<{ items: Request[] }>('/api/accounting/approval-requests?status=approved')).items
    .find((r) => r.documentType === 'pay_run' && r.documentId === runId);
  expect(request?.requestedBy, 'requested by reporting-qa').toBe(ids.requester);
  expect(request?.decidedBy, 'decided by the second approver').toBe(ids.approver);
  // The sole-approver exception is a requester deciding their own request; two different people cannot be it.
  const summary = (await requester.get<RunView>(`/api/payroll/runs/${runId}`)).approvalDecision;
  if (summary) expect(summary.selfApprovedSoleApprover, 'not the sole-approver exception').toBe(false);
  const screenshot = await ev.shot(page, 't4-run-approved');
  const draftAfter = payslipsBuilt ? await payslip(requester, runId, employeeId) : null;

  return {
    status: 'measured',
    r035: {
      twoPersonPath: true, soleApproverException: request!.decidedBy === request!.requestedBy,
      requestedBy: request!.requestedBy, decidedBy: request!.decidedBy, runDecisionSummary: summary ?? 'not on this server',
    },
    requesterSession: asker.summary(), approverSession: decider.summary(),
    payslip: payslipsBuilt
      ? { status: 'measured', beforeApproval: draftBefore, afterApproval: draftAfter }
      : notBuilt('PS (payslips) has not merged: /api/payroll/runs/[id]/payslips does not exist'),
    screenshots: [approverScreenshot, screenshot],
  };
}
