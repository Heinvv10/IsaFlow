// Capture inbox detail panel: full-width on phones (it is a fixed 420 px slide-out), close and action controls 44px.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ data: null }), { status: 404 })),
}));

import { CaptureInboxPanel, type CaptureEventRow } from '../../../src/components/accounting/capture/CaptureInboxPanel';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');
const MIN = 'max-lg:min-h-11';

const event = (over: Partial<CaptureEventRow> = {}): CaptureEventRow => ({
  eventId: 'e1', receivedAt: '2026-11-20T08:00:00Z', channel: 'email', sender: 'a@b.co', subject: 'Invoice', status: 'extracted', capturedDocumentId: null, error: null,
  vendorName: 'Acme', documentDate: '2026-11-19', referenceNumber: 'INV-1', totalAmount: 100, documentType: 'invoice', extractedData: null, ...over,
});
const panel = (e: CaptureEventRow) => render(<CaptureInboxPanel event={e} onClose={vi.fn()} onPost={vi.fn(async () => undefined)} onDiscard={vi.fn(async () => undefined)} posting={false} discarding={false} />);

describe('Capture inbox detail panel on touch', () => {
  it('is the full width of a phone, not a fixed 420px', () => {
    const { container } = panel(event());
    const root = container.firstElementChild!;
    expect(cls(root)).toEqual(expect.arrayContaining(['w-[420px]', 'max-lg:w-full']));
  });

  it('the close button has a name and is a 44px square', () => {
    panel(event());
    const close = screen.getByRole('button', { name: 'Close' });
    expect(cls(close)).toEqual(expect.arrayContaining([MIN, 'max-lg:min-w-11', 'max-lg:inline-flex', 'max-lg:items-center', 'max-lg:justify-center']));
  });

  it('Post to review and Discard are 44px', () => {
    panel(event());
    expect(cls(screen.getByRole('button', { name: 'Post to review' }))).toContain(MIN);
    expect(cls(screen.getByRole('button', { name: 'Discard' }))).toContain(MIN);
  });

  it('the auto-publish button (Auto-post) is 44px too', async () => {
    const { apiFetch } = await import('@/lib/apiFetch');
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: { autoPublish: true, autoPublishMaxAmount: null, autoPublishMinConfidence: 0.5, requirePoMatch: false } }), { status: 200 }));
    panel(event({ resolvedSupplierId: 's1' }));
    expect(cls(await screen.findByRole('button', { name: 'Auto-post' }))).toContain(MIN);
  });

  it('the blocked-duplicate button is 44px', () => {
    panel(event({ gateOutcome: 'duplicate_blocked', duplicateHitId: 'INV-9' }));
    expect(cls(screen.getByRole('button', { name: /Blocked/ }))).toContain(MIN);
  });

  it('discard mode: the reason field, Confirm Discard and Cancel are 44px', () => {
    panel(event());
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(cls(screen.getByPlaceholderText('Reason (optional)'))).toContain(MIN);
    for (const name of ['Confirm Discard', 'Cancel']) expect(cls(screen.getByRole('button', { name })), name).toContain(MIN);
  });
});
