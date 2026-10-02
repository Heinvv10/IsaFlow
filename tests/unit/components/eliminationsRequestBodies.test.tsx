/**
 * D4 round 6: the eliminations page sends the fields consolidated-reports reads. It sent
 * `type` / `period` / `group_account_code` (create), `period_start` / `period_end`
 * (auto-eliminate) and `elimination_id` (post / reverse), so every button got a 400.
 * Lines carry the group account ID — the reports look eliminations up by id — resolved
 * from the code the person typed; an unknown code is refused on the page.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import EliminationsPage from '@/../pages/accounting/group/eliminations';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const GROUP = '80000000-0000-4000-8000-000000000001';
const DRAFT = '70000000-0000-4000-8000-000000000001';
const POSTED = '70000000-0000-4000-8000-000000000002';
const ACCOUNTS = [{ id: 'a4000-id', accountCode: 'G4000' }, { id: 'a5000-id', accountCode: 'G5000' }];

function serve(postStatus = 200, postBody: unknown = { data: { ok: true } }) {
  const posts: Array<Record<string, unknown>> = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(postBody), { status: postStatus });
    }
    const data = u.includes('action=accounts') ? { items: ACCOUNTS }
      : u.includes('company-groups') ? [{ id: GROUP, name: 'Group' }]
      : { items: [
        // The list API's shape (ConsolidationAdjustment), as round 7 reads it.
        { id: DRAFT, adjustmentNumber: 'E1', adjustmentType: 'interco_revenue', description: 'd', periodStart: '2026-01-31', periodEnd: '2026-01-31', status: 'draft', lines: [] },
        { id: POSTED, adjustmentNumber: 'E2', adjustmentType: 'interco_revenue', description: 'p', periodStart: '2026-01-31', periodEnd: '2026-01-31', status: 'posted', lines: [] },
      ] };
    return new Response(JSON.stringify({ success: true, data }), { status: 200 });
  });
  return posts;
}

describe('eliminations page request bodies', () => {
  it('auto-generate, post and reverse send periodStart / periodEnd and adjustmentId', async () => {
    const posts = serve();
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Post/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /Reverse/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: /Auto-Generate/ }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[0]).toEqual({ action: 'post-elimination', adjustmentId: DRAFT });
    expect(posts[1]).toEqual({ action: 'reverse-elimination', adjustmentId: POSTED });
    expect(posts[2]).toMatchObject({ action: 'auto-eliminate', periodStart: expect.stringMatching(/^\d{4}-01-01$/), periodEnd: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(Object.keys(posts[2]!).sort()).toEqual(['action', 'periodEnd', 'periodStart']);
  });

  async function fillCreate(codes: [string, string]) {
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Manual Elimination/ }));
    fireEvent.change(screen.getByPlaceholderText('Describe the elimination adjustment...'), { target: { value: 'Jan sale' } });
    const [c1, c2] = screen.getAllByPlaceholderText('e.g. 4000');
    fireEvent.change(c1!, { target: { value: codes[0] } });
    fireEvent.change(c2!, { target: { value: codes[1] } });
    const amounts = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(amounts[0]!, { target: { value: '100' } }); // line 1 debit
    fireEvent.change(amounts[3]!, { target: { value: '100' } }); // line 2 credit
    fireEvent.submit(screen.getByRole('button', { name: /Create Elimination/ }).closest('form')!);
  }

  it('create sends adjustmentType, periodStart / periodEnd and lines by group account id', async () => {
    const posts = serve();
    await fillCreate(['G4000', ' G5000 ']);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      action: 'create-elimination', adjustmentType: 'interco_revenue', description: 'Jan sale',
      periodStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), periodEnd: posts[0]!.periodStart,
      lines: [{ groupAccountId: 'a4000-id', debit: 100, credit: 0 }, { groupAccountId: 'a5000-id', debit: 0, credit: 100 }],
    });
  });

  it('refuses an unknown group account code on the page, without posting', async () => {
    const posts = serve();
    await fillCreate(['G4000', 'G9999']);
    expect(await screen.findByText('Not a group account code: G9999')).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('shows the server refusal (a viewer gets the 403 message, not a generic line)', async () => {
    serve(403, { success: false, error: { code: 'FORBIDDEN', message: 'Your role in this group does not allow changing eliminations.' } });
    render(<EliminationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Post/ }));
    expect(await screen.findByText('Your role in this group does not allow changing eliminations.')).toBeTruthy();
  });
});
