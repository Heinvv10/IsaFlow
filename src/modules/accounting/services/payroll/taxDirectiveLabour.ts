/**
 * The labour split of a SARS directive paid outside payroll (applyTaxDirective),
 * read in the lock order payrollCostCentreTags documents: the employee's
 * centres BEFORE the directive row, then the split re-read under both.
 *
 * `lockDirectiveLabour` runs first. Its directive read takes no lock: the
 * cheap refusals (not found, not approved, no employee) are answered before
 * any centre lock is waited for, and are asked again under the directive lock
 * by the caller, which is what decides. employee_id is set at creation and
 * never updated, so the centres it names are the ones to lock.
 *
 * `refreshDirectiveLabour` runs once the directive row and payment claim are
 * held: allocations, own centre and mapping are read again, so an edit that
 * committed while either lock was waited for is what posts. If the split now
 * names a centre the first read did not lock, locking it here would take a
 * centre after a directive — the order that can close a cycle — so the
 * payment is refused with TaxDirectiveSplitChangedError (409, retryable)
 * instead. The request savepoint rolls back the claim. A mapping or allocation
 * edit committed after the re-read is not seen (the same window a pay-run plan
 * has); centres cannot change under the share lock.
 *
 * `postOrRetry` runs the journal and its link after the claim. A mapped labour
 * account deactivated after the post-claim re-read makes the GL refuse with
 * InactiveAccountError; when EVERY refused account is one of the split's
 * MAPPED labour accounts (used by no credit line) it is answered as
 * TaxDirectiveSplitChangedError (409, retryable): the retry's read routes that
 * labour to the default account. Any other refusal — the default account,
 * 2140, the bank, or a mix with any of them — is rethrown as before, since the
 * retry would fail the same way. The claim and the
 * draft journal are already written by then: the caller must run this inside a
 * savepoint that a throw rolls back — the apply route's withJournalDateRefusal
 * does (its only caller), so the 409 leaves nothing written — the rollback is
 * proven through the route by the split-grew 409, which also follows the
 * claim; the decision itself, unreachable deterministically through the route,
 * by tests/unit/services/payroll/taxDirectiveLabourPostOrRetry.test.ts. Chosen
 * over share-locking the mapped accounts: that adds a gl_accounts lock to this
 * path, to be censused against every poster and account edit, for a window of
 * moments.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { JournalLineInput } from '@/modules/accounting/types/gl.types';
import { claimUnderLockTimeout } from '@/modules/accounting/services/core/documentClaimLock';
import { InactiveAccountError } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { readEmployeeLabourSplit, type EmployeeLabourSplit } from './payrollCostCentreTags';
import { TaxDirectiveNotApprovedError, TaxDirectiveSplitChangedError, TaxDirectiveWithoutEmployeeError } from './taxDirectiveErrors';

export async function lockDirectiveLabour(companyId: string, directiveId: string): Promise<EmployeeLabourSplit> {
  const rows = (await sql`
    SELECT status, employee_id FROM tax_directives WHERE company_id = ${companyId} AND id = ${directiveId}
  `) as DbRow[];
  const dir = rows[0];
  if (!dir) throw new Error(`Tax directive ${directiveId} not found`);
  if (String(dir.status) !== 'approved') throw new TaxDirectiveNotApprovedError(directiveId, String(dir.status));
  if (dir.employee_id == null) throw new TaxDirectiveWithoutEmployeeError(directiveId);
  return (await claimUnderLockTimeout('tax directive', () =>
    readEmployeeLabourSplit(companyId, String(dir.employee_id))))!;
}

export async function refreshDirectiveLabour(companyId: string, directiveId: string, first: EmployeeLabourSplit): Promise<EmployeeLabourSplit> {
  const fresh = await readEmployeeLabourSplit(companyId, first.employeeId, first.centres);
  if (!fresh) throw new TaxDirectiveSplitChangedError(directiveId);
  return fresh;
}

export async function postOrRetry<T>(
  companyId: string, directiveId: string, lines: JournalLineInput[], defaultAccountId: string, write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!(err instanceof InactiveAccountError)) throw err;
    // Retryable only when EVERY refused account is a mapped labour account used by no other line (review round 3):
    // the retry routes that labour to the default account and then posts. A refused default, 2140 or bank account — or
    // labour mapped to an account a credit line also uses — would fail the retry the same way, so it is rethrown.
    const credited = new Set(lines.filter((l) => l.credit > 0).map((l) => l.glAccountId));
    const mapped = [...new Set(lines.filter((l) => l.debit > 0 && l.glAccountId !== defaultAccountId && !credited.has(l.glAccountId))
      .map((l) => l.glAccountId))];
    const codes = mapped.length === 0 ? [] : ((await sql`
      SELECT account_code FROM gl_accounts WHERE company_id = ${companyId}::uuid AND id = ANY(${mapped}::uuid[])
    `) as DbRow[]).map((r) => String(r.account_code));
    if (err.accounts.length === 0 || !err.accounts.every((c) => codes.includes(c))) throw err;
    throw new TaxDirectiveSplitChangedError(directiveId);
  }
}
