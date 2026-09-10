/**
 * The AP subledger AS AT a date — every open supplier bill, including the ones
 * that cannot be bucketed.
 *
 * Same contract, same population and the same reasoning as
 * `arSubledgerService`: master's aging population exactly, with the settlement
 * rewind from `services/shared/agingRewind.ts` so the balance is what was owed
 * on the reporting date rather than what is owed now. Read `subledgerTypes.ts`
 * and that file before changing anything about `asAtDate` here.
 *
 * AP has no unallocated-credit-note leg in this schema, so `creditNotes` is
 * always empty here. The field exists so both subledgers answer with the same
 * shape and a caller need not branch.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { effectivePaidExpr, rewindAmount } from '../shared/agingRewind';
import { documentInLedgerAsAtFragment } from '../shared/softDeleteLedgerPresence';
import type { SubledgerSnapshot } from '../ar/subledgerTypes';
import { buildSnapshot, toDocument } from '../ar/subledgerShared';
import { documentInPopulationExpr } from '@/modules/accounting/services/shared/documentPopulation';

export async function getAPSubledger(
  companyId: string,
  asAtDate: string,
): Promise<SubledgerSnapshot> {
  try {
    // Both bounds of the rewind window from ONE clock — see arSubledgerService.
    const todayStr = fmtDate(new Date());
    const paid = effectivePaidExpr('ap');

    const rows = (await sql`
      SELECT si.id,
             si.invoice_number AS document_number,
             si.supplier_id AS entity_id,
             s.name AS entity_name,
             COALESCE(si.invoice_date, si.created_at::date) AS document_date,
             si.due_date,
             si.total_amount,
             ${sql.unsafe(paid)} AS amount_paid,
             (si.total_amount - ${sql.unsafe(paid)}) AS balance,
             si.created_at
      FROM supplier_invoices si
      -- LEFT, and scoped — see arSubledgerService for why an inner join here
      -- would hide the data defect this report exists to surface.
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        -- Status rule: shared/documentPopulation (NULL-safe, one definition).
        AND ${sql.unsafe(documentInPopulationExpr('si'))}
        -- Same population as apAgingService — see arSubledgerService.
        AND ${documentInLedgerAsAtFragment('si', asAtDate, companyId)}
        AND COALESCE(si.invoice_date, si.created_at::date) <= ${asAtDate}::DATE
        AND (si.total_amount - ${sql.unsafe(paid)}) > 0
      ORDER BY si.due_date NULLS LAST, si.id
    `) as DbRow[];

    return buildSnapshot(rows.map(toDocument), [], rows);
  } catch (err) {
    log.error('Failed to read the AP subledger', { error: err }, 'accounting');
    throw err;
  }
}
