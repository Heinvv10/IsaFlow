/**
 * Intercompany P1 service: a refusal is thrown BEFORE anything is written, and the ordered pair is what is stored.
 * The database is faked by query text; the real rules run against PostgreSQL in tests/integration/intercompany/.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: vi.fn(async (_n: string, cb: () => unknown) => cb()) }));
vi.mock('@/modules/accounting/services/core/companyAccessService', () => ({ userCanWriteCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customerBelongsToCompany: vi.fn(), supplierBelongsToCompany: vi.fn(),
}));
vi.mock('@/modules/accounting/services/budgets/headerSql', () => ({ isHeaderSql: () => 'HEADER_SQL' }));

import { sql } from '@/lib/neon';
import { userCanWriteCompany } from '@/modules/accounting/services/core/companyAccessService';
import { customerBelongsToCompany, supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { createGroupConnection, revokeConnection, updateConnectionSettings, updateOwnSide } from '@/modules/accounting/services/intercompany/connectionService';
import { ConnectionRefusal } from '@/modules/accounting/services/intercompany/connectionTypes';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CID = 'cccccccc-0000-4000-8000-000000000003';

type Handler = (text: string, values: unknown[]) => unknown[] | undefined;
const mockSql = vi.mocked(sql) as unknown as ReturnType<typeof vi.fn>;
let statements: string[];

/** Fake the database: the first handler to answer a statement's text wins; anything unanswered is an empty result. */
function fakeDb(...handlers: Array<[RegExp, unknown[] | Handler]>) {
  mockSql.mockImplementation(((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    statements.push(text);
    for (const [re, answer] of handlers) if (re.test(text)) return Promise.resolve(typeof answer === 'function' ? answer(text, values) ?? [] : answer);
    return Promise.resolve([]);
  }) as never);
}
const writes = () => statements.filter((t) => /^(INSERT|UPDATE|DELETE)/i.test(t));

beforeEach(() => {
  statements = [];
  mockSql.mockReset();
  vi.mocked(userCanWriteCompany).mockReset().mockResolvedValue(true);
  vi.mocked(customerBelongsToCompany).mockReset().mockResolvedValue(true);
  vi.mocked(supplierBelongsToCompany).mockReset().mockResolvedValue(true);
});

const VIEW = (over: Record<string, unknown> = {}) => ({
  id: 'new-id', kind: 'group', status: 'active', partner_company_id: A, partner_name: 'A', invited_by_company_id: B,
  created_at: new Date('2026-11-17T10:00:00Z'), revoked_at: null, side_id: null, settlement_mode: 'cash', cutover_date: null,
  interest_rate_pct: null, can_edit_settings: true, ...over,
});
const IN_GROUP: [RegExp, unknown[]] = [/intercompany_in_one_group/, [{ ok: true }]];

describe('createGroupConnection', () => {
  it('refuses connecting a company to itself, with no query', async () => {
    await expect(createGroupConnection('u', A, A)).rejects.toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('refuses (403) without a write role in BOTH companies, and writes nothing', async () => {
    vi.mocked(userCanWriteCompany).mockImplementation(async (_u, company) => company === A);
    fakeDb();
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 403 });
    vi.mocked(userCanWriteCompany).mockImplementation(async (_u, company) => company === B);
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 403 });
    expect(writes()).toEqual([]);
  });

  it('refuses (400) companies that are not in one group (the definer helper says so), and writes nothing', async () => {
    fakeDb([/intercompany_in_one_group/, [{ ok: false }]]);
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/same company group/) });
    expect(writes()).toEqual([]);
  });

  it('asks the helper with the two companies, not the caller\'s own view of group membership', async () => {
    const seen: unknown[][] = [];
    fakeDb([/intercompany_in_one_group/, (_t, v) => { seen.push(v); return [{ ok: false }]; }]);
    await createGroupConnection('u', B, A).catch(() => undefined);
    expect(seen).toEqual([[B, A]]);
    expect(statements.some((t) => /FROM company_group_members/.test(t))).toBe(false);
  });

  it('stores the ORDERED pair whichever company asks', async () => {
    const created: unknown[][] = [];
    fakeDb(
      IN_GROUP,
      [/^INSERT INTO intercompany_connections/, (_t, v) => { created.push(v); return [{ id: 'new-id' }]; }],
      [/FROM intercompany_connections c/, [VIEW()]],
    );
    await createGroupConnection('u', B, A);
    expect(created[0]!.slice(0, 2)).toEqual([A, B]); // A < B as text: low = A
    await createGroupConnection('u', A, B);
    expect(created[1]!.slice(0, 2)).toEqual([A, B]);
  });

  it('re-activates a revoked GROUP connection by one UPDATE ... WHERE status = revoked, and inserts nothing', async () => {
    fakeDb(
      IN_GROUP,
      [/^UPDATE intercompany_connections/, [{ id: 'old-id' }]],
      [/FROM intercompany_connections c/, [VIEW({ id: 'old-id' })]],
    );
    const view = await createGroupConnection('u', A, B);
    expect(view.id).toBe('old-id');
    const update = statements.find((t) => t.startsWith('UPDATE intercompany_connections'))!;
    expect(update).toContain("kind = 'group'");
    expect(update).toContain("status = 'revoked'");
    expect(writes().filter((t) => t.startsWith('INSERT'))).toEqual([]);
  });

  it('a pair that already exists live is a 409 (the INSERT conflicts and returns no row); nothing else is written', async () => {
    fakeDb(IN_GROUP, [/^UPDATE intercompany_connections/, []], [/^INSERT INTO intercompany_connections/, []]);
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 409 });
    const insert = statements.find((t) => t.startsWith('INSERT INTO intercompany_connections'))!;
    expect(insert).toContain("ON CONFLICT (company_low_id, company_high_id) WHERE status <> 'revoked' DO NOTHING");
  });

  it('a connection that vanishes between the write and the read is a 404, not a crash', async () => {
    fakeDb(IN_GROUP, [/^INSERT INTO intercompany_connections/, [{ id: 'new-id' }]]);
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 404 });
  });
});

describe('updateOwnSide', () => {
  const connection = (kind: 'group' | 'external', status = 'active') => [VIEW({ id: CID, kind, status, partner_company_id: B, partner_name: 'B', invited_by_company_id: A })];

  it('refuses auto-accept on an external connection (400) before any write', async () => {
    fakeDb([/FROM intercompany_connections c/, connection('external')]);
    const err = await updateOwnSide(A, CID, { autoAccept: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionRefusal);
    expect(err).toMatchObject({ status: 400 });
    expect(writes()).toEqual([]);
  });

  it('refuses a customer that is not this company\'s before any write', async () => {
    vi.mocked(customerBelongsToCompany).mockResolvedValue(false);
    fakeDb([/FROM intercompany_connections c/, connection('group')]);
    await expect(updateOwnSide(A, CID, { customerId: CID })).rejects.toMatchObject({ status: 400 });
    expect(customerBelongsToCompany).toHaveBeenCalledWith(A, CID);
    expect(writes()).toEqual([]);
  });

  it('refuses a supplier that is not this company\'s before any write', async () => {
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(false);
    fakeDb([/FROM intercompany_connections c/, connection('group')]);
    await expect(updateOwnSide(A, CID, { supplierId: CID })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/supplier/) });
    expect(writes()).toEqual([]);
  });

  it('refuses a loan or default expense account that is not an active postable account of this company', async () => {
    fakeDb([/FROM intercompany_connections c/, connection('group')], [/FROM gl_accounts ga/, []]);
    await expect(updateOwnSide(A, CID, { loanAccountId: CID })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/loan account/) });
    await expect(updateOwnSide(A, CID, { defaultExpenseAccountId: CID })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/expense account/) });
    expect(writes()).toEqual([]);
  });

  it('a connection that is not this company\'s is a 404 and a revoked one a 409, with no write', async () => {
    fakeDb([/FROM intercompany_connections c/, []]);
    await expect(updateOwnSide(A, CID, { autoAccept: false })).rejects.toMatchObject({ status: 404 });
    fakeDb([/FROM intercompany_connections c/, connection('group', 'revoked')]);
    await expect(updateOwnSide(A, CID, { autoAccept: false })).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });

  it('writes the merged side: a key left out keeps its stored value, null clears; the pair settings are not in it', async () => {
    const written: unknown[][] = [];
    fakeDb(
      [/FROM intercompany_connections c/, [{ ...connection('group')[0], side_id: 's', customer_id: CID, supplier_id: B, loan_account_id: null, default_expense_account_id: null, auto_accept: true }]],
      [/^INSERT INTO intercompany_connection_sides/, (_t, v) => { written.push(v); return []; }],
    );
    await updateOwnSide(A, CID, { supplierId: null });
    // connection, company, partner, customer, supplier, loan, expense, auto-accept
    expect(written[0]).toEqual([CID, A, B, CID, null, null, null, true]);
    expect(statements.find((t) => t.startsWith('INSERT INTO intercompany_connection_sides'))).not.toMatch(/settlement_mode|cutover_date|interest_rate_pct/);
  });

  it('a customer or supplier already linked on another connection is a 409; any other database error is rethrown', async () => {
    const dup = (constraint: string) => Object.assign(new Error('duplicate key'), { code: '23505', constraint });
    for (const [constraint, word] of [['intercompany_sides_customer_uq', /customer/], ['intercompany_sides_supplier_uq', /supplier/]] as const) {
      mockSql.mockReset();
      statements = [];
      mockSql.mockImplementation(((strings: TemplateStringsArray) => {
        const text = strings.join('?').replace(/\s+/g, ' ').trim();
        if (/FROM intercompany_connections c/.test(text)) return Promise.resolve(connection('group'));
        if (/^INSERT INTO intercompany_connection_sides/.test(text)) return Promise.reject(dup(constraint));
        return Promise.resolve([]);
      }) as never);
      await expect(updateOwnSide(A, CID, { autoAccept: false })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(word) });
    }
    mockSql.mockImplementation(((strings: TemplateStringsArray) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      if (/FROM intercompany_connections c/.test(text)) return Promise.resolve(connection('group'));
      if (/^INSERT INTO intercompany_connection_sides/.test(text)) return Promise.reject(Object.assign(new Error('boom'), { code: '23505', constraint: 'something_else' }));
      return Promise.resolve([]);
    }) as never);
    await expect(updateOwnSide(A, CID, { autoAccept: false })).rejects.toThrow('boom');
  });
});

describe('updateConnectionSettings', () => {
  const view = (over: Record<string, unknown> = {}) => [VIEW({ id: CID, kind: 'group', partner_company_id: B, partner_name: 'B', invited_by_company_id: A, ...over })];

  it('refuses without a write role in BOTH companies (403), before any write', async () => {
    fakeDb([/FROM intercompany_connections c/, view()]);
    vi.mocked(userCanWriteCompany).mockImplementation(async (_u, company) => company === A);
    await expect(updateConnectionSettings('u', A, CID, { settlementMode: 'loan' })).rejects.toMatchObject({ status: 403 });
    vi.mocked(userCanWriteCompany).mockImplementation(async (_u, company) => company === B);
    await expect(updateConnectionSettings('u', A, CID, { settlementMode: 'loan' })).rejects.toMatchObject({ status: 403 });
    expect(writes()).toEqual([]);
  });

  it('is a 404 when it is not this company\'s, a 409 when revoked, a 400 when external; no write', async () => {
    fakeDb([/FROM intercompany_connections c/, []]);
    await expect(updateConnectionSettings('u', A, CID, { cutoverDate: null })).rejects.toMatchObject({ status: 404 });
    fakeDb([/FROM intercompany_connections c/, view({ status: 'revoked' })]);
    await expect(updateConnectionSettings('u', A, CID, { cutoverDate: null })).rejects.toMatchObject({ status: 409 });
    fakeDb([/FROM intercompany_connections c/, view({ kind: 'external' })]);
    await expect(updateConnectionSettings('u', A, CID, { cutoverDate: null })).rejects.toMatchObject({ status: 400 });
    expect(writes()).toEqual([]);
  });

  it('writes the merged settings: a key left out keeps its stored value, null clears', async () => {
    const written: unknown[][] = [];
    fakeDb(
      [/FROM intercompany_connections c/, view({ settlement_mode: 'loan', cutover_date: '2026-12-01', interest_rate_pct: 12 })],
      [/^UPDATE intercompany_connections/, (_t, v) => { written.push(v); return [{ id: CID }]; }],
    );
    await updateConnectionSettings('u', A, CID, { interestRatePct: null });
    expect(written[0]).toEqual(['loan', '2026-12-01', null, CID]);
    await updateConnectionSettings('u', A, CID, { settlementMode: 'cash', cutoverDate: null });
    expect(written[1]).toEqual(['cash', null, 12, CID]);
  });

  it('a connection revoked between the read and the write is a 409', async () => {
    fakeDb([/FROM intercompany_connections c/, view()], [/^UPDATE intercompany_connections/, []]);
    await expect(updateConnectionSettings('u', A, CID, { cutoverDate: null })).rejects.toMatchObject({ status: 409 });
  });
});

describe('revokeConnection', () => {
  it("its UPDATE names the session company on both sides of the pair (RLS would mask the loss of this predicate)", async () => {
    const updates: Array<[string, unknown[]]> = [];
    fakeDb(
      [/^UPDATE intercompany_connections/, (t, v) => { updates.push([t, v]); return [{ id: CID }]; }],
      [/FROM intercompany_connections c/, [VIEW({ id: CID, status: 'revoked', revoked_at: new Date() })]],
    );
    await revokeConnection(A, CID);
    expect(updates).toHaveLength(1);
    expect(updates[0]![0]).toMatch(/company_low_id = \?::UUID OR company_high_id = \?::UUID/);
    expect(updates[0]![1]).toEqual([CID, A, A]);
  });

  it('an unknown or foreign connection is a 404, an already revoked one a 409', async () => {
    fakeDb();
    await expect(revokeConnection(A, CID)).rejects.toMatchObject({ status: 404 });
    fakeDb([/FROM intercompany_connections c/, [VIEW({ id: CID, status: 'revoked', revoked_at: new Date() })]]);
    await expect(revokeConnection(A, CID)).rejects.toMatchObject({ status: 409 });
  });
});
