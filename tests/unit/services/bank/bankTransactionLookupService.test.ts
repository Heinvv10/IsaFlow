/**
 * PRD-11 §5 — resolve a bank transaction by the reference printed on the
 * statement, so an agent transcribing a PDF never has to fetch ids first.
 *
 * The reference lives in `bank_transactions.reference`, NOT in
 * `bank_reference`. Production, 2026-08-28: 9,824 rows carry `reference` and
 * ZERO carry `bank_reference` — every statement importer writes the former,
 * and the two feed syncs that write the latter store the provider's external
 * id there. Matching one column meant the MCP pilot's
 * `bank_reference:"20220402-0011"` came back NOT_FOUND for a row that
 * allocated fine by transaction_id.
 *
 * Three properties are pinned here because each of them is invisible to a
 * mocked row mapper and each has already been wrong in production:
 *   - the SQL TEXT (which columns are compared, and with which trim set —
 *     it must match migration 519's expression indexes character for character
 *     or the planner scans the whole company);
 *   - ONE query for a whole batch (bulk allocation resolves up to 500
 *     references while holding row locks);
 *   - PREFERENCE, not union: `reference` wins, `bank_reference` is a fallback.
 */
process.env.TZ = 'Africa/Johannesburg';

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', async () => {
  const actual = await vi.importActual<typeof import('@/lib/neon')>('@/lib/neon');
  return { sql: vi.fn(), fmtDate: actual.fmtDate };
});

import { sql } from '@/lib/neon';
import {
  findBankTransactionsByReference,
  findBankTransactionsByReferences,
} from '@/modules/accounting/services/bank/bankTransactionLookupService';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockSql = sql as unknown as SqlFn;

const COMPANY_ID = 'd27bac33-cdc0-4e58-bf6b-709c1597d41c';
const BANK_ACCOUNT_ID = 'ba-0000-0000-0000-000000000001';

/** A row as the query returns it: labelled with the column that matched. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'btx-1',
    transaction_date: new Date('2026-02-28T22:30:00Z'), // 00:30 SAST on 1 March
    amount: '-1234.56',
    description: 'FNB OB PMT ACME',
    matched_column: 'reference',
    matched_reference: 'REF-001',
    ...over,
  };
}

/** The template text of the nth sql call, with `?` where a binding sat. */
function sqlText(n: number): string {
  return (mockSql.mock.calls[n]![0] as unknown as string[]).join('?').replace(/\s+/g, ' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockResolvedValue([]);
});

describe('findBankTransactionsByReference — SQL', () => {
  it('joins the batch against BOTH columns, trimmed', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    const text = sqlText(0);
    // One arm per column, each a plain equality the expression index can serve,
    // and each labelling the row with the reference THAT arm matched.
    expect(text).toContain("JOIN wanted w ON btrim(bt.reference, E' \\t\\n\\r\\f') = w.ref");
    expect(text).toContain("JOIN wanted w ON btrim(bt.bank_reference, E' \\t\\n\\r\\f') = w.ref");
    // The reference is joined in, never inferred from the row afterwards: a row
    // carrying one reference in `reference` and another in `bank_reference`
    // must appear under BOTH when both are in the batch.
    expect(text).toContain('FROM unnest(?::TEXT[]) AS ref');
    expect(text).toContain('PARTITION BY matched_reference, matched_column');
  });

  it('trims the SAME characters JS trims — not just spaces', async () => {
    // btrim(x) with no second argument strips spaces ONLY, so a stored "REF\r"
    // was unreachable from a caller who typed "REF". The set must ALSO stay
    // identical to migration 519's indexes, or the planner ignores them.
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    const text = sqlText(0);
    for (const m of text.matchAll(/btrim\([a-z_.]+, ([^)]*)\)/g)) {
      expect(m[1]).toBe("E' \\t\\n\\r\\f'");
    }
    // \v is NOT a PostgreSQL escape — E'\v' is a literal 'v' and would trim the
    // letter off every reference ending in one.
    expect(text).not.toContain('\\v');
  });

  it('stays tenant-scoped and bounded per reference', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    const text = sqlText(0);
    expect(text).toContain('bt.company_id = ');
    expect(mockSql.mock.calls[0]!).toContain(COMPANY_ID);
    expect(text).toContain('PARTITION BY matched_reference, matched_column');
    expect(mockSql.mock.calls[0]!).toContain(25);
    expect(text).not.toMatch(/LIKE|ILIKE/i);
  });

  it('narrows by bank_account_id when one is supplied, and by NULL when not', async () => {
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001', BANK_ACCOUNT_ID);
    expect(sqlText(0)).toContain('bt.bank_account_id = ');
    expect(mockSql.mock.calls[0]!).toContain(BANK_ACCOUNT_ID);

    // One query text for both cases — a second copy is how the two branches
    // drift apart — so the "no account" case binds NULL rather than dropping
    // the predicate.
    mockSql.mockClear();
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(sqlText(0)).toContain('IS NULL OR bt.bank_account_id = ');
    expect(mockSql.mock.calls[0]!).toContain(null);
    expect(mockSql.mock.calls[0]!).not.toContain(BANK_ACCOUNT_ID);
  });

  it('returns no rows — and issues no query — for a blank reference', async () => {
    expect(await findBankTransactionsByReference(COMPANY_ID, '   ')).toEqual([]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('trims the supplied reference before matching', async () => {
    await findBankTransactionsByReference(COMPANY_ID, '  REF-001\n');
    expect(mockSql.mock.calls[0]![1]).toEqual(['REF-001']);
  });
});

describe('findBankTransactionsByReferences — one query per batch', () => {
  it('asks ONCE for many references, de-duplicated', async () => {
    await findBankTransactionsByReferences(COMPANY_ID, ['A', 'B', ' A ', 'C', '  ']);
    expect(mockSql).toHaveBeenCalledTimes(1);
    // Blank dropped (it would match every blank-reference row), duplicates
    // collapsed. 500 lines must cost one round trip, not 500 — each one is a
    // full scan's worth of latency while the batch holds row locks.
    expect(mockSql.mock.calls[0]![1]).toEqual(['A', 'B', 'C']);
  });

  it('issues no query at all when every reference is blank', async () => {
    expect(await findBankTransactionsByReferences(COMPANY_ID, ['', '  '])).toEqual(new Map());
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('keys the result by reference and groups every candidate under it', async () => {
    mockSql.mockResolvedValueOnce([
      row({ id: 'a', matched_reference: 'REF-001' }),
      row({ id: 'b', matched_reference: 'REF-001' }),
      row({ id: 'c', matched_reference: 'REF-002' }),
    ]);
    const byRef = await findBankTransactionsByReferences(COMPANY_ID, ['REF-001', 'REF-002']);
    expect(byRef.get('REF-001')!.map((m) => m.id)).toEqual(['a', 'b']);
    expect(byRef.get('REF-002')!.map((m) => m.id)).toEqual(['c']);
    expect(byRef.has('REF-404')).toBe(false);
  });
});

describe('findBankTransactionsByReferences — preference, not union', () => {
  it('lets `reference` win outright when both columns hold the value', async () => {
    // The columns hold different KINDS of value: one printed on a statement,
    // one a feed's opaque external id. A union would let the feed id shadow
    // the reference the agent actually typed — and would report an ambiguity
    // that is really a coincidence.
    mockSql.mockResolvedValueOnce([
      row({ id: 'from-reference', matched_column: 'reference' }),
      row({ id: 'from-feed', matched_column: 'bank_reference' }),
    ]);
    const byRef = await findBankTransactionsByReferences(COMPANY_ID, ['REF-001']);
    expect(byRef.get('REF-001')!.map((m) => m.id)).toEqual(['from-reference']);
  });

  it('falls back to `bank_reference` only when NOTHING matched `reference`', async () => {
    mockSql.mockResolvedValueOnce([
      row({ id: 'from-feed', matched_column: 'bank_reference' }),
    ]);
    const byRef = await findBankTransactionsByReferences(COMPANY_ID, ['REF-001']);
    expect(byRef.get('REF-001')).toEqual([expect.objectContaining({
      id: 'from-feed', matchedColumn: 'bank_reference',
    })]);
  });
});

describe('findBankTransactionsByReference — mapping', () => {
  it('renders the candidate date in local terms, not UTC', async () => {
    mockSql.mockResolvedValueOnce([row()]);
    const res = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(res).toEqual([{
      id: 'btx-1',
      transactionDate: '2026-03-01',
      amount: -1234.56,
      description: 'FNB OB PMT ACME',
      matchedReference: 'REF-001',
      matchedColumn: 'reference',
    }]);
  });

  it('returns every candidate when the reference repeats', async () => {
    mockSql.mockResolvedValueOnce([row(), row({ id: 'btx-2' })]);
    const res = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(res.map((r) => r.id)).toEqual(['btx-1', 'btx-2']);
  });

  it('tolerates a NULL description', async () => {
    mockSql.mockResolvedValueOnce([row({ description: null })]);
    const [match] = await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    expect(match!.description).toBeNull();
  });
});

describe('trim expression vs migration 519', () => {
  it('uses the SAME expression the expression indexes were built with', async () => {
    // Not a style check. An expression index only serves an expression that
    // matches CHARACTER FOR CHARACTER; change the trim set on one side and the
    // planner silently goes back to scanning every row in the company — the
    // 9,132-rows-removed plan this pair of indexes was added to kill. The
    // expected value is read from the QUERY, so the two move together or the
    // test fails.
    await findBankTransactionsByReference(COMPANY_ID, 'REF-001');
    const inQuery = [...sqlText(0).matchAll(/btrim\([a-z_.]+, ([^)]*)\)/g)].map((m) => m[1]);
    expect(inQuery.length).toBeGreaterThan(0);

    const migration = readFileSync(
      'scripts/migrations/sql/519_bank_tx_reference_trim_indexes.sql',
      'utf8',
    );
    const indexLines = migration
      .split('\n')
      .filter((l) => l.includes('ON bank_transactions'));
    expect(indexLines).toHaveLength(2);
    const inMigration = indexLines.flatMap(
      (l) => [...l.matchAll(/btrim\([a-z_]+, ([^)]*)\)/g)].map((m) => m[1]),
    );
    expect(inMigration).toHaveLength(2);
    for (const expr of inMigration) expect(expr).toBe(inQuery[0]);
  });
});
