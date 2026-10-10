/**
 * A line's CC1 is `cc1_id` alone: no report reads the legacy `cost_center_id`
 * (reports/dimensionPnlService.ts). Several writers still set only the legacy
 * field — supplier-invoice expense lines (the bill's or item's cost centre),
 * petty cash, expense claims, provisional capture posting, the GL import and
 * any REST journal body — so createJournalEntry mirrors it here, on every line
 * in both modes, before the dimension policy and the slot checks run.
 *
 * A legacy id that names this company's CC1 (`cc_type 'cc1'`) becomes the
 * line's cc1Id. One that names a CC2 becomes its cc2Id when the line has none,
 * and new-assignment derivation then adds the project's FNO. Copying a CC2 into
 * the CC1 slot is never done: `assertJournalAnalysisDimensions` refuses a CC1
 * that is not `cc_type 'cc1'` in every mode, so the line could then never be
 * reversed. Anything else (an id this company does not own, a CC2 on a line
 * that already has one) is left as it was; the ownership check still refuses a
 * foreign id. The warning names the company and the cost centre only.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import type { JournalLineInput } from '../../types/gl.types';

/**
 * THE rule: which slot a legacy id moves to. `ccType` is the cc_type of the
 * cost centre with that id IN THE LINE'S OWN COMPANY — undefined when the
 * company has none. Its CC1 arm (own company, cc_type 'cc1') is exactly what
 * migration 887's section 0 accepts and its backfill copies; change both
 * together.
 */
export function legacyMirrorSlot(ccType: string | null | undefined, lineHasCc2: boolean): 'cc1' | 'cc2' | null {
  if (ccType === 'cc1') return 'cc1';
  if (ccType === 'cc2' && !lineHasCc2) return 'cc2';
  return null;
}

export async function mirrorLegacyCostCentre(
  companyId: string,
  lines: JournalLineInput[],
): Promise<JournalLineInput[]> {
  const legacy = [...new Set(lines
    .filter((l) => l.costCenterId && !l.cc1Id && UUID_RE.test(l.costCenterId))
    .map((l) => l.costCenterId!.toLowerCase()))];
  if (legacy.length === 0) return lines;
  const rows = (await sql`
    SELECT id::TEXT AS id, cc_type FROM cost_centres
    WHERE company_id = ${companyId}::UUID AND id = ANY(${legacy}::UUID[])
  `) as { id: string; cc_type: string | null }[];
  const typeOf = new Map(rows.map((r) => [r.id.toLowerCase(), r.cc_type]));
  return lines.map((l) => {
    if (!l.costCenterId || l.cc1Id) return l;
    const slot = legacyMirrorSlot(typeOf.get(l.costCenterId.toLowerCase()), Boolean(l.cc2Id));
    if (slot === 'cc1') return { ...l, cc1Id: l.costCenterId };
    if (slot === 'cc2') return { ...l, cc2Id: l.costCenterId };
    log.warn('Legacy cost centre not mirrored to CC1/CC2', { companyId, costCenterId: l.costCenterId }, 'accounting');
    return l;
  });
}
