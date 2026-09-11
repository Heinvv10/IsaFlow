/**
 * A pack generated with review skipped carries delivery_withheld_reason until a person signs
 * it off, and deliverPack refuses it. The history row showed a plain "Draft" badge and an
 * enabled Deliver button, so the user learned it was withheld only by clicking Deliver. The
 * row must say so up front, with the reason, and Deliver must be disabled while it holds.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/management-packs/ManagementPackConfigTab', () => ({ ManagementPackConfigTab: () => null }));
import ManagementPacksPage from '../../../pages/accounting/afs/management-packs';

const REASON = 'Generated with review skipped: a person must sign this pack off before it is delivered.';
const row = (id: string, period: string, reason: string | null) => ({ id, period, status: 'draft',
  created_at: '2026-09-11T00:00:00Z', updated_at: '2026-09-11T00:00:00Z', delivery_withheld_reason: reason });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('management pack history', () => {
  it('shows a withheld pack as withheld, with its reason, and will not offer to deliver it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const data = url.includes('management-pack-config') ? { config: null }
        : { documents: [row('p-withheld', '2026-06', REASON), row('p-draft', '2026-05', null)] };
      return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    render(<ManagementPacksPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Pack History/i }));

    const withheld = (await screen.findByText('2026-06')).closest('div.rounded-xl') as HTMLElement;
    expect(within(withheld).getByText('Withheld — needs sign-off')).toBeInTheDocument();
    expect(within(withheld).getByText(REASON)).toBeInTheDocument();
    const deliverWithheld = within(withheld).getByRole('button', { name: /Deliver/i });
    expect(deliverWithheld, 'Deliver was offered on a pack deliverPack will refuse').toBeDisabled();
    expect(deliverWithheld).toHaveAttribute('title', REASON);

    const draft = screen.getByText('2026-05').closest('div.rounded-xl') as HTMLElement;
    expect(within(draft).queryByText('Withheld — needs sign-off')).not.toBeInTheDocument();
    expect(within(draft).getByRole('button', { name: /Deliver/i }), 'a deliverable draft lost its Deliver button').toBeEnabled();
  });
});
