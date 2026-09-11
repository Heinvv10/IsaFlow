/**
 * A delivery skips a stored recipient that is not {email, role, receives} and the route reports
 * it (skippedRecipients). The page said nothing, so the operator believed everyone was sent to.
 * After a delivery the page names each recipient it did not send to — and says nothing when
 * every recipient was sent to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/management-packs/ManagementPackConfigTab', () => ({ ManagementPackConfigTab: () => null }));
import ManagementPacksPage from '../../../pages/accounting/afs/management-packs';

const SKIPPED = 'recipients[0] is not an object {email, role, receives}';
const envelope = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });

function serve(skippedRecipients: string[]) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return envelope({ delivered: true, skippedRecipients });
    if (url.includes('management-pack-config')) return envelope({ config: null });
    return envelope({ documents: [{ id: 'p1', period: '2026-06', status: 'draft', created_at: '2026-09-11T00:00:00Z',
      updated_at: '2026-09-11T00:00:00Z', delivery_withheld_reason: null }] });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function deliver() {
  render(<ManagementPacksPage />);
  fireEvent.click(await screen.findByRole('button', { name: /Pack History/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Deliver/i }));
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('after delivering a management pack', () => {
  it('names each recipient the delivery did not send to', async () => {
    const fetch = serve([SKIPPED]);
    await deliver();
    expect(await screen.findByText(`Not sent to: ${SKIPPED}`), 'a skipped recipient was never shown to the operator').toBeInTheDocument();
    // Still there after the list reloads.
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/management-packs')).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(`Not sent to: ${SKIPPED}`)).toBeInTheDocument();
  });

  it('says nothing about skipped recipients when every recipient was sent to', async () => {
    const fetch = serve([]);
    await deliver();
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(true));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/management-packs')).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(/Not sent to/)).not.toBeInTheDocument();
  });
});
