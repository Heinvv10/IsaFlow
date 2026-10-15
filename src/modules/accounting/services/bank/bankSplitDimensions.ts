/**
 * Dimensions for a SPLIT bank allocation: one plan per split line, decided from
 * reads only, before the split posts anything.
 *
 * Each line here is a GL-account line (a supplier/customer line is planned by
 * bankSplitContacts), so the single-allocation rules apply
 * per line (bankAllocationDimensions.ts): explicit dimensions on a control
 * account are refused, the card's defaults fill a cost line the caller left
 * blank, and the COS-without-project rule warns (or blocks, per company). A line
 * on the AP/AR control itself is refused: that is a contact line's job.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { cosProjectWarnings } from '../gl/dimensions/dimensionPolicy';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { isControlSubtype, planAllocationDimensions } from './bankAllocationDimensions';
import { contactControlRefusal } from './contactControlGuard';

export interface SplitDimensionLine extends DimensionIds {
  contraAccountId: string;
}

export interface SplitDimensionPlan {
  /** Per split line, in order: the dimensions its contra line carries. */
  dims: DimensionIds[];
  /** COS lines with no project, when the company does not block them. */
  warnings: string[];
}

export async function planSplitDimensions(
  companyId: string,
  bankAccountId: string,
  lines: readonly SplitDimensionLine[],
): Promise<SplitDimensionPlan> {
  const accountIds = [...new Set(lines.map((l) => l.contraAccountId))];
  const rows = (await sql`
    SELECT a.id::TEXT AS id, a.account_subtype,
           b.default_cc1_id::TEXT AS bank_cc1_id, b.default_cc2_id::TEXT AS bank_cc2_id,
           b.default_bu_id::TEXT AS bank_bu_id
    FROM gl_accounts a
    LEFT JOIN gl_accounts b ON b.id = ${bankAccountId}::UUID AND b.company_id = ${companyId}::UUID
    WHERE a.company_id = ${companyId}::UUID AND a.id = ANY(${accountIds}::UUID[])
  `) as DbRow[];
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));
  const defaultsRow = rows[0];
  const bankDefaults: DimensionIds = {
    cc1Id: defaultsRow?.bank_cc1_id ? String(defaultsRow.bank_cc1_id) : undefined,
    cc2Id: defaultsRow?.bank_cc2_id ? String(defaultsRow.bank_cc2_id) : undefined,
    buId: defaultsRow?.bank_bu_id ? String(defaultsRow.bank_bu_id) : undefined,
  };
  // A GL line straight onto AP/AR control moves the control with no document, so the subledger drifts from it by
  // that amount — and beside a contact line's document it hides behind that document's gate. Name the contact.
  for (const line of lines) {
    const refusal = contactControlRefusal(byId.get(line.contraAccountId.toLowerCase())?.account_subtype, 'A split line');
    if (refusal) throw refusal;
  }
  const dims = lines.map((line) => {
    const account = byId.get(line.contraAccountId.toLowerCase());
    return planAllocationDimensions({
      settlement: false,
      contraIsControl: isControlSubtype(account?.account_subtype == null ? null : String(account.account_subtype)),
      explicit: { cc1Id: line.cc1Id, cc2Id: line.cc2Id, buId: line.buId },
      bankDefaults,
    });
  });
  const warnings = await cosProjectWarnings(
    companyId,
    lines.map((l, i) => ({ glAccountId: l.contraAccountId, cc2Id: dims[i]?.cc2Id })),
    (i) => `split line ${i + 1}`,
  );
  return { dims, warnings };
}

/** The same plan for a transaction named by id — the MCP preview and pre-write check. Null when not found. */
export async function planSplitDimensionsForTransaction(
  companyId: string,
  bankTxId: string,
  lines: readonly SplitDimensionLine[],
): Promise<SplitDimensionPlan | null> {
  const rows = (await sql`
    SELECT bank_account_id::TEXT AS bank_account_id FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows[0]?.bank_account_id) return null;
  return planSplitDimensions(companyId, String(rows[0].bank_account_id), lines);
}
