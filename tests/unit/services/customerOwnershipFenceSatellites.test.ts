/**
 * R-067 round 3 — the service arms found by walking the SCHEMA rather than a
 * chosen list of AR tables: every one stored a caller-supplied customer id with
 * no tenant read on the path.
 *
 * Same contract as customerOwnershipFence.test.ts: a foreign id is refused and
 * nothing that changes data ran first (`withAuth` COMMITs a 4xx returned after
 * a write; `createDeliveryNote` burns a document number as its first write).
 * The own-tenant direction is asserted by letting the ownership read return a
 * row and checking execution reached the next statement.
 *
 * The route-level arms (inline SQL in the handler) are pinned end to end in
 * tests/integration/customer-ownership-fence-routes.int.test.ts.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

const sqlTexts: string[] = [];

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray) => {
      sqlTexts.push(strings.join('?'));
      return Promise.resolve([]);
    }),
    { transaction: vi.fn(async () => []), unsafe: vi.fn((s: string) => s) },
  );
  return {
    sql: sqlMock,
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => Promise.resolve().then(fn)),
    withTransaction: vi.fn((cb: (tx: unknown) => unknown) => cb(sqlMock)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The bank-rule arms now run inside the controls kernel, which asserts the
// caller's live permissions against the database. Authority is covered by the
// controls suites; here it must not stand between the call and the fence.
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn() }));

import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { withControlRequest } from '@/modules/accounting/services/controls/context';
import { CustomerNotInCompanyError } from '@/modules/accounting/services/core/contactDirectoryService';
import { createWriteOff } from '@/modules/accounting/services/ar/writeOffService';
import { createDeliveryNote } from '@/modules/accounting/services/ar/deliveryNoteService';
import { createRule, updateRule } from '@/modules/accounting/services/bank/bankRulesService';
import { setOverride } from '@/modules/accounting/services/ar/dunningOverridesService';
import { createTimeEntry, updateTimeEntry } from '@/modules/accounting/services/core/timeTrackingService';
import { createAdjustment } from '@/modules/accounting/services/items/adjustmentService';

const mockSql = sql as unknown as MockedFunction<(...a: unknown[]) => Promise<unknown[]>>;

const COMPANY = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '99999999-9999-4999-8999-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';
const ROW = '55555555-5555-4555-8555-555555555555';

/**
 * A statement that changes data. Matched on the write verb WITH its object —
 * a bare `UPDATE` also matches the `FOR UPDATE` row lock the controls kernel
 * takes on its way to the fence, which reads nothing and writes nothing.
 */
function writeStatements(): string[] {
  return sqlTexts.filter((t) => /\b(INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+[a-z_][a-z0-9_]*\s+SET)\b/i.test(t));
}

/** Paths whose ownership read is the FIRST statement. */
const CASES: { name: string; run: () => Promise<unknown> }[] = [
  {
    name: 'createWriteOff',
    run: () => createWriteOff(COMPANY, { clientId: FOREIGN, invoiceId: ROW, amount: 10, reason: 'Bad debt' }, USER),
  },
  {
    name: 'createDeliveryNote',
    run: () => createDeliveryNote(COMPANY, {
      customer_id: FOREIGN, lines: [{ description: 'Item', quantity: 1 }],
    } as never, USER),
  },
  { name: 'setOverride', run: () => setOverride(COMPANY, FOREIGN, { suppress_dunning: true }) },
  {
    name: 'createTimeEntry',
    run: () => createTimeEntry(COMPANY, { taskDescription: 'Work', hours: 1, customerId: FOREIGN } as never, USER),
  },
  {
    name: 'createAdjustment (customer)',
    run: () => createAdjustment(COMPANY, {
      entityType: 'customer', entityId: FOREIGN, adjustmentType: 'debit', amount: 50, reason: 'Fence',
    }, USER),
  },
];

describe('R-067 r3 — a foreign customer id is refused before the first write', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    mockSql.mockClear();
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      return Promise.resolve([]);
    });
  });

  it.each(CASES)('$name refuses and writes nothing', async ({ run }) => {
    await expect(run()).rejects.toBeInstanceOf(CustomerNotInCompanyError);
    expect(sqlTexts).toHaveLength(1);
    expect(sqlTexts[0]).toContain('FROM customers');
    expect(writeStatements()).toEqual([]);
  });

  it.each(CASES)('$name proceeds past the fence for an own-tenant customer', async ({ run }) => {
    let call = 0;
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      return Promise.resolve(call++ === 0 ? [{ ok: 1 }] : []);
    });
    await run().catch(() => undefined);
    expect(sqlTexts.length).toBeGreaterThan(1);
  });

  it('does not read customers for a supplier adjustment (that arm is R-068)', async () => {
    await createAdjustment(COMPANY, {
      entityType: 'supplier', entityId: FOREIGN, adjustmentType: 'debit', amount: 50, reason: 'Fence',
    }, USER).catch(() => undefined);
    expect(sqlTexts.some((t) => t.includes('FROM customers'))).toBe(false);
  });

});

/**
 * `createRule` / `updateRule` moved behind `withBankRuleChange`, so they refuse
 * outright without an authenticated control transaction — which would make any
 * fence assertion against a bare call vacuous (it would pass whether or not the
 * fence existed). Each case below therefore enters through a real control
 * request, and the fence they reach is `assertOwnedRuleReferences`, which reads
 * `customers` for the caller-supplied client id and refuses a foreign one. That
 * refusal is a plain `Error`, not `CustomerNotInCompanyError` — the guarantee
 * being pinned is the refusal and the absence of any write before it.
 */
describe('R-067 r3 — the bank-rule arms fence inside the controls kernel', () => {
  const client = { query: async () => ({ rows: [], command: 'SELECT' }) } as unknown as PoolClient;
  const inControlTx = <T>(work: () => Promise<T>): Promise<T> => withControlRequest(
    { client, userId: USER, companyId: COMPANY, claims: { sub: USER } },
    { personId: USER, companyId: COMPANY, authMethod: 'cookie' },
    work,
  );
  const RULE_ROW = { id: ROW, company_id: COMPANY, rule_name: 'Rule', gl_account_id: null, supplier_id: null, client_id: null };

  beforeEach(() => {
    sqlTexts.length = 0;
    mockSql.mockClear();
  });

  /** `rows` answers each statement in turn; anything past the end answers empty. */
  function respond(rows: unknown[][]): void {
    let call = 0;
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      return Promise.resolve(rows[call++] ?? []);
    });
  }

  it('createRule refuses a foreign customer and writes nothing', async () => {
    respond([]);
    await expect(inControlTx(() => createRule(COMPANY, {
      ruleName: 'Rule', matchField: 'description', matchType: 'contains', matchPattern: 'X', clientId: FOREIGN,
    } as never, USER))).rejects.toThrow(/not found in company/i);
    expect(sqlTexts).toHaveLength(1);
    expect(sqlTexts[0]).toContain('FROM customers');
    expect(writeStatements()).toEqual([]);
  });

  it('createRule proceeds past the fence for an own-tenant customer', async () => {
    respond([[{ id: FOREIGN }]]);
    await inControlTx(() => createRule(COMPANY, {
      ruleName: 'Rule', matchField: 'description', matchType: 'contains', matchPattern: 'X', clientId: FOREIGN,
    } as never, USER)).catch(() => undefined);
    expect(sqlTexts.length).toBeGreaterThan(1);
  });

  it('updateRule refuses a foreign customer after its own row lock and writes nothing', async () => {
    // (1) the rule row `withBankRuleChange` locks, (2) the ownership read.
    respond([[RULE_ROW]]);
    await expect(inControlTx(() => updateRule(COMPANY, ROW, { clientId: FOREIGN })))
      .rejects.toThrow(/not found in company/i);
    expect(sqlTexts).toHaveLength(2);
    expect(sqlTexts[1]).toContain('FROM customers');
    expect(writeStatements()).toEqual([]);
  });

  it('updateRule proceeds past the fence for an own-tenant customer', async () => {
    respond([[RULE_ROW], [{ id: FOREIGN }]]);
    await inControlTx(() => updateRule(COMPANY, ROW, { clientId: FOREIGN })).catch(() => undefined);
    expect(sqlTexts.length).toBeGreaterThan(2);
  });

  it('does not query customers when no customer id is supplied', async () => {
    respond([[RULE_ROW]]);
    await inControlTx(() => updateRule(COMPANY, ROW, { ruleName: 'Renamed' })).catch(() => undefined);
    expect(sqlTexts.length).toBeGreaterThan(0);
    expect(sqlTexts.some((t) => t.includes('FROM customers'))).toBe(false);
  });
});

describe('R-067 r3 — updateTimeEntry fences the id after its draft check', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    mockSql.mockClear();
  });

  it('refuses a foreign customer on a draft entry and writes nothing', async () => {
    let call = 0;
    mockSql.mockImplementation((strings: unknown) => {
      sqlTexts.push((strings as TemplateStringsArray).join('?'));
      return Promise.resolve(call++ === 0 ? [{ status: 'draft' }] : []);
    });
    await expect(updateTimeEntry(COMPANY, ROW, { customerId: FOREIGN }))
      .rejects.toBeInstanceOf(CustomerNotInCompanyError);
    expect(writeStatements()).toEqual([]);
    expect(sqlTexts[sqlTexts.length - 1]).toContain('FROM customers');
  });
});
