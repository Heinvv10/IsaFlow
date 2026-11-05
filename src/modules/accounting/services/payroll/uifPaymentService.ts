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
import { resolvePaymentBankAccount } from '@/modules/accounting/services/gl/paymentBankAccount';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { claimUnderLockTimeout } from '@/modules/accounting/services/core/documentClaimLock';
import { mapUifDeclaration, type UifDeclaration, type UifPaymentResult } from './uifDeclarationService';

type Row = DbRow;

async function resolveGlAccount(companyId: string, code: string, label: string): Promise<string> {
  const acc = await getAccountByCode(companyId, code);
  if (!acc) throw new Error(`GL account ${code} (${label}) not found for company`);
  return acc.id;
}

function alreadyPaid(decl: UifDeclaration): UifPaymentResult {
  log.info('UIF declaration already paid — idempotent', { companyId: decl.companyId, declarationId: decl.id }, 'uifDeclarationService');
  return { id: decl.id, totalPaid: decl.totalUif, journalEntryId: decl.journalEntryId ?? '', status: 'paid' };
}

const notSubmitted = (status: string): Error => new Error(`UIF declaration must be 'submitted' before paying (current: ${status})`);

/** DR 2150 UIF Payable / CR Bank (`bankAccountId`, else the bank-role holder) — clears the month's UIF liability on payment to Labour Dept. */
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
  // An already-paid declaration is idempotent whatever the bank role or the supplied account is now: a retry must
  // not be refused for a bank it will never credit. The claim below decides the same for a rival that wins the race.
  if (decl.status === 'paid') return alreadyPaid(decl);
  // A declaration that is not 'submitted' gets the status error, not a bank refusal for a payment it could never make
  // (the claim below repeats this against a rival that wins the race). Read-only, so nothing is written before a 4xx.
  if (decl.status !== 'submitted') throw notSubmitted(decl.status);
  // Refused before the claim below: a payment with no bank to credit writes nothing.
  const bankAccId = await resolvePaymentBankAccount(companyId, opts.bankAccountId);

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
    if (cur?.status === 'paid') return alreadyPaid(cur);
    throw notSubmitted(cur?.status ?? 'missing');
  }

  const uifPayableId = await resolveGlAccount(companyId, '2150', 'UIF Payable');
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
