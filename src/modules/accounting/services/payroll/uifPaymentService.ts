/**
 * UIF Payment Service — DR 2150 UIF Payable / CR Bank on payment to the
 * Labour Department. Split out of `uifDeclarationService.ts`, which reached the
 * 300-line ceiling when `markUifDeclarationPaid` took its status-predicated
 * claim. Not re-exported from there — that would be an import cycle, since the
 * mapper and the result type still live in the declaration service.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getAccountByCode } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { claimUnderLockTimeout } from '@/modules/accounting/services/core/documentClaimLock';
import { mapUifDeclaration, type UifPaymentResult } from './uifDeclarationService';

type Row = DbRow;

async function resolveGlAccount(companyId: string, code: string, label: string): Promise<string> {
  const acc = await getAccountByCode(companyId, code);
  if (!acc) throw new Error(`GL account ${code} (${label}) not found for company`);
  return acc.id;
}

/** DR 2150 UIF Payable / CR 1110 Bank — clears the month's UIF liability on payment to Labour Dept. */
export async function markUifDeclarationPaid(
  companyId: string,
  declarationId: string,
  opts: { paymentDate?: string; bankAccountId?: string },
  userId: string,
): Promise<UifPaymentResult> {
  const declRows = (await sql`
    SELECT * FROM uif_declarations
    WHERE id = ${declarationId}::uuid AND company_id = ${companyId}::uuid
  `) as Row[];
  if (declRows.length === 0 || !declRows[0]) throw new Error(`UIF declaration ${declarationId} not found`);
  const decl = mapUifDeclaration(declRows[0]);
  const paymentDate = opts.paymentDate ?? new Date().toISOString().slice(0, 10);

  // CLAIM the declaration before anything is posted. What this replaced read
  // `decl.status` in JS and then posted DR 2150 / CR Bank and rewrote the row
  // with NO status predicate and its row count discarded: two concurrent
  // `markPaid` PATCHes both read 'submitted', both posted, and both COMMITted
  // — the bank credited twice for one UI-19 and one journal id orphaned. The
  // status-predicated UPDATE is the guard; the loser matches zero rows and
  // stops here, before the first posting. `journal_entry_id` is still written
  // after the posting, the only thing left to record.
  const claimed = await claimUnderLockTimeout('UIF declaration', async () => (await sql`
    UPDATE uif_declarations SET status = 'paid', payment_date = ${paymentDate}::date, updated_at = NOW()
    WHERE id = ${declarationId}::uuid AND company_id = ${companyId}::uuid AND status = 'submitted'
    RETURNING id
  `) as Row[]);
  if (claimed.length === 0) {
    // Re-read rather than trusting the row read before the UPDATE: the loser of
    // a double-click needs the status the winner left behind. An already-paid
    // declaration stays idempotent, as it was before the claim.
    const nowRows = (await sql`
      SELECT * FROM uif_declarations
      WHERE id = ${declarationId}::uuid AND company_id = ${companyId}::uuid
    `) as Row[];
    const cur = nowRows[0] ? mapUifDeclaration(nowRows[0]) : null;
    if (cur?.status === 'paid') {
      log.info('UIF declaration already paid — idempotent', { companyId, declarationId }, 'uifDeclarationService');
      return { id: cur.id, totalPaid: cur.totalUif, journalEntryId: cur.journalEntryId ?? '', status: 'paid' };
    }
    throw new Error(`UIF declaration must be 'submitted' before paying (current: ${cur?.status ?? 'missing'})`);
  }

  const uifPayableId = await resolveGlAccount(companyId, '2150', 'UIF Payable');
  const bankAccId = opts.bankAccountId ?? await resolveGlAccount(companyId, '1110', 'Bank - Primary');
  const totalPaid = Math.round((decl.totalEmployeeContribution + decl.totalEmployerContribution) * 100) / 100;
  const narrative = `UIF payment ${decl.periodYear}-${String(decl.periodMonth).padStart(2, '0')}`;
  const entry = await createJournalEntry(companyId, {
    entryDate: paymentDate,
    description: narrative,
    source: 'auto_payroll',
    lines: [
      { glAccountId: uifPayableId, debit: totalPaid, credit: 0,         description: narrative },
      { glAccountId: bankAccId,    debit: 0,         credit: totalPaid, description: narrative },
    ],
  }, userId);
  await postJournalEntry(companyId, entry.id, userId);
  // Only the journal link is left to write — status and payment_date were set
  // by the claim above.
  await sql`
    UPDATE uif_declarations SET journal_entry_id = ${entry.id}::uuid, updated_at = NOW()
    WHERE id = ${declarationId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('UIF declaration marked paid', { companyId, declarationId, totalPaid, journalEntryId: entry.id }, 'uifDeclarationService');
  return { id: declarationId, totalPaid, journalEntryId: entry.id, status: 'paid' };
}
