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

import { sql } from '@/lib/neon';
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

function writeStatements(): string[] {
  return sqlTexts.filter((t) => /\b(INSERT|UPDATE|DELETE)\b/i.test(t));
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
  {
    name: 'createRule',
    run: () => createRule(COMPANY, {
      ruleName: 'Rule', matchField: 'description', matchType: 'contains', matchPattern: 'X', clientId: FOREIGN,
    } as never, USER),
  },
  { name: 'updateRule', run: () => updateRule(COMPANY, ROW, { clientId: FOREIGN }) },
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

  it('does not query customers when no customer id is supplied', async () => {
    await updateRule(COMPANY, ROW, { ruleName: 'Renamed' }).catch(() => undefined);
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
