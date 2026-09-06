/**
 * ShareLinkDialog — create/list/revoke against the real `{ success, data }`
 * envelope over a stubbed `fetch`. The list never carries a URL; the create
 * response does, exactly once. `apiJson` resolves on 4xx and throws only via
 * `assertOk` — a component that forgot to route the response through it would
 * swallow the server's message and show nothing, which is the regression this
 * mutates for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ShareLinkDialog } from '@/components/accounting/share/ShareLinkDialog';
import type { ShareLinkRow } from '@/modules/accounting/services/share/shareLinkService';

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorEnvelope(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LINK: ShareLinkRow = {
  id: 'link-1',
  reportKind: 'pack',
  params: { type: 'board', from: '2026-08-01', to: '2026-08-31' },
  label: 'Board pack Aug',
  expiresAt: '2026-10-01T00:00:00.000Z',
  revokedAt: null,
  createdBy: 'user-1',
  createdAt: '2026-09-01T00:00:00.000Z',
  viewCount: 2,
  lastViewedAt: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // happy-dom defines `navigator.clipboard` as a getter-only accessor, so a
  // plain assignment throws — redefine the property instead.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { type: 'board' as const, from: '2026-08-01', to: '2026-08-31' };

describe('ShareLinkDialog', () => {
  it('lists links without ever showing a URL', async () => {
    fetchMock.mockResolvedValue(envelope({ links: [LINK] }));
    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('Board pack Aug')).toBeTruthy());

    expect(screen.queryByRole('textbox', { name: '' })).toBeNull();
    expect(screen.queryByDisplayValue(/^https?:\/\//)).toBeNull();
  });

  it('shows the URL exactly once on create, with the one-time sentence', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ links: [] })) // initial load
      .mockResolvedValueOnce(envelope({ // create
        link: LINK, token: 'raw-token', url: 'https://app.isaflow.co.za/share/raw-token',
      }))
      .mockResolvedValueOnce(envelope({ links: [LINK] })); // refresh after create

    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.getByDisplayValue('https://app.isaflow.co.za/share/raw-token')).toBeTruthy());
    expect(screen.getByText('This link is shown once. Copy it now — it cannot be shown again.')).toBeTruthy();
  });

  it('surfaces the server message when create is rejected, rather than swallowing it', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ links: [] }))
      .mockResolvedValueOnce(errorEnvelope(409, 'This company already has 100 live share links.'));

    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(screen.getByText('This company already has 100 live share links.')).toBeTruthy());
    expect(screen.queryByDisplayValue(/^https?:\/\//)).toBeNull();
  });

  it('says the list response was wrong rather than showing "no share links yet"', async () => {
    // A 200 carrying the wrong arm of the route's union. Falling back to []
    // rendered the empty state, which is indistinguishable from a company that
    // has never shared anything — so the owner is told the pack is private and
    // invited to mint a second link for one that is already out.
    fetchMock.mockResolvedValue(envelope({ somethingElse: true }));
    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText('The share links response did not contain a list of links.')).toBeTruthy());
    expect(screen.queryByText('No share links yet.')).toBeNull();
  });

  it('says so when create succeeds without returning the URL, instead of doing nothing', async () => {
    // The raw token is returned once and never again. Silently ignoring the
    // wrong arm left a live link minted against the company's cap whose URL
    // nobody could ever recover, with the button simply appearing to do
    // nothing.
    fetchMock
      .mockResolvedValueOnce(envelope({ links: [] }))
      .mockResolvedValueOnce(envelope({ link: LINK }));

    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(screen.getByText(
      'The link was created but its URL was not returned. Revoke it and try again.')).toBeTruthy());
    expect(screen.queryByDisplayValue(/^https?:\/\//)).toBeNull();
  });

  it('revokes a link and re-fetches the list', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ links: [LINK] }))
      .mockResolvedValueOnce(envelope({ revoked: true }))
      .mockResolvedValueOnce(envelope({ links: [{ ...LINK, revokedAt: '2026-09-06T00:00:00.000Z' }] }));

    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.getByText(/Revoked/)).toBeTruthy());

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(String(url)).toBe('/api/accounting/share/links/link-1/revoke');
    expect((init as RequestInit).method).toBe('POST');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clamps an emptied or out-of-range Days field to a valid value', async () => {
    fetchMock.mockResolvedValue(envelope({ links: [] }));
    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    const days = screen.getByLabelText('Days') as HTMLInputElement;

    fireEvent.change(days, { target: { value: '' } });
    expect(Number(days.value)).toBeGreaterThanOrEqual(1);
    expect(Number(days.value)).toBeLessThanOrEqual(90);

    fireEvent.change(days, { target: { value: '500' } });
    expect(Number(days.value)).toBe(90);
  });

  it('clears the shown-once URL panel when a second create fails', async () => {
    fetchMock
      .mockResolvedValueOnce(envelope({ links: [] })) // initial load
      .mockResolvedValueOnce(envelope({ // first create succeeds
        link: LINK, token: 'raw-token', url: 'https://app.isaflow.co.za/share/raw-token',
      }))
      .mockResolvedValueOnce(envelope({ links: [LINK] })) // refresh after first create
      .mockResolvedValueOnce(errorEnvelope(400, 'bad params')); // second create fails

    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.getByDisplayValue('https://app.isaflow.co.za/share/raw-token')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(screen.getByText('bad params')).toBeTruthy());
    expect(screen.queryByDisplayValue(/^https?:\/\//)).toBeNull();
  });

  it('takes focus when it opens, and announces itself as modal', async () => {
    fetchMock.mockResolvedValue(envelope({ links: [] }));
    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    const dialog = screen.getByRole('dialog', { name: 'Share links' });
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('closes on a REAL Escape pressed where focus actually is', async () => {
    // The regression: the listener sat on a <div> nothing ever focused, so a
    // person who clicked Share and pressed Escape got nothing, while a test
    // that dispatched keydown on the container passed. No element is named
    // here on purpose.
    fetchMock.mockResolvedValue(envelope({ links: [] }));
    const onClose = vi.fn();
    render(<ShareLinkDialog params={PARAMS} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape from a control inside it, and ignores other keys', async () => {
    fetchMock.mockResolvedValue(envelope({ links: [] }));
    const onClose = vi.fn();
    render(<ShareLinkDialog params={PARAMS} onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    (screen.getByLabelText('Days') as HTMLInputElement).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab inside the dialog instead of letting it reach the page behind', async () => {
    const behind = document.createElement('button');
    behind.textContent = 'behind the dialog';
    document.body.appendChild(behind);

    fetchMock.mockResolvedValue(envelope({ links: [] }));
    render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());

    const dialog = screen.getByRole('dialog', { name: 'Share links' });
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled])'));
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;

    last.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    expect(document.activeElement).not.toBe(behind);

    behind.remove();
  });

  it('returns focus to the button that opened it when it closes', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Share';
    document.body.appendChild(opener);
    opener.focus();

    fetchMock.mockResolvedValue(envelope({ links: [] }));
    const { unmount } = render(<ShareLinkDialog params={PARAMS} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('No share links yet.')).toBeTruthy());
    expect(document.activeElement).not.toBe(opener);

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});