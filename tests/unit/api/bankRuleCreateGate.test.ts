/**
 * #1656 round 6 (security hook, HIGH): the create route's gate fired only on `autoCreateEntry === true`. With company auto-post ON every active rule posts
 * money (bank_rule_posts_money, 877), so a non-approver could create one without the flag. createRule now runs autoPostApprovalGuard under the rule lock with
 * the database's own predicate; the auto-apply on create still needs Banking Approve (skipped, the rule saved, without it). Real createRule / writeNewRule over a
 * scripted sql.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
const stmts = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({ autoPostOn: false }));
vi.mock('@/lib/neon', () => ({
  withSavepoint: (_n: string, fn: () => unknown) => fn(),
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    stmts.push(text);
    if (/bank_rule_posts_money/.test(text)) {
      const json = values.filter((v): v is string => typeof v === 'string' && v.startsWith('{')).map((v) => JSON.parse(v) as Record<string, unknown>);
      const after = json[json.length - 1]!;
      const posts = (after.auto_create_entry === true || state.autoPostOn) && after.is_active === true;
      return [{ after, posts_money: posts, held: false, toggle_only: false }];
    }
    if (/FROM suppliers WHERE/.test(text)) return [{ '?column?': 1 }];
    if (/^\s*INSERT INTO bank_categorisation_rules/.test(text)) {
      return [{ id: 'r1', rule_name: 'Fuel', match_field: 'description', match_type: 'contains', match_pattern: 'ENGEN', priority: 100, is_active: true, auto_create_entry: false, vat_code: 'none', auto_apply: 'fifo' }];
    }
    return [];
  }),
}));
vi.mock('@/modules/accounting/services/bank/bankRuleAutoPostLock', () => ({ lockForRuleWrite: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({ accountsBelongToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', async (orig) => ({ ...(await orig<object>()), supplierBelongsToCompany: vi.fn(async () => true), customerBelongsToCompany: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/bank/bankRulesMatchingService', () => ({ applyRules: vi.fn(async () => ({ applied: 2 })) }));
vi.mock('@/modules/accounting/services/core/approvePermission', async (orig) => ({ ...(await orig<object>()), mayApprove: vi.fn(async () => false) }));

import { mayApprove } from '@/modules/accounting/services/core/approvePermission';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import handler from '../../../pages/api/accounting/bank-rules';

const C = '11111111-1111-4111-8111-111111111111';
const ID = '66666666-6666-4666-8666-666666666666';
const BODY = { ruleName: 'Fuel', matchField: 'description', matchType: 'contains', matchPattern: 'ENGEN', supplierId: ID };
function create(extra: Record<string, unknown> = {}) {
  const req = { method: 'POST', query: {}, body: { ...BODY, ...extra }, companyId: C, user: { id: 'u-1' } } as unknown as NextApiRequest;
  const res = { statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; } };
  return Promise.resolve(handler(req, res as unknown as NextApiResponse)).then(() => res);
}
const inserted = () => stmts.some((t) => /^\s*INSERT INTO bank_categorisation_rules/.test(t));
beforeEach(() => { vi.clearAllMocks(); stmts.length = 0; state.autoPostOn = false; vi.mocked(mayApprove).mockResolvedValue(false); });

describe('POST /api/accounting/bank-rules without Banking Approve', () => {
  it('company auto-post ON, no autoCreateEntry in the body: the rule would post, so the create is refused 403 and nothing is inserted', async () => {
    state.autoPostOn = true;
    const res = await create();
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    expect(inserted()).toBe(false);
  });

  it('company auto-post OFF and no flag: a suggest-only rule is created (it posts nothing)', async () => {
    const res = await create();
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(200);
    expect(inserted()).toBe(true);
  });

  it('an explicit autoCreateEntry is refused as before', async () => {
    expect((await create({ autoCreateEntry: true })).statusCode).toBe(403);
    expect(inserted()).toBe(false);
  });

  it('the auto-apply on create is skipped without Banking Approve (the rule is saved, applied: 0), and runs with it', async () => {
    const saved = await create({ bankAccountId: ID });
    expect(saved.statusCode).toBe(200);
    expect(applyRules).not.toHaveBeenCalled();
    expect((saved.sent as { data: { applied: number } }).data.applied).toBe(0);
    vi.mocked(mayApprove).mockResolvedValue(true);
    state.autoPostOn = true;
    const res = await create({ bankAccountId: ID });
    expect(res.statusCode).toBe(200);
    expect(applyRules).toHaveBeenCalledOnce();
  });
});
