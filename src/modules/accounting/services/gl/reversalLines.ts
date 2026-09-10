/**
 * The contra lines of a reversal, and the one value they must NOT carry
 * forward.
 *
 * A reversal mirrors a POSTED entry line for line: debits and credits swap and
 * the dimensions and VAT classification come across unchanged, deliberately —
 * dropping a dimension would move the contra out of the bucket the original
 * sits in and into none, so the pair would stop netting to zero there.
 *
 * That copy is not a claim the caller made; it is a value already sitting on a
 * posted line. `project_id`, `cost_center_id`, `cc1_id`, `cc2_id` and `bu_id`
 * carry no foreign key, so a legacy line can hold an id belonging to another
 * company — exactly the population K-051 exists because of.
 * `assertJournalLinesOwned` refuses such an id, which is right for a caller
 * naming a dimension on a NEW line and wrong here: it throws out of
 * `createJournalEntry` and the entry can then never be reversed at all.
 * Reversal is the only sanctioned correction in this schema — supplier-invoice
 * cancel, credit-note cancel, payment void, provisional dismiss and the MCP
 * `reverse_journal_entry` tool all route through it — so
 * refusing does not protect anything, it costs the operator the only remedy
 * they have and leaves the bad row untouched.
 *
 * `cc1_id` / `cc2_id` are the same story on the same table: both name a
 * `cost_centres` row, so they resolve against the same owned set as
 * `cost_center_id`, and `assertJournalCostCentres` refuses a foreign one on the
 * contra exactly as `assertJournalLinesOwned` refuses a foreign project.
 *
 * `vat_type` is NOT a tenant reference — it is a classification string with no
 * owning row — so it always comes across untouched.
 *
 * So the foreign id is dropped, per LINE and per DIMENSION. What that costs
 * differs by path, and only one of the two nets out — state it exactly, because
 * this is the justification for a silent drop on a ledger write.
 *
 * On the RECLASSIFICATION path both legs are newly written from the same source
 * line and both lose the tag, so the pair lands in the untagged bucket together
 * and nets to zero there.
 *
 * On a REVERSAL only the CONTRA is written. The original posted line is
 * deliberately left untouched and KEEPS its foreign tag, so the pair sits in
 * TWO buckets and does NOT net. For every report that reads a dimension only
 * through a filter the user supplies — trial balance, balance sheet, income
 * statement — that is invisible, because an id this company does not own
 * matches no filter it can run. The one exception is `getProjectProfitability`,
 * which enumerates `DISTINCT jl.project_id` and excludes untagged lines: the
 * original keeps its unnamed foreign bucket at the FULL amount and the contra
 * lands in no bucket at all, so reversing does not take that bucket to zero.
 * Carrying the tag instead is not available — `assertJournalLinesOwned` refuses
 * it and migration 664's composite FK refuses the row — and refusing the
 * reversal costs the operator the only remedy they have. The residual is
 * declared in K-051's fix.md under Limits.
 *
 * The count comes back so the caller can tell the operator: the REST reversal
 * returns it on the entry, the MCP tool renders it as a
 * `foreign_dimension_dropped` warning in the dry run and the live call alike.
 */

import { log } from '@/lib/logger';
import { ownedDimensions, ownedOrNull } from './journalLineOwnership';
import type { JournalEntry, JournalLine, JournalLineInput } from '../../types/gl.types';

/**
 * The reversal entry, plus how many of its lines lost a dimension the company
 * does not own (see reversalLines.ts). Additive: every existing caller reads it
 * as a `JournalEntry`.
 */
export type ReversalEntry = JournalEntry & { foreignDimensionDroppedLines: number };

export interface ReversalLines {
  /** The contra lines, with any dimension this company does not own left off. */
  lines: JournalLineInput[];
  /** How many source lines lost at least one dimension. */
  droppedLineCount: number;
}

/**
 * Three SELECTs for the whole entry, not three per line.
 *
 * `preview` only changes the log line. The MCP dry run builds the contra to
 * show what a post WOULD do and then writes nothing, so the write-tense warning
 * asserted a mutation an operator reading journalctl could not tell apart from
 * a real one.
 */
export async function buildReversalLines(
  companyId: string,
  lines: readonly JournalLine[],
  opts?: { preview?: boolean },
): Promise<ReversalLines> {
  const owned = await ownedDimensions(companyId, {
    project: lines.map((l) => l.projectId),
    // cc1_id and cc2_id are cost_centres rows too, so one SELECT answers all
    // three columns rather than three answering the same table.
    costCentre: lines.flatMap((l) => [l.costCenterId, l.cc1Id, l.cc2Id]),
    businessUnit: lines.map((l) => l.buId),
  });

  let droppedLineCount = 0;
  const reversalLines = lines.map((l) => {
    const projectId = ownedOrNull(owned.project, l.projectId) ?? undefined;
    const costCenterId = ownedOrNull(owned.costCentre, l.costCenterId) ?? undefined;
    const cc1Id = ownedOrNull(owned.costCentre, l.cc1Id) ?? undefined;
    const cc2Id = ownedOrNull(owned.costCentre, l.cc2Id) ?? undefined;
    const buId = ownedOrNull(owned.businessUnit, l.buId) ?? undefined;
    if (projectId !== l.projectId || costCenterId !== l.costCenterId
      || cc1Id !== l.cc1Id || cc2Id !== l.cc2Id || buId !== l.buId) {
      droppedLineCount += 1;
      log.warn(
        opts?.preview === true
          ? 'Reversal preview: a dimension that does not belong to this company would be dropped (nothing written)'
          : 'Reversal dropped a dimension that does not belong to this company',
        { companyId, lineId: l.id, journalEntryId: l.journalEntryId },
        'accounting',
      );
    }
    return {
      glAccountId: l.glAccountId,
      debit: l.credit,
      credit: l.debit,
      description: `Reversal: ${l.description || ''}`,
      projectId,
      costCenterId,
      cc1Id,
      cc2Id,
      buId,
      vatType: l.vatType,
    };
  });

  return { lines: reversalLines, droppedLineCount };
}
