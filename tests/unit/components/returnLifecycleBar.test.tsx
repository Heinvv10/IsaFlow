/**
 * Wave 5 L2: the return lifecycle bar. Who sees which action, the amend reason is required, and every server
 * refusal is shown in the server's own words with the next step it names (override, legacy correction, force,
 * mismatch, stale tab). Period changes, load failures and the drawer: returnLifecycleBarPeriod.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { P, V1, button, h, installReturnApi, ready, refusal } from './helpers/returnLifecycleHarness';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

beforeEach(() => installReturnApi(apiFetch));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bar = (role: string | null) => render(<ReturnLifecycleBar form="VAT201" {...P} role={role} />);

it('shows each step with who and when', async () => {
  h.versions = [{ ...V1, status: 'superseded', filedBy: 'u-owner', filedAt: '2026-09-03T10:00:00Z', filedReference: 'REF-1',
    amendedBy: 'u-gone', amendedAt: '2026-09-04T10:00:00Z', amendReason: 'Missed a bill' },
  { ...V1, id: '22222222-2222-4222-8222-222222222222', versionNo: 2, amendsVersionId: V1.id }];
  bar('owner');
  await ready();
  const steps = within(screen.getByRole('list', { name: 'Lifecycle steps' })).getAllByRole('listitem').map((li) => li.textContent);
  await waitFor(() => expect(steps.length).toBe(4));
  await waitFor(() => expect(screen.getAllByText(/by Olive Owner/).length).toBeGreaterThan(0));
  const text = screen.getByRole('list', { name: 'Lifecycle steps' }).textContent ?? '';
  expect(text).toMatch(/v1 finalised by Olive Owner/);
  expect(text).toMatch(/v1 filed by Olive Owner .*reference REF-1/);
  expect(text).toMatch(/v1 amended by a former member .*Missed a bill/);
  expect(text).toMatch(/v2 finalised/);
});

it('role visibility: owner may file and amend; a manager may only finalise; a viewer nothing', async () => {
  h.versions = [V1];
  bar('owner'); await ready();
  expect(button(/^Mark filed$/)).toBeTruthy();
  expect(button(/^Amend$/)).toBeTruthy();
  cleanup();

  bar('manager'); await ready();
  expect(button(/^Mark filed$/)).toBeNull();
  expect(button(/^Amend$/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/Only an owner or admin/);
  cleanup();

  h.versions = [];
  bar('manager'); await ready();
  expect(button(/^Finalise v1$/)).toBeTruthy();
  cleanup();

  bar('viewer'); await ready();
  expect(button(/^Finalise/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/read-only/);
});

it('under Login-as no action is offered, amend included', async () => {
  document.cookie = 'is_impersonating=1; path=/';
  h.versions = [V1];
  bar('owner'); await ready();
  expect(button(/^Amend$/)).toBeNull();
  expect(button(/^Mark filed$/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/logged in as another user/);
});

it('amend needs a reason: blank or spaces keep it disabled; the reason is posted', async () => {
  h.versions = [V1];
  bar('owner'); await ready();
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  const go = within(dialog).getByRole('button', { name: /^Amend$/ }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  const reason = within(dialog).getByLabelText(/Reason for the amendment/);
  fireEvent.change(reason, { target: { value: '   ' } });
  expect(go.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: 'Missed a supplier bill' } });
  expect(go.disabled).toBe(false);
  fireEvent.click(go);
  await waitFor(() => expect(h.posts).toHaveLength(1));
  expect(h.posts[0]).toEqual({ url: '/api/accounting/sars/returns/vat201/amend', body: { versionId: V1.id, reason: 'Missed a supplier bill' } });
});

it('a server refusal of amend (Login-as without the cookie) is shown in its own words', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(403, 'This action cannot be taken while impersonating another user. End the impersonation and act as yourself.',
    { reason: 'IMPERSONATION_FORBIDDEN' })];
  bar('owner'); await ready();
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason for the amendment/), { target: { value: 'x' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Amend$/ }));
  expect((await within(dialog).findByTestId('return-refusal')).textContent).toBe(
    'This action cannot be taken while impersonating another user. End the impersonation and act as yourself.');
});

it('file: SEND_UNCERTAIN and a 409 amend-the-return are shown verbatim', async () => {
  h.versions = [V1];
  h.postReplies = [
    refusal(409, 'A send to SARS for this period may have reached it (correlation id C-9): poll or reconcile it before filing.', { code: 'SEND_UNCERTAIN' }),
    refusal(409, 'Version 1 no longer matches the ledger or payroll (netVat). Amend it and finalise again before filing.'),
  ];
  bar('owner'); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('SARS eFiling reference'), { target: { value: 'REF-9' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  expect((await within(dialog).findByTestId('return-refusal')).textContent).toMatch(/correlation id C-9\): poll or reconcile/);
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  await waitFor(() => expect(within(dialog).getByTestId('return-refusal').textContent).toMatch(/Amend it and finalise again/));
});

it('file blocked by VAT exceptions: owner sees the override box and must give a reason, which is posted', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(400, 'Blocking VAT exceptions are outstanding for this period.', { counts: { totalExceptions: 2, uncodedGlLineCount: 2 } })];
  bar('owner'); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('SARS eFiling reference'), { target: { value: 'REF-9' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  expect((await within(dialog).findByTestId('return-refusal')).textContent).toBe('Blocking VAT exceptions are outstanding for this period.');
  const go = within(dialog).getByRole('button', { name: /^Override and mark filed$/ }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole('textbox', { name: /override/i }), { target: { value: 'Accountant confirmed' } });
  expect(go.disabled).toBe(false);
  fireEvent.click(go);
  await waitFor(() => expect(h.posts).toHaveLength(2));
  expect(h.posts[1]!.body).toEqual({ versionId: V1.id, reference: 'REF-9', overrideReason: 'Accountant confirmed' });
});

it('LEGACY_SUBMISSION_EXISTS: the ids the server sent are named back with a reason', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(409, 'This period was already filed outside the return lifecycle: legacy-a, legacy-b.',
    { code: 'LEGACY_SUBMISSION_EXISTS', legacySubmissionIds: ['legacy-a', 'legacy-b'] })];
  bar('owner'); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('SARS eFiling reference'), { target: { value: 'REF-9' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  const reason = await within(dialog).findByLabelText(/Reason for superseding 2 earlier filings/);
  expect(within(dialog).getByTestId('return-refusal').textContent).toMatch(/already filed outside the return lifecycle/);
  const go = within(dialog).getByRole('button', { name: /^Mark filed$/ }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: 'Correcting the July filing' } });
  fireEvent.click(go);
  await waitFor(() => expect(h.posts).toHaveLength(2));
  expect(h.posts[1]!.body).toEqual({
    versionId: V1.id, reference: 'REF-9', correctsLegacySubmissionIds: ['legacy-a', 'legacy-b'], reason: 'Correcting the July filing',
  });
});

it('the badges say a lock was removed outside the lifecycle and that the return drifted', async () => {
  h.versions = [{ ...V1, lockRemoved: true, drift: { drifted: true, fields: [{ name: 'netVat', recorded: 1200, current: 1300 }], changed: [], unfinalRuns: 0 } }];
  bar('owner'); await ready();
  expect(screen.getByText('VAT period lock removed outside the lifecycle')).toBeTruthy();
  expect(screen.getByText(/Changed since finalised/)).toBeTruthy();
});

async function openFinalise(role = 'owner') {
  bar(role); await ready();
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await within(dialog).findByTestId('return-refusal');
  return dialog;
}

it('RATE_CHECK_FAILED: a force checkbox appears and the retry posts force: true', async () => {
  h.postReplies = [refusal(400, "This period fails SARS's 15% check: box 1 is out by 5.", { code: 'RATE_CHECK_FAILED' })];
  const dialog = await openFinalise();
  expect(within(dialog).getByTestId('return-refusal').textContent).toMatch(/fails SARS's 15% check/);
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /15% check/ }));
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(h.posts).toHaveLength(2));
  expect(h.posts[1]!.body).toEqual({ ...P, force: true });
});

it('VAT_RETURN_MISMATCH: a reason is required and posted with the acknowledgement', async () => {
  h.postReplies = [refusal(409, 'A VAT return already recorded as submitted for this period has different figures.', { code: 'VAT_RETURN_MISMATCH' })];
  const dialog = await openFinalise();
  const go = within(dialog).getByRole('button', { name: /^Finalise$/ }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  expect(within(dialog).getByTestId('return-action-missing').textContent).toBe('A reason is required.');
  fireEvent.change(within(dialog).getByLabelText(/recorded VAT return differs/), { target: { value: 'The old record was a test' } });
  fireEvent.click(go);
  await waitFor(() => expect(h.posts).toHaveLength(2));
  expect(h.posts[1]!.body).toEqual({ ...P, acknowledgeVatReturnMismatch: true, mismatchReason: 'The old record was a test' });
});

it('after a successful action the dialog closes and the bar reloads to the new state', async () => {
  bar('owner'); await ready();
  expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Not finalised');
  h.versions = [V1];
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Finalised (v1), not filed'));
  expect(button(/^Mark filed$/)).toBeTruthy();
});

it('a stale tab (LIVE_VERSION_EXISTS): the bar reloads and the dialog offers Amend instead or Close', async () => {
  h.postReplies = [refusal(409, 'This VAT201 is already finalised as version 1. Amend it before finalising again.', { code: 'LIVE_VERSION_EXISTS' })];
  bar('owner'); await ready();
  h.versions = [V1]; // finalised in another tab meanwhile
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Finalised (v1), not filed'));
  expect(within(dialog).getByTestId('return-refusal').textContent).toMatch(/Amend it before finalising again/);
  expect(dialog.textContent).toMatch(/Finalise VAT201 v1(?!\d)/); // not renumbered by the reload
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Amend instead' }));
  expect((await screen.findByRole('dialog')).textContent).toMatch(/Amend VAT201 v1/);
});

it('a stale tab seen by a manager offers Close only', async () => {
  h.postReplies = [refusal(409, 'This VAT201 is already finalised as version 1. Amend it before finalising again.', { code: 'LIVE_VERSION_EXISTS' })];
  bar('manager'); await ready();
  h.versions = [V1];
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Finalised (v1), not filed'));
  expect(within(dialog).queryByRole('button', { name: 'Amend instead' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
});

it('the exceptions override is for owner/admin: a manager sees the refusal and no reason box', async () => {
  const gate = () => refusal(400, 'Blocking VAT exceptions are outstanding for this period.', { counts: { totalExceptions: 1, uncodedGlLineCount: 1 } });
  h.postReplies = [gate()];
  let dialog = await openFinalise('manager');
  expect(within(dialog).queryByRole('textbox', { name: /override/i })).toBeNull();
  expect((within(dialog).getByRole('button', { name: /^Finalise$/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(dialog).getByTestId('return-action-missing').textContent).toMatch(/Only an owner or admin/);
  cleanup();
  h.postReplies = [gate()];
  dialog = await openFinalise('admin');
  expect(within(dialog).getByRole('textbox', { name: /override/i })).toBeTruthy();
});

it('a schema refusal (422) names the field problems after the server message', async () => {
  h.postReplies = [refusal(422, 'Validation failed', { mismatchReason: ['mismatchReason is required with acknowledgeVatReturnMismatch'] })];
  const dialog = await openFinalise();
  expect(within(dialog).getByTestId('return-refusal').textContent)
    .toBe('Validation failed: mismatchReason is required with acknowledgeVatReturnMismatch');
});

it('a filed live version offers Amend but not Mark filed', async () => {
  h.versions = [{ ...V1, status: 'filed', filedBy: 'u-owner', filedAt: '2026-09-03T10:00:00Z', filedReference: 'R' }];
  bar('owner'); await ready();
  expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Filed (v1)');
  expect(button(/^Mark filed$/)).toBeNull();
  expect(button(/^Amend$/)).toBeTruthy();
});

it('LEGACY_SUBMISSION_EXISTS without ids is an ordinary refusal: no empty correction is offered', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(409, 'This period was already filed outside the return lifecycle.', { code: 'LEGACY_SUBMISSION_EXISTS', legacySubmissionIds: [] })];
  bar('owner'); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('SARS eFiling reference'), { target: { value: 'REF-9' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  await within(dialog).findByTestId('return-refusal');
  expect(within(dialog).queryByLabelText(/Reason for superseding/)).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  await waitFor(() => expect(h.posts).toHaveLength(2));
  expect(h.posts[1]!.body).toEqual({ versionId: V1.id, reference: 'REF-9' });
});
