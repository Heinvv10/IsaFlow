import { describe, expect, it } from 'vitest';
import {
  DRY_RUN_DETAIL,
  DRY_RUN_WROTE_NOTHING,
  MUTATION_ARG_SCHEMA,
  type DryRunResult,
} from '@/lib/mcp/contracts/mutation';

describe('mutation contract', () => {
  it('offers both arguments every mutating tool must take', () => {
    expect(Object.keys(MUTATION_ARG_SCHEMA).sort()).toEqual(['dry_run', 'idempotency_key']);
    expect(MUTATION_ARG_SCHEMA.dry_run.type).toBe('boolean');
    expect(MUTATION_ARG_SCHEMA.idempotency_key.type).toBe('string');
  });

  // An agent reads the description, not this file. A dry_run description that
  // does not say it writes nothing is the whole safety argument, missing.
  it('tells an agent that a dry run writes nothing and returns the journals', () => {
    expect(MUTATION_ARG_SCHEMA.dry_run.description).toMatch(/writes nothing/i);
    expect(MUTATION_ARG_SCHEMA.dry_run.description).toMatch(/journals/i);
  });

  it('tells an agent that reusing a key replays rather than rewrites', () => {
    expect(MUTATION_ARG_SCHEMA.idempotency_key.description).toMatch(/retry|again|replay|stored/i);
  });

  // Storing a dry run under the key makes the real call that follows — same
  // intent, same natural key — replay the preview forever.
  it('requires a dry run to declare that it wrote nothing', () => {
    expect(DRY_RUN_WROTE_NOTHING).toBe(true);
  });

  it('reports a dry run at full detail — a preview that hides rows is not a review step', () => {
    expect(DRY_RUN_DETAIL).toBe('full');
  });

  it('carries a journal total independent of a possibly-truncated journal list', () => {
    const result: DryRunResult = {
      dryRun: true,
      journals: [
        {
          date: '2026-09-03',
          description: 'Receipt applied to INV0000133',
          fiscalPeriodId: null,
          lines: [
            { accountId: 'a', accountCode: '1100', accountName: 'Bank', debit: 100, credit: 0 },
            { accountId: 'b', accountCode: '1200', accountName: 'AR', debit: 0, credit: 100 },
          ],
          totalDebit: 100,
          totalCredit: 100,
        },
      ],
      skipped: [{ id: 'bt-9', reason: 'already_allocated' }],
      effects: [
        {
          entityType: 'customer_invoice',
          entityId: 'inv-133',
          documentNumber: 'INV0000133',
          field: 'amount_paid',
          before: 0,
          after: 100,
        },
      ],
      journalsTotal: 4319,
      truncated: true,
    };
    // The point of the field: 1 journal shown, 4,319 would post.
    expect(result.journals.length).toBeLessThan(result.journalsTotal);
    expect(result.truncated).toBe(true);
  });

  // A dry run whose journal does not balance is a bug the preview must expose,
  // not hide — the shape has to be able to represent it.
  it('lets a preview show a journal that does not balance', () => {
    const line = { accountId: 'a', accountCode: '1100', accountName: 'Bank', debit: 100, credit: 0 };
    const unbalanced = { date: '2026-09-03', description: 'x', fiscalPeriodId: null, lines: [line], totalDebit: 100, totalCredit: 0 };
    expect(unbalanced.totalDebit).not.toBe(unbalanced.totalCredit);
  });

  // A date in no fiscal period is a blocker, and the preview says so with null
  // rather than silently picking one.
  it('represents "this date falls in no fiscal period" explicitly', () => {
    const j: DryRunResult['journals'][number] = {
      date: '2022-01-01', description: 'x', fiscalPeriodId: null, lines: [], totalDebit: 0, totalCredit: 0,
    };
    expect(j.fiscalPeriodId).toBeNull();
  });
});
