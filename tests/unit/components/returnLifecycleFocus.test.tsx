/**
 * Wave 5 L2: focus in the lifecycle dialogs. The first field (or finalise's action) takes focus on open, focus goes
 * back to the button that opened the dialog on Escape or Cancel, and after a stale refusal it moves to the next step
 * (or the alert). ALREADY_FILED / ALREADY_AMENDED reload the bar as LIVE_VERSION_EXISTS does. Modal's default stays.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { Modal } from '@/components/ui/Modal';
import { P, V1, button, h, installReturnApi, ready, refusal } from './helpers/returnLifecycleHarness';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

beforeEach(() => installReturnApi(apiFetch));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const bar = (role = 'owner') => render(<ReturnLifecycleBar form="VAT201" {...P} role={role} />);
const FILED = { ...V1, status: 'filed', filedBy: 'u-owner', filedAt: '2026-09-03T10:00:00Z', filedReference: 'R-1' };
const focused = () => document.activeElement;

it('amend: the reason takes focus; Escape gives it back to Amend', async () => {
  h.versions = [V1];
  bar(); await ready();
  const trigger = button(/^Amend$/)!;
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(focused()).toBe(within(dialog).getByLabelText(/Reason for the amendment/)));
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(focused()).toBe(button(/^Amend$/)));
});

it('mark filed: the reference takes focus; Cancel gives it back to Mark filed', async () => {
  h.versions = [V1];
  bar(); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(focused()).toBe(within(dialog).getByLabelText('SARS eFiling reference')));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(focused()).toBe(button(/^Mark filed$/)));
});

it('finalise: its action takes focus, not the close button', async () => {
  bar(); await ready();
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(focused()).toBe(within(dialog).getByRole('button', { name: /^Finalise$/ })));
});

it('a stale finalise moves focus to Amend instead once the bar has reloaded', async () => {
  h.postReplies = [refusal(409, 'This VAT201 is already finalised as version 1. Amend it before finalising again.', { code: 'LIVE_VERSION_EXISTS' })];
  bar(); await ready();
  h.versions = [V1];
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(focused()).toBe(within(dialog).getByRole('button', { name: 'Amend instead' })));
});

it('a stale finalise seen by a manager moves focus to the refusal', async () => {
  h.postReplies = [refusal(409, 'This VAT201 is already finalised as version 1. Amend it before finalising again.', { code: 'LIVE_VERSION_EXISTS' })];
  bar('manager'); await ready();
  h.versions = [V1];
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Finalised (v1), not filed'));
  await waitFor(() => expect(focused()).toBe(within(dialog).getByTestId('return-refusal')));
});

it('ALREADY_FILED: the bar reloads to Filed and the dialog offers Amend instead or Close', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(409, 'Version 1 is already filed (R-1). Amend it to file a correction.', { code: 'ALREADY_FILED' })];
  bar(); await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('SARS eFiling reference'), { target: { value: 'R-2' } });
  h.versions = [FILED]; // filed in another tab
  fireEvent.click(within(dialog).getByRole('button', { name: /^Mark filed$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Filed (v1)'));
  expect(within(dialog).getByRole('button', { name: 'Close', exact: true })).toBeTruthy();
  await waitFor(() => expect(focused()).toBe(within(dialog).getByRole('button', { name: 'Amend instead' })));
});

it('ALREADY_AMENDED: the bar reloads; no Amend instead; focus on the refusal', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(409, 'Version 1 was already amended.', { code: 'ALREADY_AMENDED' })];
  bar(); await ready();
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason for the amendment/), { target: { value: 'x' } });
  h.versions = [{ ...V1, status: 'superseded', amendedBy: 'u-owner', amendedAt: '2026-09-04T10:00:00Z', amendReason: 'elsewhere' }];
  fireEvent.click(within(dialog).getByRole('button', { name: /^Amend$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Amended: finalise v2'));
  expect(within(dialog).queryByRole('button', { name: 'Amend instead' })).toBeNull();
  await waitFor(() => expect(focused()).toBe(within(dialog).getByTestId('return-refusal')));
});

it('a Modal without initialFocusRef still focuses its first control (the default is unchanged)', async () => {
  render(<Modal open onClose={() => undefined} title="Plain"><Modal.Body><input aria-label="field" /></Modal.Body></Modal>);
  await waitFor(() => expect(focused()).toBe(screen.getByRole('button', { name: 'Close modal' })));
});

it('ALREADY_AMENDED with a newer version live elsewhere still offers no "Amend instead" from an amend dialog', async () => {
  h.versions = [V1];
  h.postReplies = [refusal(409, 'Version 1 was already amended.', { code: 'ALREADY_AMENDED' })];
  bar(); await ready();
  fireEvent.click(button(/^Amend$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/Reason for the amendment/), { target: { value: 'x' } });
  h.versions = [{ ...V1, status: 'superseded', amendedBy: 'u-owner', amendedAt: '2026-09-04T10:00:00Z', amendReason: 'elsewhere' },
    { ...V1, id: 'v2', versionNo: 2, amendsVersionId: V1.id }];
  fireEvent.click(within(dialog).getByRole('button', { name: /^Amend$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Finalised (v2), not filed'));
  expect(within(dialog).queryByRole('button', { name: 'Amend instead' })).toBeNull();
});
