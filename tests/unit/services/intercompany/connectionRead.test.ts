/**
 * Intercompany P1 reads: the tenant predicates are in the SQL itself (RLS would mask the loss of one in an integration
 * run), the row mapping is exact, and the pick-lists are cut and flagged at their limit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/headerSql', () => ({ isHeaderSql: () => 'HEADER_SQL' }));

import { sql } from '@/lib/neon';
import { listConnections, listGroupCandidates } from '@/modules/accounting/services/intercompany/connectionRead';
import { listSideOptions } from '@/modules/accounting/services/intercompany/connectionOptions';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const mockSql = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;
let seen: Array<{ text: string; values: unknown[] }>;

function answer(...rowsPerCall: unknown[][]) {
  let i = 0;
  mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    seen.push({ text: strings.join('?').replace(/\s+/g, ' ').trim(), values });
    return Promise.resolve(rowsPerCall[Math.min(i++, rowsPerCall.length - 1)] ?? []);
  }) as never);
}
beforeEach(() => { seen = []; mockSql.mockReset(); });

describe('listConnections', () => {
  it('scopes the connection, the OWN side, and every name lookup to the session company', async () => {
    answer([]);
    await listConnections(A);
    const { text, values } = seen[0]!;
    expect(text).toContain('(c.company_low_id = ?::UUID OR c.company_high_id = ?::UUID)');
    expect(text).toContain('s.company_id = ?::UUID');
    for (const join of ['cu.company_id = ?::UUID', 'su.company_id = ?::UUID', 'la.company_id = ?::UUID', 'ea.company_id = ?::UUID']) expect(text).toContain(join);
    expect(values.filter((v) => v === A).length).toBe(8);
    expect(text).toContain('public.intercompany_user_can_write(c.company_low_id) AND public.intercompany_user_can_write(c.company_high_id)');
  });

  it('narrows to one connection when asked, and maps the pair settings, the side and the checklist', async () => {
    answer([{
      id: 'c1', kind: 'group', status: 'active', invited_by_company_id: A, created_at: new Date('2026-11-17T10:00:00Z'), revoked_at: null,
      settlement_mode: 'loan', cutover_date: '2026-12-01', interest_rate_pct: 10.5, can_edit_settings: true,
      partner_company_id: 'p', partner_name: 'Partner', side_id: 's1', customer_id: 'cu', supplier_id: 'su', loan_account_id: 'la',
      default_expense_account_id: null, auto_accept: true, customer_name: 'Cust', supplier_name: 'Supp', loan_code: '2800', loan_name: 'Loan',
      exp_code: null, exp_name: null,
    }]);
    const [view] = await listConnections(A, 'c1');
    expect(seen[0]!.values).toContain('c1');
    expect(view).toMatchObject({
      id: 'c1', kind: 'group', status: 'active', partnerCompanyId: 'p', partnerName: 'Partner', canEditSettings: true,
      settings: { settlementMode: 'loan', cutoverDate: '2026-12-01', interestRatePct: 10.5 },
      side: { customerId: 'cu', supplierId: 'su', loanAccountId: 'la', autoAccept: true, customer: { label: 'Cust' }, loanAccount: { label: '2800 Loan' }, defaultExpenseAccount: null },
      createdAt: '2026-11-17T10:00:00.000Z', revokedAt: null,
    });
    expect(view!.checklist.complete).toBe(true);
  });

  it('a user who cannot write in both companies gets canEditSettings false, and a missing side is null', async () => {
    answer([{ id: 'c1', kind: 'group', status: 'active', invited_by_company_id: A, created_at: '2026-11-17T10:00:00Z', revoked_at: null,
      settlement_mode: 'cash', cutover_date: null, interest_rate_pct: null, can_edit_settings: false, partner_company_id: 'p', partner_name: null, side_id: null }]);
    const [view] = await listConnections(A);
    expect(view).toMatchObject({ canEditSettings: false, side: null, partnerName: 'Another company', settings: { settlementMode: 'cash', cutoverDate: null, interestRatePct: null } });
    expect(view!.checklist.complete).toBe(false);
  });
});

describe('listGroupCandidates', () => {
  it('asks for current members only, on both sides, with the user\'s write roles in the other company', async () => {
    answer([]);
    await listGroupCandidates('user-1', A);
    const { text, values } = seen[0]!;
    expect(text).toContain('me.company_id = ?::UUID AND me.left_date IS NULL');
    expect(text).toContain('other.left_date IS NULL');
    expect(text).toContain('cu.company_id = other.company_id AND cu.user_id = ?');
    expect(text).toContain('cu.role = ANY(?::TEXT[])');
    expect(values).toEqual(expect.arrayContaining([A, 'user-1', ['owner', 'admin', 'manager']]));
    expect(text).toContain("CASE WHEN ic.status IS NULL THEN 2 WHEN ic.status = 'revoked' THEN 1 ELSE 0 END");
  });

  it('maps and sorts by company name', async () => {
    answer([
      { company_id: 'z', company_name: 'Zeta', group_name: 'G', connection_status: null },
      { company_id: 'a', company_name: 'Alpha', group_name: 'G', connection_status: 'revoked' },
    ]);
    expect(await listGroupCandidates('u', A)).toEqual([
      { companyId: 'a', companyName: 'Alpha', groupName: 'G', connectionStatus: 'revoked' },
      { companyId: 'z', companyName: 'Zeta', groupName: 'G', connectionStatus: null },
    ]);
  });
});

describe('listSideOptions', () => {
  it('reads the session company\'s own non-deleted customers and suppliers and active non-header accounts', async () => {
    answer([], [], []);
    await listSideOptions(A);
    expect(seen).toHaveLength(3);
    const [customers, suppliers, accounts] = seen;
    for (const q of seen) expect(q!.values).toContain(A);
    expect(customers!.text).toMatch(/FROM customers WHERE company_id = \?::UUID AND deleted_at IS NULL/);
    expect(suppliers!.text).toMatch(/FROM suppliers WHERE company_id = \?::UUID AND deleted_at IS NULL/);
    expect(accounts!.text).toMatch(/FROM gl_accounts ga WHERE ga\.company_id = \?::UUID AND ga\.is_active = true AND NOT \?/);
    expect(accounts!.values).toContain('HEADER_SQL');
  });

  it('cuts a list at its limit and says so; a list within it is whole', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `c${i}`, label: `Customer ${i}` }));
    answer(many, [{ id: 's', label: 'Supplier' }], [{ id: 'a', label: 'Account' }]);
    const r = await listSideOptions(A);
    expect(r.customers).toHaveLength(5000);
    expect(r.truncated).toBe(true);
    expect(r.suppliers).toEqual([{ id: 's', label: 'Supplier' }]);
    answer([], [], []);
    expect((await listSideOptions(A)).truncated).toBe(false);
  });
});
