/**
 * Intercompany F, round 1 (B7, MED-1): lists the SQL of migration 1031 spells out that TypeScript holds as one source of truth, pinned equal so
 * the guard and the service can never judge "open invoice" or "money account" differently:
 *   H2 intercompany_payment_target_ok's open invoice statuses  ==  AR_OPEN_STATUSES (lib/constants/invoiceStatuses)
 *   H4 intercompany_payment_cash_word's money-account subtypes  ==  CASH_SUBTYPES (gl/accountSubtypes; ap/settlementKind's money rule)
 *   H4's settling statement-line statuses  ==  SETTLING_LINE_STATUSES (core/paymentVoidReads; settlementKind's rule 2)
 *   (round 2) D1 and the unsent read hold no list of their own: both call H4
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AR_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';
import { SETTLING_LINE_STATUSES } from '@/modules/accounting/services/core/paymentVoidReads';

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

  it("H4's money-account subtypes are CASH_SUBTYPES", () => {
    const lists = [...body('intercompany_payment_cash_word').matchAll(/account_subtype = ANY \(ARRAY\[([^\]]*)\]::text\[\]\)/g)];
    expect(lists).toHaveLength(1);
    expect(literals(lists[0]![1]!)).toEqual([...CASH_SUBTYPES].sort());
  });

  it("H4's settling statement-line statuses are SETTLING_LINE_STATUSES", () => {
    const lists = [...body('intercompany_payment_cash_word').matchAll(/kbt\.status = ANY \(ARRAY\[([^\]]*)\]::text\[\]\)/g)];
    expect(lists).toHaveLength(1);
    expect(literals(lists[0]![1]!)).toEqual([...SETTLING_LINE_STATUSES].sort());
  });

  it('D1 and the unsent read judge cash by H4 alone (no list of their own)', () => {
    const d1 = body('intercompany_send_for_payment');
    expect(d1).toContain('public.intercompany_payment_cash_word(a.payment_id, v_co)');
    expect(d1).not.toMatch(/account_subtype|bank_transactions/);
    const unsent = readFileSync(path.join(process.cwd(), 'src/modules/accounting/services/intercompany/paymentUnsent.ts'), 'utf8');
    expect(unsent).toContain('public.intercompany_payment_cash_word(sp.id,');
    expect(unsent).not.toMatch(/account_subtype|bank_transactions|CASH_SUBTYPES/);
  });
});
