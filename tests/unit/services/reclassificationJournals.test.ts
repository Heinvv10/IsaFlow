/**
 * `buildReclassJournals` — the journals a reclassification WOULD post.
 *
 * The one design constraint these tests exist to hold: a reclassification never
 * mutates a posted line. It posts a contra on the source account and a
 * re-application on the target, per source line, so the original stays exactly
 * as it was posted and the pair is reversible through `reverse_journal_entry`.
 *
 * If any assertion here can be satisfied by an UPDATE to
 * `gl_journal_lines.gl_account_id`, the assertion is wrong.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReclassJournals,
  type ReclassSourceLine,
} from '@/modules/accounting/services/gl/reclassification/journals';

const SOURCE = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';

function line(over: Partial<ReclassSourceLine> = {}): ReclassSourceLine {
  return {
    lineId: 'l1',
    journalEntryId: 'e1',
    entryNumber: 'JE-2026-00001',
    entryDate: '2026-04-15',
    debit: 1000,
    credit: 0,
    description: 'Fibre cable',
    projectId: null,
    costCenterId: null,
    vatType: null,
    buId: null,
    ...over,
  };
}

const NAMES = {
  sourceCode: '49775627',
  sourceName: 'Unallocated Expense',
  targetCode: '5100',
  targetName: 'Materials & Supplies',
};

describe('buildReclassJournals', () => {
  it('posts a contra on the source and a re-application on the target, per line', () => {
    const [journal] = buildReclassJournals([line()], SOURCE, TARGET, NAMES, null);
    expect(journal!.lines).toEqual([
      expect.objectContaining({ glAccountId: SOURCE, debit: 0, credit: 1000 }),
      expect.objectContaining({ glAccountId: TARGET, debit: 1000, credit: 0 }),
    ]);
  });

  it('mirrors a CREDIT-balance line without special-casing the direction', () => {
    const [journal] = buildReclassJournals(
      [line({ debit: 0, credit: 750 })], SOURCE, TARGET, NAMES, null,
    );
    expect(journal!.lines).toEqual([
      expect.objectContaining({ glAccountId: SOURCE, debit: 750, credit: 0 }),
      expect.objectContaining({ glAccountId: TARGET, debit: 0, credit: 750 }),
    ]);
  });

  it('balances every journal to the cent', () => {
    const journals = buildReclassJournals(
      [
        line({ lineId: 'a', debit: 1234.56, credit: 0 }),
        line({ lineId: 'b', debit: 0, credit: 99.99 }),
        line({ lineId: 'c', debit: 0.01, credit: 0 }),
      ],
      SOURCE, TARGET, NAMES, null,
    );
    for (const j of journals) {
      const debit = j.lines.reduce((t, l) => t + l.debit, 0);
      const credit = j.lines.reduce((t, l) => t + l.credit, 0);
      expect(Math.round(debit * 100)).toBe(Math.round(credit * 100));
    }
  });

  it('nets to zero on the source account across the whole batch', () => {
    const lines = [
      line({ lineId: 'a', debit: 400, credit: 0 }),
      line({ lineId: 'b', debit: 0, credit: 150 }),
    ];
    const journals = buildReclassJournals(lines, SOURCE, TARGET, NAMES, null);
    const sourceMovement = journals
      .flatMap(j => j.lines)
      .filter(l => l.glAccountId === SOURCE)
      .reduce((t, l) => t + l.debit - l.credit, 0);
    const originalMovement = lines.reduce((t, l) => t + l.debit - l.credit, 0);
    // The contra exactly undoes what the originals put there.
    expect(sourceMovement).toBeCloseTo(-originalMovement, 2);
  });

  it('dates one journal per distinct source entry date by default', () => {
    const journals = buildReclassJournals(
      [
        line({ lineId: 'a', entryDate: '2026-04-15' }),
        line({ lineId: 'b', entryDate: '2026-04-15' }),
        line({ lineId: 'c', entryDate: '2026-05-02' }),
      ],
      SOURCE, TARGET, NAMES, null,
    );
    expect(journals.map(j => j.date)).toEqual(['2026-04-15', '2026-05-02']);
    expect(journals[0]!.lines).toHaveLength(4);
    expect(journals[1]!.lines).toHaveLength(2);
  });

  it('collapses to ONE journal on the caller-supplied posting date', () => {
    const journals = buildReclassJournals(
      [line({ lineId: 'a', entryDate: '2026-04-15' }), line({ lineId: 'b', entryDate: '2026-05-02' })],
      SOURCE, TARGET, NAMES, '2026-09-04',
    );
    expect(journals).toHaveLength(1);
    expect(journals[0]!.date).toBe('2026-09-04');
    expect(journals[0]!.lines).toHaveLength(4);
  });

  it('carries the source line through to its documents in the line description', () => {
    const [journal] = buildReclassJournals([line()], SOURCE, TARGET, NAMES, null);
    expect(journal!.lines[0]!.description).toContain('JE-2026-00001');
    expect(journal!.lines[1]!.description).toContain('JE-2026-00001');
    expect(journal!.description).toContain('49775627');
    expect(journal!.description).toContain('5100');
  });

  it('preserves the VAT coding on BOTH legs', () => {
    // Dropping it posts two lines with vat_type NULL. On a VAT control account
    // that manufactures one vatExceptionsService exception per line, and on any
    // account it means the contra does not reverse the box contribution the
    // original made and the target leg does not re-establish it — the
    // reclassification would be silently VAT-blind. 9,410 posted lines
    // platform-wide carry a vat_type.
    const [journal] = buildReclassJournals(
      [line({ vatType: 'standard' })], SOURCE, TARGET, NAMES, null,
    );
    expect(journal!.lines.map((l) => l.vatType)).toEqual(['standard', 'standard']);
  });

  it('preserves the business unit on BOTH legs', () => {
    const [journal] = buildReclassJournals([line({ buId: 'bu1' })], SOURCE, TARGET, NAMES, null);
    expect(journal!.lines.map((l) => l.buId)).toEqual(['bu1', 'bu1']);
  });

  it('preserves project and cost centre on BOTH legs', () => {
    const [journal] = buildReclassJournals(
      [line({ projectId: 'p1', costCenterId: 'c1' })], SOURCE, TARGET, NAMES, null,
    );
    for (const l of journal!.lines) {
      expect(l.projectId).toBe('p1');
      expect(l.costCenterId).toBe('c1');
    }
  });

  it('keeps the source line ids in order, so posted line ids can be recorded against them', () => {
    const journals = buildReclassJournals(
      [line({ lineId: 'a' }), line({ lineId: 'b' })], SOURCE, TARGET, NAMES, null,
    );
    expect(journals[0]!.sourceLineIds).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty batch rather than an empty journal', () => {
    expect(buildReclassJournals([], SOURCE, TARGET, NAMES, null)).toEqual([]);
  });
});
