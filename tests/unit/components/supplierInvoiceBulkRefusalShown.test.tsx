// A bulk action that refuses some bills must leave the reason on screen. The
// list page's reload (onComplete) clears the page error as its first act, so a
// failure message set before the reload was wiped the moment it appeared.
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { BulkActionBar, withoutClosingStop } from '@/components/accounting/supplier-invoices/BulkActionBar';

const REASON = 'Supplier invoice SIV-1 is allocated on draft payment SP-1. Remove it from that payment first.';

/** The page's contract: the reload clears the error, as loadInvoices does. */
function Page({ onReload, reloadFails = false }: { onReload: () => void; reloadFails?: boolean }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'approve' | 'post_gl' | 'cancel' | null>(null);
  return (
    <>
      <p role="alert">{error}</p>
      <BulkActionBar
        selected={new Set(['b1'])}
        busy={busy}
        onBusyChange={setBusy}
        onError={setError}
        onComplete={async () => {
          onReload();
          // loadInvoices clears the error, then sets its own when the fetch fails.
          setError(reloadFails ? 'Failed to load supplier invoices' : '');
        }}
        onClear={() => {}}
      />
    </>
  );
}

afterEach(() => { vi.mocked(apiFetch).mockReset(); vi.unstubAllGlobals(); });

describe('BulkActionBar — a partly refused bulk action', () => {
  it('shows the refusal after the list reloads', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      total: 1, succeeded: 0, failed: 1, results: [{ invoiceId: 'b1', ok: false, error: REASON }],
    } }), { status: 200 }));
    const onReload = vi.fn();

    render(<Page onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(`1 of 1 cancels failed: ${REASON}`)).toBeTruthy();
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('keeps the reload failure beside the refusal', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      total: 1, succeeded: 0, failed: 1, results: [{ invoiceId: 'b1', ok: false, error: REASON }],
    } }), { status: 200 }));

    render(<Page onReload={vi.fn()} reloadFails />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(`Failed to load supplier invoices — 1 of 1 cancels failed: ${REASON}`)).toBeTruthy();
  });

  it('joins several reasons into one sentence: no ".;", one closing full stop', async () => {
    vi.stubGlobal('confirm', () => true);
    const other = 'Supplier invoice SIV-2 is already cancelled.';
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      total: 3, succeeded: 0, failed: 3, results: [
        { invoiceId: 'b1', ok: false, error: REASON },
        { invoiceId: 'b2', ok: false, error: REASON },
        { invoiceId: 'b3', ok: false, error: other },
      ],
    } }), { status: 200 }));

    render(<Page onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText(
      `3 of 3 cancels failed: 2× ${REASON.slice(0, -1)}; 1× ${other.slice(0, -1)}.`,
    )).toBeTruthy();
  });

  it('groups a reason with and without its full stop, and joins the no-reason fallback', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      total: 3, succeeded: 0, failed: 3, results: [
        { invoiceId: 'b1', ok: false, error: 'Bill is locked.' },
        { invoiceId: 'b2', ok: false, error: 'Bill is locked' },
        { invoiceId: 'b3', ok: false, error: '   ' },
      ],
    } }), { status: 200 }));

    render(<Page onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByText('3 of 3 cancels failed: 2× Bill is locked; 1× no reason was given.')).toBeTruthy();
  });
});

describe('withoutClosingStop', () => {
  it.each([
    ['Bill is locked.', 'Bill is locked'],
    ['Bill is locked', 'Bill is locked'],
    ['Bill is locked .', 'Bill is locked'],
    ['Still loading...', 'Still loading...'],
    ['...', '...'],
    ['.', '.'],
  ])('%j -> %j', (input, expected) => {
    expect(withoutClosingStop(input)).toBe(expected);
  });
});
