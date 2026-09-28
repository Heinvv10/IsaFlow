/**
 * R-035 PR2 (UI): the approval-rules tab carries a per-type "Enforce" switch,
 * calling the PR1 enable/disable API, with a preview of how many unposted bills
 * it would hold. A refused switch (disabling above one's rank is a 403) must
 * say why — apiFetch resolves on 4xx — and leave the switch as it was.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ApprovalsPage from '@/../pages/accounting/approvals';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function answer(enforced: boolean, post: () => Response = () => json({ success: true, data: {} })) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST') return post();
    if (path.startsWith('/api/accounting/approval-enforcement')) {
      return json({ data: {
        items: enforced ? [{ documentType: 'supplier_invoice', enabledAt: '2026-09-27T08:00:00Z', enabledBy: 'u' }] : [],
        enforceable: ['supplier_invoice'],
        // The server computes the preview only when asked (review LOW-3).
        ...(path.includes('preview=1') ? { preview: { supplier_invoice: 3 } } : {}),
      } });
    }
    return json({ data: { items: [] } });
  });
}

const enforcementPosts = () => vi.mocked(apiFetch).mock.calls
  .filter(([url, init]) => String(url).startsWith('/api/accounting/approval-enforcement') && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init?.body)));

const enforcementPreviewGets = () => vi.mocked(apiFetch).mock.calls
  .filter(([url, init]) => String(url).startsWith('/api/accounting/approval-enforcement') && String(url).includes('preview=1') && !init?.method)
  .length;

async function openRules() {
  render(<ApprovalsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /rules/i }));
  return screen.findByRole('checkbox', { name: /enforce supplier invoice approvals/i });
}

afterEach(() => { cleanup(); });

it('shows the switch off with the number of unposted bills it would hold', async () => {
  answer(false);
  const toggle = await openRules();
  expect(toggle).not.toBeChecked();
  expect(screen.getByText(/3 unposted bills would need approval/i)).toBeDefined();
});

it('switching it on posts { documentType, enabled: true } and shows it on', async () => {
  answer(false);
  const toggle = await openRules();
  answer(true);
  fireEvent.click(toggle);
  await waitFor(() => expect(enforcementPosts()).toEqual([{ documentType: 'supplier_invoice', enabled: true }]));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /enforce supplier invoice approvals/i })).toBeChecked());
});

it('R-149: switching to the rules tab fetches the preview once, not twice', async () => {
  // The pending tab's own load finishing (setLoading(false)) after the tab
  // switch re-mounts ApprovalEnforcementPanel a second time, firing its
  // mount effect twice for one visit to the tab.
  answer(false);
  await openRules();
  await waitFor(() => expect(enforcementPreviewGets()).toBeGreaterThan(0));
  // Give any second mount's effect a chance to fire before asserting.
  await new Promise((r) => setTimeout(r, 50));
  expect(enforcementPreviewGets()).toBe(1);
});

it('a refused switch shows the reason and stays as it was', async () => {
  answer(true, () => json({ success: false, error: { message: 'Switching supplier_invoice approval enforcement off weakens an active owner-level rule' } }, 403));
  const toggle = await openRules();
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(await screen.findByText(/weakens an active owner-level rule/)).toBeDefined();
  expect(screen.getByRole('checkbox', { name: /enforce supplier invoice approvals/i })).toBeChecked();
});
