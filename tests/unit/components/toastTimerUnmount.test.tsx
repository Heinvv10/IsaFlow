/**
 * The mirror and audit-pack pages dismiss their toast after 3.5 s. That timer must die with the page: left running it
 * fires after unmount (in tests, after the environment is torn down: "window is not defined" from setToast), and a
 * second toast must restart the countdown, not inherit the first one's.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import SentMirrorPage from '../../../pages/accounting/ar/settings/sent-mirror';
import CaptureMirrorPage from '../../../pages/accounting/capture/settings/mirror';
import AuditPacksPage from '../../../pages/accounting/audit-packs/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.useRealTimers(); });

const empty = () => new Response(JSON.stringify({ data: { items: [], exports: [], sessions: [] } }), { status: 200 });
const click = (el: HTMLElement) => fireEvent.click(el);

// [label, page, open the form, press the button that raises the toast]
const pages: Array<[string, () => JSX.Element, string, string, string]> = [
  ['sent-mirror', () => <SentMirrorPage />, 'add imap mailbox', '^connect$', 'all fields are required'],
  ['capture mirror', () => <CaptureMirrorPage />, 'add imap mailbox', '^connect$', 'all fields are required'],
  ['audit-packs', () => <AuditPacksPage />, 'new pack', '^(build|create|generate)', 'pack ready'],
];

describe.each(pages)('%s toast timer', (_name, Page, open, press, text) => {
  async function ready() {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => empty());
    const view = render(<Page />);
    // The audit-pack form closes after a successful build, so open it again when it is closed.
    const raise = async () => {
      const opener = screen.queryByRole('button', { name: new RegExp(open, 'i') });
      if (opener) click(opener);
      click(await screen.findByRole('button', { name: new RegExp(press, 'i') }));
    };
    return { view, raise };
  }
  /** The ids of the 3.5 s dismiss timers the page has started. */
  const toastTimers = (set: { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } }) =>
    set.mock.calls.flatMap((c, i) => (c[1] === 3500 ? [set.mock.results[i]!.value] : []));

  it('is cleared when the page unmounts before it fires', async () => {
    const { view, raise } = await ready();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await raise();
    await screen.findByText(new RegExp(text, 'i'));
    const [id] = toastTimers(set);
    expect(id).toBeDefined();
    view.unmount();
    expect(clear).toHaveBeenCalledWith(id);
    set.mockRestore(); clear.mockRestore();
  });

  it('a second toast cancels the first one\'s timer so it cannot dismiss the new toast early', async () => {
    const { view, raise } = await ready();
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await raise();
    await screen.findByText(new RegExp(text, 'i'));
    await act(async () => { await new Promise<void>((r) => setImmediate(r)); }); // let the first action finish
    await raise();
    await act(async () => { await new Promise<void>((r) => setImmediate(r)); }); // the second toast may follow a fetch
    const ids = toastTimers(set);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(clear).toHaveBeenCalledWith(ids[0]);
    view.unmount();
    set.mockRestore(); clear.mockRestore();
  });
});
