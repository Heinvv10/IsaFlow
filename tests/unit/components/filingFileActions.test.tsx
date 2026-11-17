/**
 * Wave 6 EFa: the filing file on the lifecycle bar. Before the file is generated Mark filed is not offered and the bar
 * says what to do; a download posts the version and format, then the bar reloads and offers Mark filed. A refusal is
 * shown with the server's words; a viewer and a Login-as session get no download.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ReturnLifecycleBar } from '@/components/accounting/sars/returns/ReturnLifecycleBar';
import { button, h, installReturnApi, P, ready, refusal, V1 } from './helpers/returnLifecycleHarness';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch }));

const UNSTAMPED = { ...V1, filingFileSha256: null, filingFileKind: null, filingFileAt: null, filingFileBy: null };
beforeEach(() => {
  installReturnApi(apiFetch);
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  // happy-dom would follow the download link and leave the window on blob:x, where cookies no longer work.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const bar = (role = 'owner') => render(<ReturnLifecycleBar form="VAT201" {...P} role={role} />);
const versionLoads = () => apiFetch.mock.calls.filter(([u]) => String(u).includes('/versions?')).length;

it('before the file is generated: no Mark filed, the next step is named, CSV and JSON are offered', async () => {
  h.versions = [UNSTAMPED];
  bar();
  await ready();
  expect(button(/^Mark filed$/)).toBeNull();
  expect(screen.getByTestId('filing-file-status').textContent).toMatch(/Download the filing file, capture it on SARS eFiling/);
  expect(button(/^Filing file \(CSV\)$/)).not.toBeNull();
  expect(button(/^Filing file \(JSON\)$/)).not.toBeNull();
});

it('a download posts the version and format to the filing-file route, then reloads the return', async () => {
  h.versions = [UNSTAMPED];
  bar();
  await ready();
  const before = versionLoads();
  h.versions = [V1]; // the reload sees the stamp
  fireEvent.click(button(/^Filing file \(CSV\)$/)!);
  await waitFor(() => expect(button(/^Mark filed$/)).not.toBeNull());
  expect(h.posts).toEqual([{ url: '/api/accounting/sars/returns/vat201/filing-file', body: { versionId: V1.id, format: 'csv' } }]);
  expect(versionLoads()).toBe(before + 1);
  expect(screen.getByTestId('filing-file-status').textContent).toContain(`sha256 ${'a'.repeat(64)}`);
});

it('a refusal shows the server\'s message and changes nothing on the bar', async () => {
  h.versions = [UNSTAMPED];
  h.postReplies = [refusal(409, 'Version 1 was superseded by an amend.')];
  bar();
  await ready();
  fireEvent.click(button(/^Filing file \(JSON\)$/)!);
  expect(await screen.findByRole('alert')).toHaveTextContent('Version 1 was superseded by an amend.');
  expect(button(/^Mark filed$/)).toBeNull();
});

it('a viewer is offered no download', async () => {
  h.versions = [UNSTAMPED];
  bar('viewer');
  await ready();
  expect(screen.queryByTestId('filing-file')).toBeNull();
});

it('a Login-as session is offered no download', async () => {
  document.cookie = 'is_impersonating=1; path=/';
  h.versions = [UNSTAMPED];
  bar('owner');
  await ready();
  expect(screen.getByTestId('return-lifecycle-note').textContent).toMatch(/logged in as another user/);
  expect(screen.queryByTestId('filing-file')).toBeNull();
});
