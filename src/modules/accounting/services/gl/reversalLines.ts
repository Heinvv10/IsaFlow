/**
 * The contra lines of a reversal, and the one value they must NOT carry
 * forward.
 *
 * A reversal mirrors a POSTED entry line for line: debits and credits swap and
 * the three dimensions come across unchanged, deliberately — dropping a
 * dimension would move the contra out of the bucket the original sits in and
 * into none, so the pair would stop netting to zero there.
 *
 * That copy is not a claim the caller made; it is a value already sitting on a
 * posted line. `project_id`, `cost_center_id` and `bu_id` carry no foreign key,
 * so a legacy line can hold an id belonging to another company — exactly the
 * population K-051 exists because of. `assertJournalLinesOwned` refuses such an
 * id, which is right for a caller naming a dimension on a NEW line and wrong
 * here: it throws out of `createJournalEntry` and the entry can then never be
 * reversed at all. Reversal is the only sanctioned correction in this schema —
 * supplier-invoice cancel, credit-note cancel, payment void, provisional
 * dismiss and the MCP `reverse_journal_entry` tool all route through it — so
 * refusing does not protect anything, it costs the operator the only remedy
 * they have and leaves the bad row untouched.
 *
 * So the foreign id is dropped, per LINE and per DIMENSION. BOTH legs of the
 * pair lose the same tag — the contra is built from the original in one pass —
 * so the two land in the same (untagged) bucket and net to zero there. What it
 * costs is nothing this company can see: an id it does not own matches no
 * dimension filter it can run.
 *
 * The count comes back so the caller can tell the operator: the REST reversal
 * returns it on the entry, the MCP tool renders it as a
 * `foreign_dimension_dropped` warning in the dry run and the live call alike.
 */

import { log } from '@/lib/logger';
import { ownedDimensions, ownedOrNull } from './journalLineOwnership';
import type { JournalLine, JournalLineInput } from '../../types/gl.types';

export interface ReversalLines {
  /** The contra lines, with any dimension this company does not own left off. */
  lines: JournalLineInput[];
  /** How many source lines lost at least one dimension. */
  droppedLineCount: number;
}

/** Three SELECTs for the whole entry, not three per line. */
export async function buildReversalLines(
  companyId: string,
  lines: readonly JournalLine[],
): Promise<ReversalLines> {
  const owned = await ownedDimensions(companyId, {
    project: lines.map((l) => l.projectId),
    costCentre: lines.map((l) => l.costCenterId),
    businessUnit: lines.map((l) => l.buId),
  });

  let droppedLineCount = 0;
  const reversalLines = lines.map((l) => {
    const projectId = ownedOrNull(owned.project, l.projectId) ?? undefined;
    const costCenterId = ownedOrNull(owned.costCentre, l.costCenterId) ?? undefined;
    const buId = ownedOrNull(owned.businessUnit, l.buId) ?? undefined;
    if (projectId !== l.projectId || costCenterId !== l.costCenterId || buId !== l.buId) {
      droppedLineCount += 1;
      log.warn(
        'Reversal dropped a dimension that does not belong to this company',
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
      buId,
    };
  });

  return { lines: reversalLines, droppedLineCount };
}
