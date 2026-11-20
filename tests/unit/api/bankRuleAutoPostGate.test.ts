/**
 * #1656 round 5 (security hook, MEDIUM): editing or re-activating an AUTO-POSTING bank rule needs Banking Approve whether or not the
 * request names auto_create_entry. The old route gate fired only on body.autoCreateEntry === true, so a person without Approve could
 * leave the flag out and re-point an existing auto-posting rule, or switch it back on. The decision is made under the rule lock from the rule
 * as it stands (autoPostApprovalGuard, a RuleWriteGuard), for the app routes and the MCP tools alike. Real bankRulesService and
 * bankRuleChangeControl over a scripted sql; only the rule row and the permission are set per case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/apiJournalDate', () => ({ JOURNAL_DATE_REFUSED: Symbol('r'), withJournalDateRefusal: async (_r: unknown, fn: () => unknown) => fn() }));
const stmts = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({ before: {} as Record<string, unknown> }));
vi.mock('@/lib/neon', () => ({
  withSavepoint: (_n: string, fn: () => unknown) => fn(),
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    stmts.push(text);
    if (/bank_rule_posts_money/.test(text)) {
      const json = values.filter((v): v is string => typeof v === 'string' && v.startsWith('{')).map((v) => JSON.parse(v) as Record<string, unknown>);
      const after = json[json.length - 1]!;
      const { is_active: a1, ...b } = state.before; const { is_active: a2, ...c } = after; void a1; void a2;
      return [{ after, posts_money: false, held: false, toggle_only: JSON.stringify(b) === JSON.stringify(c) }];
    }
    if (/^\s*UPDATE bank_categorisation_rules/.test(text)) return [{ id: 'r1' }];
    if (/FROM bank_categorisation_rules/.test(text)) return [state.before];
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/bank/bankRuleAutoPostLock', () => ({ lockForRuleWrite: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/bank/bankRuleChangeQueries', async (orig) => ({ ...(await orig<object>()), lockRuleProjection: vi.fn(async () => state.before) }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => false) }));

import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import handler from '../../../pages/api/accounting/bank-rules-action';

const C = '11111111-1111-4111-8111-111111111111';
const ID = '66666666-6666-4666-8666-666666666666';
const rule = (over: Record<string, unknown>) => ({
  rule_name: 'Fuel', match_field: 'description', match_type: 'contains', match_pattern: 'ENGEN', gl_account_id: null, supplier_id: 'sup-1',
  client_id: null, description_template: null, priority: 100, auto_create_entry: true, vat_code: 'none', auto_apply: 'fifo', is_active: true, ...over,
});
function call(body: unknown) {
  const req = { method: 'POST', query: {}, body, companyId: C, user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const wrote = () => stmts.some((t) => /^\s*UPDATE bank_categorisation_rules/.test(t));
beforeEach(() => { vi.clearAllMocks(); stmts.length = 0; vi.mocked(mayApprove).mockResolvedValue(false); });

describe('bank-rules-action update, without Banking Approve', () => {
  it('omitting auto_create_entry on an auto-posting rule and changing its match is refused 403, nothing written', async () => {
    state.before = rule({});
    const res = await call({ action: 'update', id: ID, matchPattern: 'SHELL' });
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    expect(wrote()).toBe(false);
    expect(mayApprove).toHaveBeenCalledWith(C, 'u-1', 'banking');
  });

  it.each([['vatCode', { vatCode: 'standard' }], ['autoApply', { autoApply: 'none' }], ['matchType', { matchType: 'exact' }], ['descriptionTemplate', { descriptionTemplate: 'x' }]])(
    'changing %s of an auto-posting rule is refused', async (_k, patch) => {
      state.before = rule({});
      expect((await call({ action: 'update', id: ID, ...patch })).statusCode).toBe(403);
      expect(wrote()).toBe(false);
    });

  it('switching an existing rule TO auto-create is refused', async () => {
    state.before = rule({ auto_create_entry: false });
    expect((await call({ action: 'update', id: ID, autoCreateEntry: true })).statusCode).toBe(403);
    expect(wrote()).toBe(false);
  });

  it('an allowed edit: a rule that does not auto-post changes its match freely', async () => {
    state.before = rule({ auto_create_entry: false });
    const res = await call({ action: 'update', id: ID, matchPattern: 'SHELL', ruleName: 'Fuel 2' });
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(200);
    expect(wrote()).toBe(true);
  });

  it('a priority-only edit of an auto-posting rule moves nothing it posts: allowed', async () => {
    state.before = rule({});
    expect((await call({ action: 'update', id: ID, priority: 50 })).statusCode).toBe(200);
    expect(wrote()).toBe(true);
  });

  it('turning auto-create OFF (and so stopping it posting) is allowed', async () => {
    state.before = rule({});
    expect((await call({ action: 'update', id: ID, autoCreateEntry: false })).statusCode).toBe(200); // after: not auto-posting, so nothing posts
    expect(wrote()).toBe(true);
  });

  it('with Banking Approve the same edit goes through', async () => {
    vi.mocked(mayApprove).mockResolvedValue(true);
    state.before = rule({});
    expect((await call({ action: 'update', id: ID, matchPattern: 'SHELL' })).statusCode).toBe(200);
    expect(wrote()).toBe(true);
  });
});

describe('bank-rules-action toggle, without Banking Approve', () => {
  it('switching an auto-posting rule back ON is refused 403, nothing written', async () => {
    state.before = rule({ is_active: false });
    const res = await call({ action: 'toggle', id: ID, isActive: true });
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    expect(wrote()).toBe(false);
  });

  it('switching it OFF is allowed (stopping a rule posts nothing), and a rule that does not auto-post toggles freely', async () => {
    state.before = rule({});
    expect((await call({ action: 'toggle', id: ID, isActive: false })).statusCode).toBe(200);
    stmts.length = 0;
    state.before = rule({ auto_create_entry: false, is_active: false });
    expect((await call({ action: 'toggle', id: ID, isActive: true })).statusCode).toBe(200);
    expect(wrote()).toBe(true);
  });
});
