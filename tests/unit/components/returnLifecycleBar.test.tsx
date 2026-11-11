/**
 * Wave 5 L2: the return lifecycle bar. Who sees which action, the amend reason is required, and every server
 * refusal is shown in the server's own words with the next step it names (override, legacy correction).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

const P = { periodStart: '2026-07-01', periodEnd: '2026-08-31' };
const V1 = {
  id: '11111111-1111-4111-8111-111111111111', formType: 'VAT201', ...P, versionNo: 1, status: 'finalised',
  figures: { outputTax: 1500, inputTax: 300, netVat: 1200, sarsFields: [] }, postedThrough: '2026-09-01',
  vatPeriodLockId: 'lock-1', sarsSubmissionId: null, filedReference: null, amendsVersionId: null,
  finalisedBy: 'u-owner', finalisedAt: '2026-09-02T10:00:00Z', filedBy: null, filedAt: null,
  amendedBy: null, amendReason: null, amendedAt: null,
  drift: { drifted: false, fields: [], changed: [], unfinalRuns: 0 }, lockRemoved: false,
};

type Reply = { status: number; body: unknown };
let versions: unknown[] = [];
let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let postReplies: Reply[] = [];
let submissions: unknown[] = [];

const json = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  versions = []; posts = []; postReplies = []; submissions = [];
  document.cookie = 'is_impersonating=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return json(postReplies.shift() ?? { status: 200, body: { success: true, data: {} } });
    }
    if (url.includes('/versions?')) return json({ status: 200, body: { success: true, data: { versions, vatReturn: null } } });
    if (url.startsWith('/api/accounting/company-users')) {
      return json({ status: 200, body: { success: true, data: [{ userId: 'u-owner', name: 'Olive Owner' }] } });
    }
    if (url.startsWith('/api/accounting/sars/sars-submissions')) return json({ status: 200, body: { success: true, data: { items: submissions } } });
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bar = (role: string | null) => render(<ReturnLifecycleBar form="VAT201" {...P} role={role} />);
const ready = () => waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).not.toBe('Loading…'));
const button = (name: RegExp) => screen.queryByRole('button', { name });
const refusal = (status: number, message: string, details?: Record<string, unknown>): Reply =>
  ({ status, body: { success: false, error: { code: 'X', message, ...(details ? { details } : {}) } } });

it('shows each step with who and when', async () => {
  versions = [{ ...V1, status: 'superseded', filedBy: 'u-owner', filedAt: '2026-09-03T10:00:00Z', filedReference: 'REF-1',
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
  versions = [V1];
  bar('owner'); await ready();
  expect(button(/^Mark filed$/)).toBeTruthy();
  expect(button(/^Amend$/)).toBeTruthy();
  cleanup();

  bar('manager'); await ready();
  expect(button(/^Mark filed$/)).toBeNull();
  expect(button(/^Amend$/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/Only an owner or admin/);
  cleanup();

  versions = [];
  bar('manager'); await ready();
  expect(button(/^Finalise v1$/)).toBeTruthy();
  cleanup();

  bar('viewer'); await ready();
  expect(button(/^Finalise/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/read-only/);
});

it('under Login-as no action is offered, amend included', async () => {
  document.cookie = 'is_impersonating=1; path=/';
  versions = [V1];
  bar('owner'); await ready();
  expect(button(/^Amend$/)).toBeNull();
  expect(button(/^Mark filed$/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/logged in as another user/);
});

it('amend needs a reason: blank or spaces keep it disabled; the reason is posted', async () => {
  versions = [V1];
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
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({ url: '/api/accounting/sars/returns/vat201/amend', body: { versionId: V1.id, reason: 'Missed a supplier bill' } });
});

it('a server refusal of amend (Login-as without the cookie) is shown in its own words', async () => {
  versions = [V1];
  postReplies = [refusal(403, 'This action cannot be taken while impersonating another user. End the impersonation and act as yourself.',
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
  versions = [V1];
  postReplies = [
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
  versions = [V1];
  postReplies = [refusal(400, 'Blocking VAT exceptions are outstanding for this period.', { counts: { totalExceptions: 2, uncodedGlLineCount: 2 } })];
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
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]!.body).toEqual({ versionId: V1.id, reference: 'REF-9', overrideReason: 'Accountant confirmed' });
});

it('LEGACY_SUBMISSION_EXISTS: the earlier filings of the period are named back with a reason', async () => {
  versions = [V1];
  submissions = [
    { id: 'legacy-a', status: 'submitted', periodStart: '2026-07-01', periodEnd: '2026-08-31' },
    { id: 'legacy-b', status: 'accepted', periodStart: '2026-07-01', periodEnd: '2026-08-31' },
    { id: 'draft-x', status: 'draft', periodStart: '2026-07-01', periodEnd: '2026-08-31' },
    { id: 'other-period', status: 'submitted', periodStart: '2026-05-01', periodEnd: '2026-06-30' },
  ];
  postReplies = [refusal(409, 'This period was already filed the legacy way: legacy-a, legacy-b.', { code: 'LEGACY_SUBMISSION_EXISTS' })];
  bar('owner'); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('SARS eFiling reference'), { target: { value: 'REF-9' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  const reason = await within(dialog).findByLabelText(/Reason for superseding 2 earlier filings/);
  expect(within(dialog).getByTestId('return-refusal').textContent).toMatch(/already filed the legacy way/);
  const go = within(dialog).getByRole('button', { name: /^Mark filed$/ }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: 'Correcting the July filing' } });
  fireEvent.click(go);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]!.body).toEqual({
    versionId: V1.id, reference: 'REF-9', correctsLegacySubmissionIds: ['legacy-a', 'legacy-b'], reason: 'Correcting the July filing',
  });
});

it('the badges say a lock was removed outside the lifecycle and that the return drifted', async () => {
  versions = [{ ...V1, lockRemoved: true, drift: { drifted: true, fields: [{ name: 'netVat', recorded: 1200, current: 1300 }], changed: [], unfinalRuns: 0 } }];
  bar('owner'); await ready();
  expect(screen.getByText('VAT period lock removed outside the lifecycle')).toBeTruthy();
  expect(screen.getByText(/Changed since finalised/)).toBeTruthy();
});
