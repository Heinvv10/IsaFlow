/**
 * Forensic-controls step 2 (UI): the Bank rules page lists changes held under
 * the `bank_rule` switch — a pending creation included (no row yet) — with
 * what moves, by name; Approve / Reject only where the server says this viewer
 * may decide; a decision posts the digest shown; a refusal (apiFetch resolves
 * on a 4xx) shows the server's message; a rule with a held change carries a
 * "Pending approval" badge; and a held save reads as held, never as saved.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BankRulesPage from '@/../pages/accounting/bank-reconciliation/rules';
import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const GL_A = '11111111-1111-4111-8111-111111111111';
const GL_B = '22222222-2222-4222-8222-222222222222';
const RULE = '33333333-3333-4333-8333-333333333333';
const rule = { id: RULE, ruleName: 'Fuel', matchField: 'description', matchType: 'contains', matchPattern: 'SHELL', priority: 100,
  isActive: true, autoCreateEntry: true, vatCode: 'none', glAccountId: GL_A, glAccountCode: '6100', glAccountName: 'Fuel' };
const change = (over: Record<string, unknown>) => ({ id: 'c1', ruleId: RULE, ruleName: 'Fuel', kind: 'update', proposerName: 'Ann',
  proposedAt: '2026-10-09T08:00:00Z', digest: 'abc', canDecide: true,
  changes: [{ key: 'gl_account_id', before: GL_A, after: GL_B }], ...over });

let pending: unknown[] = [];
let decide: () => Response = () => json({ success: true, data: { status: 'approved' } });
let save: () => Response = () => json({ success: true, data: { status: 'pending_approval', changeId: 'c9' } });

beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.startsWith('/api/accounting/bank-rule-changes')) return init?.method === 'POST' ? decide() : json({ data: { items: pending } });
    if (path.startsWith('/api/accounting/bank-rules-action')) return save();
    if (path.startsWith('/api/accounting/bank-rules')) return json({ data: { items: [rule] } });
    if (path.includes('accounts')) {
      return json({ data: { items: [{ id: GL_A, accountCode: '6100', accountName: 'Fuel' }, { id: GL_B, accountCode: '6200', accountName: 'Travel' }] } });
    }
    return json({ data: { items: [] } });
  });
});
afterEach(() => { cleanup(); vi.mocked(notify.warning).mockClear(); });

const posts = () => vi.mocked(apiFetch).mock.calls
  .filter(([url, init]) => String(url).startsWith('/api/accounting/bank-rule-changes') && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init?.body)));

it('lists a held change with what moves, and the rule carries a Pending approval badge', async () => {
  pending = [change({}), change({ id: 'c2', ruleId: null, kind: 'create', ruleName: 'New toll rule', canDecide: false,
    changes: [{ key: 'match_pattern', before: null, after: 'TOLL' }] })];
  render(<BankRulesPage />);
  const panel = await screen.findByRole('region', { name: /pending rule changes/i });
  expect(within(panel).getByText('New toll rule')).toBeDefined();
  expect(within(panel).getByText(/waiting for another member/i)).toBeDefined();
  expect(within(panel).getAllByRole('button', { name: /approve/i })).toHaveLength(1);
  expect(await screen.findByText('Pending approval')).toBeDefined();
});

it('Approve posts the change id and the digest shown, with the note', async () => {
  pending = [change({})];
  render(<BankRulesPage />);
  const panel = await screen.findByRole('region', { name: /pending rule changes/i });
  fireEvent.change(within(panel).getByRole('textbox', { name: /note/i }), { target: { value: 'Checked' } });
  fireEvent.click(within(panel).getByRole('button', { name: /approve/i }));
  await waitFor(() => expect(posts()).toEqual([{ action: 'approve', changeId: 'c1', digest: 'abc', note: 'Checked' }]));
});

it("a refused decision shows the server's message", async () => {
  pending = [change({})];
  decide = () => json({ success: false, error: { message: 'The rule changed since it was proposed' } }, 409);
  render(<BankRulesPage />);
  const panel = await screen.findByRole('region', { name: /pending rule changes/i });
  fireEvent.click(within(panel).getByRole('button', { name: /reject/i }));
  await waitFor(() => expect(vi.mocked(notify.error)).toHaveBeenCalledWith(expect.stringMatching(/rule changed since it was proposed/)));
});

it('a held toggle reads as held, not as done', async () => {
  pending = [];
  render(<BankRulesPage />);
  fireEvent.click(await screen.findByRole('button', { name: /disable rule: fuel/i }));
  await waitFor(() => expect(vi.mocked(notify.warning)).toHaveBeenCalledWith(expect.stringMatching(/held for approval/i), expect.any(String)));
  expect(vi.mocked(notify.success)).not.toHaveBeenCalledWith('Rule deactivated');
});
