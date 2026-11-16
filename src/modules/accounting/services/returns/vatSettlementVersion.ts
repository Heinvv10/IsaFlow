/**
 * The VAT201 version a settlement is posted against (wave 6 VR, §0a.12): submitVATReturn refuses a period that has
 * no finalised or filed version for exactly that period, before it reads or writes anything else.
 *
 * No row lock: an amend that supersedes the version right after this read leaves the settlement linked to a
 * superseded version, which is the same state as an amend made a minute after the settlement, and both are allowed
 * (the settlement belongs to the period; the link says which version it was posted against).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ReturnRefusal } from './returnVersionTypes';

export interface SettledVersion { id: string; versionNo: number; status: 'finalised' | 'filed' }

export async function requireVatVersionForSettlement(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<SettledVersion> {
  const rows = (await sql`
    SELECT id, version_no, status FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = 'VAT201'
      AND period_start = ${periodStart}::DATE AND period_end = ${periodEnd}::DATE
      AND status IN ('finalised', 'filed')
  `) as DbRow[];
  const r = rows[0];
  if (!r) {
    throw new ReturnRefusal(409,
      `Finalise the VAT201 for ${periodStart} to ${periodEnd} first. A VAT settlement is posted against a finalised `
      + 'or filed return for exactly that period.', 'VAT201_NOT_FINALISED');
  }
  return { id: String(r.id), versionNo: Number(r.version_no), status: r.status as SettledVersion['status'] };
}
