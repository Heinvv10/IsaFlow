// A draft pack can be rebuilt from the list; the confirmation says what is lost.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import ManagementPacks from '../../../pages/accounting/afs/management-packs';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const posts: Array<Record<string, unknown>> = [];
const doc = (period: string, status: string) => ({ id: period, period, status, created_at: '2026-11-06', updated_at: '2026-11-06' });

function serve(config: Record<string, unknown>) {
  posts.length = 0;
  vi.mocked(apiFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return json({ result: {} }); }
    if (url.includes('management-pack-config')) {
      return json({ config: { enabled: false, generationDay: 5, deliveryDay: 10, sectionsEnabled: {}, packStyle: 'detailed', comparisonMode: 'budget', currencyDisplay: 'full', ...config } });
    }
    return json({ documents: [doc('2026-11', 'draft'), doc('2026-10', 'signed_off'), { ...doc('2026-09', 'draft'), locked_at: '2026-11-01' }] });
  });
}
async function openHistory() {
  render(<ManagementPacks />);
  fireEvent.click(await screen.findByRole('button', { name: 'Pack History' }));
}
afterEach(() => { vi.mocked(apiFetch).mockReset(); vi.unstubAllGlobals(); });

describe('Regenerate on the management pack list', () => {
  it('is offered on an unlocked draft only, and asks to replace that month\'s draft', async () => {
    serve({ reviewRequired: true, recipients: [] });
    const ask = vi.fn(() => true);
    vi.stubGlobal('confirm', ask);
    await openHistory();
    const buttons = await screen.findAllByRole('button', { name: 'Regenerate' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(posts).toEqual([{ period: '2026-11', replaceDraft: true }]));
    expect(String((ask.mock.calls as unknown as string[][])[0]?.[0])).toContain('any edits');
    expect(String((ask.mock.calls as unknown as string[][])[0]?.[0])).toContain('charged');
  });

  it('sends nothing when the person declines', async () => {
    serve({ reviewRequired: true, recipients: [] });
    vi.stubGlobal('confirm', () => false);
    await openHistory();
    fireEvent.click(await screen.findByRole('button', { name: 'Regenerate' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toEqual([]);
  });


});
