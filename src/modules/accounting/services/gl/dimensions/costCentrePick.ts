/**
 * A user-picked cost centre goes into the right dimension slot — the one rule
 * every writer that used to set only the legacy `costCenterId` now uses: AP
 * expense lines, expense claims, provisional capture, the GL import, the REST
 * journal body and petty cash (PR #688 round 3). A line's CC1 is cc1_id alone
 * (reports/dimensionPnlService.ts), so a centre written only to the legacy
 * cost_center_id was invisible to every report; these paths no longer write
 * that column.
 *
 * Run by the writer BEFORE createJournalEntry, so on a new assignment the
 * dimension policy's CC2 -> FNO derivation and the slot checks see the result.
 * Never on a historical copy: a reversal or reclassification carries cc1_id
 * and cc2_id exactly as stored.
 *
 *  - a CC1 (`cc_type 'cc1'`) fills cc1Id — only when the line has no CC1 and
 *    no CC2. With a CC2, derivation supplies the CC1 (a bill whose header names
 *    one FNO and whose item names a project under another posted refused);
 *  - a CC2 fills cc2Id when the line has none;
 *  - a slot the line already fills keeps its own value; the pick is dropped;
 *  - an INACTIVE centre is dropped with a warning, and the line posts without
 *    it. A withdrawn picker option on a claim or a receipt used to post (into
 *    the legacy column); refusing it now would strand the document.
 *  - anything else — another company's id, no centre at all, an untyped
 *    centre — is refused with the message the ownership / slot checks give.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import type { DimensionIds } from './dimensionTypes';

export const COST_CENTRE_OUTSIDE_COMPANY = 'One or more journal lines name a cost centre outside this company';
export const COST_CENTRE_NOT_A_CC1_OR_CC2 = 'CC1 must name an active CC1 cost centre in this company';

export interface PickedCentre {
  ccType: string | null;
  isActive: boolean;
}

export type PickOutcome =
  | { kind: 'cc1' | 'cc2' }
  | { kind: 'drop'; reason: 'occupied' | 'inactive' }
  | { kind: 'refuse'; message: string };

/** THE rule. `centre` is the picked id's row in the line's own company, or undefined when it has none. */
export function costCentreSlot(centre: PickedCentre | undefined, line: DimensionIds): PickOutcome {
  if (centre === undefined) return { kind: 'refuse', message: COST_CENTRE_OUTSIDE_COMPANY };
  if (centre.ccType !== 'cc1' && centre.ccType !== 'cc2') return { kind: 'refuse', message: COST_CENTRE_NOT_A_CC1_OR_CC2 };
  if (!centre.isActive) return { kind: 'drop', reason: 'inactive' };
  if (centre.ccType === 'cc1') return line.cc1Id || line.cc2Id ? { kind: 'drop', reason: 'occupied' } : { kind: 'cc1' };
  return line.cc2Id ? { kind: 'drop', reason: 'occupied' } : { kind: 'cc2' };
}

/**
 * Each line's `costCenterId` (the pick) moved into its slot by `costCentreSlot`
 * and removed. One read of this company's centres; none when nothing is picked.
 * Throws the refusal before anything is written.
 */
export async function placeCostCentres<T extends DimensionIds & { costCenterId?: string }>(
  companyId: string,
  lines: readonly T[],
): Promise<Array<Omit<T, 'costCenterId'>>> {
  const picked = [...new Set(lines.map((l) => l.costCenterId).filter((id): id is string => Boolean(id)))];
  if (picked.some((id) => !UUID_RE.test(id))) throw new Error(COST_CENTRE_OUTSIDE_COMPANY);
  const centres = new Map<string, PickedCentre>();
  if (picked.length > 0) {
    const rows = (await sql`
      SELECT id::TEXT AS id, cc_type, is_active FROM cost_centres
      WHERE company_id = ${companyId}::UUID AND id = ANY(${picked}::UUID[])
    `) as Array<{ id: string; cc_type: string | null; is_active: boolean | null }>;
    for (const r of rows) centres.set(r.id.toLowerCase(), { ccType: r.cc_type, isActive: r.is_active === true });
  }
  return lines.map((line) => {
    const { costCenterId, ...rest } = line;
    if (!costCenterId) return rest;
    const outcome = costCentreSlot(centres.get(costCenterId.toLowerCase()), rest);
    if (outcome.kind === 'refuse') throw new Error(outcome.message);
    if (outcome.kind === 'drop') {
      if (outcome.reason === 'inactive') {
        log.warn('Inactive cost centre dropped from a journal line', { companyId, costCentreId: costCenterId }, 'accounting');
      }
      return rest;
    }
    return outcome.kind === 'cc1' ? { ...rest, cc1Id: costCenterId } : { ...rest, cc2Id: costCenterId };
  });
}
