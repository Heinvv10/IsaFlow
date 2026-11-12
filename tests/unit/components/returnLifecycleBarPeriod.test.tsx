/**
 * Wave 5 L2: the lifecycle bar across period changes and failed loads, the step cap, and the versions drawer.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { ReturnVersionsDrawer } from '@/components/accounting/sars/returns/ReturnVersionsDrawer';
import { P, V1, button, h, installReturnApi, ready } from './helpers/returnLifecycleHarness';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

beforeEach(() => installReturnApi(apiFetch));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bar = (role: string | null) => render(<ReturnLifecycleBar form="VAT201" {...P} role={role} />);

it('the drawer lists every version with its figures and amend reason, and flags a released lock on the live one only', async () => {
  const v1 = { ...V1, status: 'superseded', lockRemoved: true, drift: null, amendedBy: 'u-owner', amendedAt: '2026-09-04T10:00:00Z', amendReason: 'Missed a bill' };
  const v2 = { ...V1, id: 'v2', versionNo: 2, lockRemoved: true, figures: { outputTax: 1600, inputTax: 300, netVat: 1300 } };
  render(<ReturnVersionsDrawer open onClose={() => undefined} form="VAT201" versions={[v1, v2] as never} vatReturn={null} nameOf={() => 'Olive Owner'} />);
  const one = screen.getByRole('article', { name: 'Version 1' });
  const two = screen.getByRole('article', { name: 'Version 2' });
  expect(one.textContent).toMatch(/Amended.*Olive Owner.*Missed a bill/);
  expect(one.textContent).not.toMatch(/Lock removed/);
  expect(two.textContent).toMatch(/Lock removed outside the lifecycle/);
  expect(within(two).getByRole('row', { name: /Net VAT/ }).textContent).toMatch(/1[\s,]?300\.00/);
});

it('a new period starts clean: the last period\'s message and steps go, its own versions load', async () => {
  h.byPeriod = { '2026-09-01': [] };
  h.versions = [V1];
  const r = bar('owner'); await ready();
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason for the amendment/), { target: { value: 'x' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Amend$/ }));
  await screen.findByRole('status');
  r.rerender(<ReturnLifecycleBar form="VAT201" periodStart="2026-09-01" periodEnd="2026-10-31" role="owner" />);
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Not finalised'));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('list', { name: 'Lifecycle steps' })).toBeNull();
});

it('a failed load shows no status and no actions; a failed reload keeps the steps it had', async () => {
  h.versionsFail = true;
  bar('owner');
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The versions could not be read.'));
  expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Status unavailable');
  expect(button(/^Finalise/)).toBeNull();
  cleanup();

  h.versionsFail = false; h.versions = [V1];
  bar('owner'); await ready();
  h.versionsFail = true;
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason for the amendment/), { target: { value: 'x' } });
  fireEvent.click(within(dialog).getByRole('button', { name: /^Amend$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Status unavailable'));
  expect(screen.getByRole('list', { name: 'Lifecycle steps' }).textContent).toMatch(/v1 finalised/);
  expect(button(/^Amend$/)).toBeNull();
});

it('the bar shows the newest two versions\' steps and points to Versions for the rest', async () => {
  h.versions = [1, 2, 3, 4].map((no) => ({ ...V1, id: `v${no}`, versionNo: no, status: no === 4 ? 'finalised' : 'superseded',
    ...(no < 4 ? { amendedBy: 'u-owner', amendedAt: '2026-09-04T10:00:00Z', amendReason: `r${no}` } : {}) }));
  bar('owner'); await ready();
  const text = screen.getByRole('list', { name: 'Lifecycle steps' }).textContent ?? '';
  expect(text).toMatch(/v3 finalised/);
  expect(text).toMatch(/v4 finalised/);
  expect(text).not.toMatch(/v2 /);
  expect(screen.getByText('2 earlier versions in Versions.')).toBeTruthy();
});

it('right after a period change nothing of the last period is on screen, not even for one render', async () => {
  h.versions = [V1];
  const r = bar('owner'); await ready();
  expect(button(/^Amend$/)).toBeTruthy();
  h.hold = true; // the new period's versions have not arrived yet
  r.rerender(<ReturnLifecycleBar form="VAT201" periodStart="2026-09-01" periodEnd="2026-10-31" role="owner" />);
  expect(screen.queryByRole('list', { name: 'Lifecycle steps' })).toBeNull();
  expect(button(/^Amend$/)).toBeNull();
  expect(button(/^Versions/)).toBeNull();
  expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Loading…');
  h.byPeriod = { '2026-09-01': [] };
  h.hold = false; h.held.splice(0).forEach((go) => go());
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Not finalised'));
});
