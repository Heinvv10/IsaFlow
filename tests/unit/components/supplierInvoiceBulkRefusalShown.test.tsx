// A bulk action that refuses some bills must leave the reason on screen. The
// list page's reload (onComplete) clears the page error as its first act, so a
// failure message set before the reload was wiped the moment it appeared.
import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

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
});
