// The shared SARS return lifecycle bar (VAT201 / EMP201 / EMP501): every action button, the filing-file downloads and the action dialog buttons are phone-sized.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { P, V1, button, h, installReturnApi, ready, refusal } from './helpers/returnLifecycleHarness';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

beforeEach(() => installReturnApi(apiFetch));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const cls = (el: Element) => el.className.split(' ');
const min = (el: Element | null, name: string) => { expect(el, name).not.toBeNull(); expect(cls(el!), name).toContain('max-lg:min-h-11'); };

it('Versions, Mark filed, Amend and the filing-file downloads are 44px', async () => {
  h.versions = [V1];
  render(<ReturnLifecycleBar form="VAT201" {...P} role="owner" />);
  await ready();
  min(button(/^Versions \(1\)$/), 'Versions');
  min(button(/^Mark filed$/), 'Mark filed');
  min(button(/^Amend$/), 'Amend');
  const downloads = screen.getAllByRole('button', { name: /^Filing file \(/ });
  expect(downloads.length).toBeGreaterThan(0);
  for (const d of downloads) min(d, d.textContent ?? 'download');
});

it('Finalise is 44px', async () => {
  h.versions = [];
  render(<ReturnLifecycleBar form="VAT201" {...P} role="manager" />);
  await ready();
  min(button(/^Finalise v1$/), 'Finalise');
});

it('the action dialog Cancel and primary buttons are 44px', async () => {
  h.versions = [V1];
  render(<ReturnLifecycleBar form="VAT201" {...P} role="owner" />);
  await ready();
  fireEvent.click(button(/^Mark filed$/)!);
  const dialog = await screen.findByRole('dialog');
  min(within(dialog).getByRole('button', { name: 'Cancel' }), 'Cancel');
  min(within(dialog).getByLabelText('SARS eFiling reference'), 'eFiling reference field'); // the Mark filed dialog's first field
  const primary = within(dialog).getAllByRole('button').find((b) => /file/i.test(b.textContent ?? '') && b.textContent !== 'Cancel');
  min(primary ?? null, 'primary');
});

it('the stale-tab dialog\'s Amend instead and Close buttons are 44px', async () => {
  h.postReplies = [refusal(409, 'This VAT201 is already finalised as version 1. Amend it before finalising again.', { code: 'LIVE_VERSION_EXISTS' })];
  render(<ReturnLifecycleBar form="VAT201" {...P} role="owner" />);
  await ready();
  h.versions = [V1]; // finalised in another tab meanwhile
  fireEvent.click(button(/^Finalise v1$/)!);
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^Finalise$/ }));
  await waitFor(() => expect(screen.getByTestId('return-lifecycle-status').textContent).toBe('Finalised (v1), not filed'));
  min(await within(dialog).findByRole('button', { name: 'Amend instead' }), 'Amend instead');
  min(within(dialog).getByRole('button', { name: 'Close' }), 'Close');
});
