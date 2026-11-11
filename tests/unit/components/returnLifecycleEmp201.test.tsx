/** Wave 5 L2: the lifecycle bar on the EMP201: its route slug, its dialog copy and its figures in the drawer. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { button, h, installReturnApi, ready } from './helpers/returnLifecycleHarness';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

beforeEach(() => installReturnApi(apiFetch));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const M = { periodStart: '2026-10-01', periodEnd: '2026-10-31' };
const E1 = {
  id: '33333333-3333-4333-8333-333333333333', formType: 'EMP201', ...M, versionNo: 1, status: 'finalised',
  figures: { employeeCount: 3, totalTaxableRemuneration: 60000, totalPAYE: 9000, totalETI: 1500, payePayable: 7500,
    totalUIF: 1200, totalSDL: 600, runs: [], directiveTotals: { count: 0, gross: 0, paye: 0 } },
  postedThrough: '2026-10-28', vatPeriodLockId: null, sarsSubmissionId: null, filedReference: null, amendsVersionId: null,
  finalisedBy: 'u-owner', finalisedAt: '2026-11-02T10:00:00Z', filedBy: null, filedAt: null,
  amendedBy: null, amendReason: null, amendedAt: null,
  drift: { drifted: false, fields: [], changed: [], unfinalRuns: 0 }, lockRemoved: false,
};
const bar = () => render(<ReturnLifecycleBar form="EMP201" {...M} role="owner" />);

it('finalise posts to the emp201 route with the period, and says every pay run must be approved', async () => {
  bar(); await ready();
  await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).startsWith('/api/accounting/sars/returns/emp201/versions?'))).toBe(true));
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toMatch(/Finalise EMP201 v1/);
  expect(dialog.textContent).toMatch(/Every pay run it sums must be approved\./);
  expect(dialog.textContent).not.toMatch(/VAT period/);
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(h.posts).toHaveLength(1));
  expect(h.posts[0]).toEqual({ url: '/api/accounting/sars/returns/emp201/finalise', body: M });
});

it('amend on an EMP201 says nothing about a VAT lock and posts to the emp201 route', async () => {
  h.versions = [E1];
  bar(); await ready();
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  expect(dialog.textContent).toMatch(/Version 1 becomes superseded\. Then finalise version 2 and file it\./);
  fireEvent.change(within(dialog).getByLabelText(/Reason for the amendment/), { target: { value: 'A late overtime claim' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Amend$/ }));
  await waitFor(() => expect(h.posts).toHaveLength(1));
  expect(h.posts[0]).toEqual({ url: '/api/accounting/sars/returns/emp201/amend', body: { versionId: E1.id, reason: 'A late overtime claim' } });
});

it('the drawer shows the EMP201 liability lines, not VAT boxes', async () => {
  h.versions = [E1];
  bar(); await ready();
  fireEvent.click(button(/^Versions \(1\)$/)!);
  const v = await screen.findByRole('article', { name: 'Version 1' });
  const row = (label: RegExp) => within(v).getByRole('row', { name: label }).textContent ?? '';
  expect(row(/^Employees/)).toMatch(/3$/);
  expect(row(/^PAYE payable/)).toMatch(/7[\s,]?500\.00/);
  expect(row(/^ETI/)).toMatch(/1[\s,]?500\.00/);
  expect(row(/^SDL/)).toMatch(/600\.00/);
  expect(within(v).queryByRole('row', { name: /Output tax/ })).toBeNull();
});
