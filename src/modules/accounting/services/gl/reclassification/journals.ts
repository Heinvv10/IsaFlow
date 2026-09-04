/**
 * The journals a reclassification posts.
 *
 * THE DESIGN CONSTRAINT, and it is the whole file: a reclassification NEVER
 * mutates a posted line. For each source line it posts a PAIR — a contra on the
 * source account and a re-application on the target — leaving the original
 * exactly as posted.
 *
 *   original   DR 49775627 Unallocated Expense   1,000
 *   contra     CR 49775627 Unallocated Expense   1,000
 *   applied    DR 5100     Materials & Supplies  1,000
 *
 * `UPDATE gl_journal_lines SET gl_account_id = …` would produce the same
 * closing balances and destroy three things: the trial balance a period was
 * signed on stops reproducing, an auditor loses the original classification,
 * and there is nothing to reverse — the reclassification itself becomes
 * invisible. The pair is the record that the reclassification happened, and it
 * is what makes the batch undoable through the ordinary `reverse_journal_entry`
 * path rather than through a bespoke un-edit.
 *
 * The mirror is direction-agnostic by construction: the contra swaps debit and
 * credit, so a credit-balance move (revenue, a liability, a contra-asset) needs
 * no branch and cannot get one wrong.
 *
 * Pure. It builds drafts; ./post.ts writes them.
 */

import type { JournalLineInput, VatType } from '../../../types/gl.types';

/** A movable line, as ./candidates.ts hands it over. */
export interface ReclassSourceLine {
  lineId: string;
  journalEntryId: string;
  entryNumber: string | null;
  entryDate: string;
  debit: number;
  credit: number;
  description: string | null;
  projectId: string | null;
  costCenterId: string | null;
  /** VAT coding on the line. Carried onto both legs — see below. */
  vatType: VatType | null;
  buId: string | null;
}

export interface ReclassAccountNames {
  sourceCode: string;
  sourceName: string;
  targetCode: string;
  targetName: string;
}

export interface ReclassJournalDraft {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  lines: JournalLineInput[];
  /**
   * The source lines this journal moves, IN THE ORDER their pairs appear in
   * `lines`. `post.ts` walks the posted lines two at a time against this list
   * to record which posted line is which source line's contra — the fact that
   * stops the contra being picked up as a candidate for a further move.
   */
  sourceLineIds: string[];
  totalDebit: number;
  totalCredit: number;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Every analysis dimension the source line carries, on BOTH legs.
 *
 * Dropping any of them moves the amount OUT of one bucket and into none, which
 * changes a figure nobody asked to change:
 *
 *   - `projectId` / `costCenterId` — project profitability and cost-centre
 *     reporting shift alongside the account.
 *   - `vatType` — the contra would not reverse the box contribution the
 *     original made and the target leg would not re-establish it, so the
 *     reclassification would be silently VAT-blind. On a VAT control account a
 *     NULL `vat_type` additionally manufactures one `vatExceptionsService`
 *     exception per posted line.
 *   - `buId` — the same argument as project and cost centre, and it was the
 *     only one of the four this file originally forgot.
 *
 * `cc1_id` / `cc2_id` are NOT here because `JournalLineInput` cannot express
 * them at all. A line carrying either is SKIPPED by `candidates.ts` rather than
 * posted with them dropped — the one honest answer available without widening a
 * shared write path used by every journal in the system.
 */
function dimensions(line: ReclassSourceLine) {
  return {
    projectId: line.projectId ?? undefined,
    costCenterId: line.costCenterId ?? undefined,
    vatType: line.vatType ?? undefined,
    buId: line.buId ?? undefined,
  };
}

/** Descriptions carry the source entry, so every posted line names its origin. */
function legDescription(kind: 'out of' | 'into', line: ReclassSourceLine): string {
  const origin = line.entryNumber ?? line.journalEntryId;
  const original = line.description ? ` — ${line.description}` : '';
  return `Reclassified ${kind} ${origin}${original}`;
}

/**
 * @param postingDate when null, each journal is dated at its source lines' own
 *   entry date, so the move is period-neutral: the period that carried the cost
 *   still carries it, on a different account. When set, ONE journal is posted on
 *   that date instead — which is how a closed source period is corrected from an
 *   open one, at the cost of moving the charge between periods. The caller
 *   validates the date's period before it gets here and says so in its output.
 */
export function buildReclassJournals(
  lines: readonly ReclassSourceLine[],
  sourceAccountId: string,
  targetAccountId: string,
  names: ReclassAccountNames,
  postingDate: string | null,
): ReclassJournalDraft[] {
  if (lines.length === 0) return [];

  const heading =
    `Reclassification: ${names.sourceCode} ${names.sourceName}` +
    ` → ${names.targetCode} ${names.targetName}`;

  // Grouped in the order the lines arrive (candidates.ts orders by entry_date),
  // so the journals come back in date order without a second sort.
  const byDate = new Map<string, ReclassSourceLine[]>();
  for (const line of lines) {
    const key = postingDate ?? line.entryDate;
    const bucket = byDate.get(key);
    if (bucket) bucket.push(line);
    else byDate.set(key, [line]);
  }

  const drafts: ReclassJournalDraft[] = [];
  for (const [date, group] of byDate) {
    const journalLines: JournalLineInput[] = [];
    for (const line of group) {
      // The contra: debit and credit swapped, so it undoes the original on the
      // source account whichever side that original sat on.
      journalLines.push({
        glAccountId: sourceAccountId,
        debit: round2(line.credit),
        credit: round2(line.debit),
        description: legDescription('out of', line),
        ...dimensions(line),
      });
      // The re-application: the original's own direction, on the target.
      journalLines.push({
        glAccountId: targetAccountId,
        debit: round2(line.debit),
        credit: round2(line.credit),
        description: legDescription('into', line),
        ...dimensions(line),
      });
    }
    const totalDebit = round2(journalLines.reduce((t, l) => t + l.debit, 0));
    const totalCredit = round2(journalLines.reduce((t, l) => t + l.credit, 0));
    drafts.push({
      date,
      description: heading,
      lines: journalLines,
      sourceLineIds: group.map((l) => l.lineId),
      totalDebit,
      totalCredit,
    });
  }
  return drafts;
}
