/**
 * The account that holds the company's BANK system role, judged for a posting
 * that credits it (payroll net pay, and the UIF, SARS directive and loan
 * payments that default to it). ONE source of truth: `payrollJournalBank`
 * turns a refusal into a plan blocker, `paymentBankAccount` into a 4xx.
 *
 * It starts from `getSystemAccount` (what every other auto-posting uses), then
 * re-reads the chart, because that answer is cached for up to a minute past a
 * Default Accounts save and a posting must not go to a holder the table no
 * longer names:
 *  - the cached holder no longer holds the role, or the role now sits on
 *    another account: refused, "try again";
 *  - more than one active account claims the role: refused naming all of them
 *    (`getSystemAccount` would silently pick one by `preferSystemAccount`);
 *  - the holder is a balance-sheet header: refused with the poster's own rule
 *    (`assertNoHeaderAccountLines`), which would refuse the post anyway.
 * A holder deactivated since the cache filled is RETURNED with `isActive:
 * false`: payroll names it in `inactive_target_account`, the payments refuse it.
 * No holder is a refusal and never a fallback to the code 1110.
 */
import { MissingSystemAccountError } from './systemAccountKeys';
import { getSystemAccount } from './systemAccountResolver';
import { isLiveClaimant, readRoleClaimants } from './systemRoleCoverage';
import { assertNoHeaderAccountLines, isHeaderAccountRefusal } from './headerAccountGuard';

export const MISSING_BANK_ACCOUNT = 'missing_bank_account';
export const AMBIGUOUS_BANK_ACCOUNT = 'ambiguous_bank_account';
export const HEADER_BANK_ACCOUNT = 'header_bank_account';

export interface BankRoleHolder {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

export interface BankRoleRefusal {
  code: string;
  detail: string;
}

/** Exactly one of `account` / `refusal` is set. */
export type BankRoleResolution =
  | { account: BankRoleHolder; refusal: null }
  | { account: null; refusal: BankRoleRefusal };

const SET_IT = 'Set the bank account in Default Accounts; nothing falls back to account 1110.';

const refuse = (code: string, detail: string): BankRoleResolution => ({ account: null, refusal: { code, detail } });

const named = (c: { accountCode: string; accountName: string }): string => `${c.accountCode} ${c.accountName}`;

function missingDetail(err: MissingSystemAccountError): string {
  const near = err.nearMisses.length > 0
    ? ` Candidates already in the chart: ${err.nearMisses
      .map((c) => `${c.accountCode} ${c.accountName} (${c.isActive ? 'active' : 'deactivated'}, ${c.isSystemAccount ? 'system' : 'not a system account'})`)
      .join('; ')}.`
    : '';
  return `No active account holds the company's bank role. ${err.remedy}${near} ${SET_IT}`;
}

/** Only a missing role is caught; any other failure is a crash and propagates. */
export async function resolveBankRoleHolder(companyId: string): Promise<BankRoleResolution> {
  let cached;
  try {
    cached = await getSystemAccount('bank', companyId);
  } catch (err) {
    if (!(err instanceof MissingSystemAccountError)) throw err;
    return refuse(MISSING_BANK_ACCOUNT, missingDetail(err));
  }

  const claimants = await readRoleClaimants('bank', companyId);
  const live = claimants.filter(isLiveClaimant);
  if (live.length > 1) {
    return refuse(AMBIGUOUS_BANK_ACCOUNT,
      `More than one active account claims the company's bank role: ${live.map(named).join('; ')}. `
      + 'Payroll will not choose between them. Leave one as the system bank account in Default Accounts.');
  }
  const mine = claimants.find((c) => c.id === cached.id);
  if (!mine || !mine.isSystemAccount || (live[0] && live[0].id !== mine.id)) {
    return refuse(MISSING_BANK_ACCOUNT,
      `${named(cached)} no longer holds the company's bank role (it changed within the last minute). Try again. ${SET_IT}`);
  }

  try {
    await assertNoHeaderAccountLines(companyId, [{ glAccountId: mine.id }]);
  } catch (err) {
    if (!isHeaderAccountRefusal(err)) throw err;
    return refuse(HEADER_BANK_ACCOUNT,
      `The account that holds the company's bank role cannot be posted to: ${err.message} ${SET_IT}`);
  }
  return { account: { id: mine.id, code: mine.accountCode, name: mine.accountName, isActive: mine.isActive }, refusal: null };
}
