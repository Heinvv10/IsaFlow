/**
 * The dimensions a reclassification carries forward, and the one case where it
 * must NOT carry one.
 *
 * `journals.ts` copies `project_id`, `cost_center_id` and `bu_id` off the
 * HISTORICAL source line onto both legs, deliberately: dropping a dimension
 * moves the amount out of one bucket and into none. That copy is not a claim
 * the caller made — it is a value already sitting on a posted line — and those
 * three columns carry no foreign key, so a legacy line can hold an id belonging
 * to another company. Exactly the population K-051 exists because of.
 *
 * `assertJournalLinesOwned` refuses such an id, which is right for a caller
 * naming a dimension on a NEW line and wrong here: it would throw out of
 * `createJournalEntry` and unwind the WHOLE batch — `post.ts` catches nothing
 * by design — over one historical tag, on precisely the rows a remediation
 * reclassification is aimed at. Refusing strands the data instead of protecting
 * anything.
 *
 * So the foreign id is dropped, per LINE and per DIMENSION, before the drafts
 * are built. What that costs is nothing this company can see: an id it does not
 * own matches no dimension filter it can run, so the original was already
 * outside every one of its dimension reports. And because BOTH legs get the
 * same treatment, the contra and the re-application land in the same
 * (untagged) bucket and net to zero there — no figure a reader has moves.
 *
 * It runs in `plan.ts`, so a preview drops exactly what the batch drops:
 * `propose_reclassification` shows the drafts that would post, not prettier
 * ones. The count comes back as a `foreign_dimension_dropped` warning.
 */

import { log } from '@/lib/logger';
import { ownedDimensions } from '../journalLineOwnership';
import type { ReclassSourceLine } from './journals';

export interface CarriedDimensions<T> {
  /** The same lines, with any dimension this company does not own set to null. */
  lines: T[];
  /** How many lines lost at least one dimension. */
  droppedLineCount: number;
}

/** Three SELECTs for the whole batch, not three per journal. */
export async function carryForwardDimensions<T extends ReclassSourceLine>(
  companyId: string,
  lines: readonly T[],
): Promise<CarriedDimensions<T>> {
  if (lines.length === 0) return { lines: [], droppedLineCount: 0 };

  const owned = await ownedDimensions(companyId, {
    project: lines.map((l) => l.projectId),
    costCentre: lines.map((l) => l.costCenterId),
    businessUnit: lines.map((l) => l.buId),
  });
  const keep = (set: ReadonlySet<string>, id: string | null): string | null =>
    id !== null && id !== '' && set.has(id) ? id : null;

  let droppedLineCount = 0;
  const carried = lines.map((line) => {
    const next = {
      ...line,
      projectId: keep(owned.project, line.projectId),
      costCenterId: keep(owned.costCentre, line.costCenterId),
      buId: keep(owned.businessUnit, line.buId),
    };
    if (
      next.projectId !== line.projectId
      || next.costCenterId !== line.costCenterId
      || next.buId !== line.buId
    ) {
      droppedLineCount += 1;
      log.warn(
        'Reclassification dropped a dimension that does not belong to this company',
        { companyId, lineId: line.lineId },
        'accounting',
      );
    }
    return next;
  });

  return { lines: carried, droppedLineCount };
}
