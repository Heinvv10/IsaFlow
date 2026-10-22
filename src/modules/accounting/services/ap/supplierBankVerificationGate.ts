/**
 * The supplier bank-verification gate in front of money LEAVING (forensic-
 * controls step 1; Hein, decision 1): the EFT bank file (eft-generate) and the
 * Netcash submission (netcash/submit) — the only two paths, census-pinned —
 * and nothing that records money already moved. With `supplier_bank_details`
 * enforced (decision 2: whether or not payment approval is), a batch is sent
 * only when every payee's bank details are verified (migration 876:
 * `supplier_bank_verified`, derived from the latest verification's
 * fingerprint). A raw Netcash payment list — accounts no supplier row carries
 * (decision 8) — is refused by netcash/submit whether or not the control is on
 * (AP-01). Off: unchanged, no lock taken.
 *
 * The routes read the payees' bank details into the file FIRST, with the
 * fingerprint of exactly what they read (`supplier_bank_fingerprint` in the
 * same SELECT). The gate then share-locks those suppliers in id order (the
 * order the batch approval gate takes) and re-reads: a payee is refused if it
 * is not verified now, OR if what the file was built from is not its current
 * details — an edit that committed between the read and the lock. Held to the
 * end of the request, the lock makes any later edit wait for the file.
 */
import type { NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { isEnforced } from '../gl/approvalEnforcement';
import { SUPPLIER_BANK_DETAILS } from '../gl/approvalRuleOptions';

export interface PayeeBankDetails {
  supplierId: string;
  /** supplier_bank_fingerprint() of the bank columns the file line was built from. */
  fingerprint: string;
}

/** Money would leave to bank details nobody independently verified. Raised before anything is sent or written. */
export class SupplierBankDetailsUnverifiedError extends Error {
  readonly code = 'SUPPLIER_BANK_DETAILS_UNVERIFIED';
  constructor(readonly suppliers: { id: string; name: string }[], readonly status: 403 | 409, message: string) {
    super(message);
    this.name = 'SupplierBankDetailsUnverifiedError';
  }
}

/** Throws SupplierBankDetailsUnverifiedError (409) unless every payee's bank details, as read for the file, are verified. */
export async function assertSuppliersBankVerified(companyId: string, payees: readonly PayeeBankDetails[]): Promise<void> {
  if (!(await isEnforced(companyId, SUPPLIER_BANK_DETAILS))) return;
  const ids = [...new Set(payees.map((p) => p.supplierId))].sort();
  if (ids.length === 0) return;
  await sql`
    SELECT id FROM suppliers WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
    ORDER BY id FOR SHARE
  `;
  // A second statement, so it reads after the locks were granted.
  const rows = (await sql`
    SELECT s.id::TEXT AS id, s.name,
           supplier_bank_fingerprint(s.bank_name, s.bank_account_number, s.bank_branch_code, s.bank_account_type,
                                     s.bank_account_holder) AS fingerprint,
           supplier_bank_verified(s.company_id, s.id) AS verified
    FROM suppliers s WHERE s.company_id = ${companyId}::UUID AND s.id = ANY(${ids}::UUID[])
  `) as { id: string; name: string | null; fingerprint: string; verified: boolean }[];
  const now = new Map(rows.map((r) => [r.id, r]));
  const refused = ids.filter((id) => {
    const row = now.get(id);
    return !row || row.verified !== true || payees.some((p) => p.supplierId === id && p.fingerprint !== row.fingerprint);
  }).map((id) => ({ id, name: String(now.get(id)?.name ?? id) }));
  if (refused.length === 0) return;
  log.warn('Outbound payment refused: unverified supplier bank details', { companyId, suppliers: refused.map((s) => s.id) }, 'accounting');
  throw new SupplierBankDetailsUnverifiedError(refused, 409,
    `Not sent: the bank details of ${refused.map((s) => s.name).join(', ')} changed since they were last verified, `
    + "or were never verified. Someone permitted to verify them, who did not set them, must verify them on the supplier's page first.");
}

/** Answers a SupplierBankDetailsUnverifiedError (409 or 403, naming the suppliers); false for anything else. */
export function respondIfBankDetailsUnverified(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof SupplierBankDetailsUnverifiedError)) return false;
  apiResponse.error(res, err.status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.CONFLICT, err.message,
    { reason: err.code, suppliers: err.suppliers });
  return true;
}
