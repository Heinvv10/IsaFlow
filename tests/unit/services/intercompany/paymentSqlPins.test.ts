/**
 * Intercompany F, round 1 (B7, MED-1): lists the SQL of migration 1031 spells out that TypeScript holds as one source of truth, pinned equal so
 * the guard and the service can never judge "open invoice" or "money account" differently:
 *   H2 intercompany_payment_target_ok's open invoice statuses  ==  AR_OPEN_STATUSES (lib/constants/invoiceStatuses)
 *   D1 intercompany_send_for_payment's money-account subtypes  ==  CASH_SUBTYPES (gl/accountSubtypes; ap/settlementKind's money rule)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';

const MIGRATION = readFileSync(path.join(process.cwd(), 'scripts/migrations/sql/1031_intercompany_p6f_payment_messages.sql'), 'utf8');

/** The body of one CREATE OR REPLACE FUNCTION of the migration, up to its closing `$$;`. */
function body(fn: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  const end = MIGRATION.indexOf('\n$$;', start);
  return MIGRATION.slice(start, end);
}
const literals = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((x) => x[1]!).sort();

describe('1031 pins', () => {
  it("H2's open invoice statuses are AR_OPEN_STATUSES", () => {
    const lists = [...body('intercompany_payment_target_ok').matchAll(/ci\.status NOT IN \(([^)]*)\)/g)];
    expect(lists).toHaveLength(1);
    expect(literals(lists[0]![1]!)).toEqual([...AR_OPEN_STATUSES].sort());
  });

  it("D1's money-account subtypes are CASH_SUBTYPES", () => {
    const lists = [...body('intercompany_send_for_payment').matchAll(/account_subtype = ANY \(ARRAY\[([^\]]*)\]::text\[\]\)/g)];
    expect(lists).toHaveLength(1);
    expect(literals(lists[0]![1]!)).toEqual([...CASH_SUBTYPES].sort());
  });
});
