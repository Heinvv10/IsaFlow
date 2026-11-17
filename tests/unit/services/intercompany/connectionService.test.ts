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
import { customerBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { createGroupConnection, revokeConnection, updateOwnSide } from '@/modules/accounting/services/intercompany/connectionService';
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
});

describe('createGroupConnection', () => {
  it('refuses connecting a company to itself, with no query', async () => {
    await expect(createGroupConnection('u', A, A)).rejects.toMatchObject({ status: 400 });
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('refuses (403) without a write role in BOTH companies, and writes nothing', async () => {
    vi.mocked(userCanWriteCompany).mockImplementation(async (_u, company) => company === A);
    fakeDb();
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 403 });
    expect(writes()).toEqual([]);
  });

  it('refuses (400) companies that are not in one group, and writes nothing', async () => {
    fakeDb([/FROM company_group_members/, []]);
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/same company group/) });
    expect(writes()).toEqual([]);
  });

  it('stores the ORDERED pair whichever company asks', async () => {
    const created: unknown[][] = [];
    fakeDb(
      [/FROM company_group_members/, [{ '?column?': 1 }]],
      [/^INSERT INTO intercompany_connections/, (_t, v) => { created.push(v); return [{ id: 'new-id' }]; }],
      [/FROM intercompany_connections c/, [{
        id: 'new-id', kind: 'group', status: 'active', partner_company_id: A, partner_name: 'A', invited_by_company_id: B,
        created_at: new Date('2026-11-17T10:00:00Z'), revoked_at: null, side_id: null,
      }]],
    );
    await createGroupConnection('u', B, A);
    expect(created[0]!.slice(0, 2)).toEqual([A, B]); // A < B as text: low = A
    await createGroupConnection('u', A, B);
    expect(created[1]!.slice(0, 2)).toEqual([A, B]);
  });

  it('a pair that already exists live is a 409; none is written', async () => {
    fakeDb([/FROM company_group_members/, [{ x: 1 }]], [/SELECT id, status, kind FROM intercompany_connections/, [{ id: 'x', status: 'active', kind: 'group' }]]);
    await expect(createGroupConnection('u', A, B)).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });
});

describe('updateOwnSide', () => {
  const connection = (kind: 'group' | 'external', status = 'active') => [{
    id: CID, kind, status, partner_company_id: B, partner_name: 'B', invited_by_company_id: A, created_at: new Date(), revoked_at: null, side_id: null,
  }];

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

  it('refuses a loan account that is not an active postable account of this company', async () => {
    fakeDb([/FROM intercompany_connections c/, connection('group')], [/FROM gl_accounts ga/, []]);
    await expect(updateOwnSide(A, CID, { loanAccountId: CID })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/loan account/) });
    expect(writes()).toEqual([]);
  });

  it('a connection that is not this company\'s is a 404 and a revoked one a 409, with no write', async () => {
    fakeDb([/FROM intercompany_connections c/, []]);
    await expect(updateOwnSide(A, CID, { cutoverDate: null })).rejects.toMatchObject({ status: 404 });
    fakeDb([/FROM intercompany_connections c/, connection('group', 'revoked')]);
    await expect(updateOwnSide(A, CID, { cutoverDate: null })).rejects.toMatchObject({ status: 409 });
    expect(writes()).toEqual([]);
  });

  it('writes the merged side: a key left out keeps its stored value, null clears', async () => {
    const written: unknown[][] = [];
    fakeDb(
      [/FROM intercompany_connections c/, [{ ...connection('group')[0], side_id: 's', customer_id: CID, supplier_id: B, settlement_mode: 'loan',
        loan_account_id: null, default_expense_account_id: null, auto_accept: true, cutover_date: '2026-12-01', interest_rate_pct: null }]],
      [/^INSERT INTO intercompany_connection_sides/, (_t, v) => { written.push(v); return []; }],
    );
    await updateOwnSide(A, CID, { supplierId: null });
    // connection, company, partner, customer, supplier, mode, loan, expense, auto-accept, cut-over, interest
    expect(written[0]).toEqual([CID, A, B, CID, null, 'loan', null, null, true, '2026-12-01', null]);
  });
});

describe('revokeConnection', () => {
  it('an unknown or foreign connection is a 404, an already revoked one a 409', async () => {
    fakeDb();
    await expect(revokeConnection(A, CID)).rejects.toMatchObject({ status: 404 });
    fakeDb([/FROM intercompany_connections c/, [{
      id: CID, kind: 'group', status: 'revoked', partner_company_id: B, partner_name: 'B', invited_by_company_id: A,
      created_at: new Date(), revoked_at: new Date(), side_id: null,
    }]]);
    await expect(revokeConnection(A, CID)).rejects.toMatchObject({ status: 409 });
  });
});
