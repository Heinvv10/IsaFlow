/**
 * The bank accounts an e@syFile file carries (wave 7 EA2; codes 3240-3245, BRS V25.3.0 pp. 45-46), read only through
 * the existing audited reader: getEmployeeBankDetails (masked for every role but owner / admin) and, for each account
 * read in full, auditBankDetailsRead (an `export` row in audit_log, in the request's transaction, naming who and whose,
 * never the values). A full account number leaves the database for a person's file only with that record.
 *
 * So the accounts are written only when the caller is an owner or admin (isHistoryAdmin) in their own session (not
 * Login-as, not a token or job: isHumanSession, as GET bank-details refuses them) building the file: the ad-hoc export.
 * A manager's export, and every build with no reader (the EMP501 lifecycle's figures, which are stored and compared,
 * never per person), reads no account and writes none: the file's notice says so (UNWRITTEN_FIELDS_WARNING). One read per certificate employee, only those whose certificate is written.
 */
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';
import type { RevealActor } from '@/modules/accounting/services/core/entityChanges/entityChangeReveal';
import { isHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { getEmployeeBankDetails } from './payrollBankDetailsService';
import { auditBankDetailsRead } from './payrollBankReadAudit';
import { bankAccountForCertificate, type CertificateBankAccount } from './easyFileContactFields';

/** Who is building the file: the session's company role and the actor its audit rows name. */
export interface CertificateBankReader { role: string | undefined; actor: RevealActor }

/**
 * What a file built for `reader` may carry (coordinator's security review of EA2: the same rule as the address and
 * bank-details routes, which refuse Login-as and tokens). A person in their own session: the addresses, and for an
 * owner or admin the bank accounts too. Login-as, a token or a job: neither. No reader at all is the EMP501
 * lifecycle's build, which is stored and compared, never served to the builder: the addresses are kept (the filed file
 * must carry them) and the only route that serves them, the EMP501 filing file, is owner / admin in their own session.
 */
export async function contactPolicyOf(reader: CertificateBankReader | undefined): Promise<{ address: boolean; bank: boolean }> {
  if (!reader) return { address: true, bank: false };
  const human = await isHumanSession();
  return { address: human, bank: human && isHistoryAdmin(reader.role) };
}

export interface CertificateBankAccounts {
  /** False when no account was read (no reader, or not owner / admin). */
  written: boolean;
  byEmployee: Map<string, CertificateBankAccount>;
  /** One per employee whose account could not be written or lacks its holder (3245), naming them, never a number. */
  warnings: string[];
}

export async function loadCertificateBankAccounts(
  companyId: string, employees: Array<{ id: string; name: string }>, reader: CertificateBankReader | undefined,
): Promise<CertificateBankAccounts> {
  const byEmployee = new Map<string, CertificateBankAccount>();
  // As GET bank-details (assertHumanSession there): Login-as and tokens / jobs read no account; the file then has none.
  if (!reader || !isHistoryAdmin(reader.role) || !(await isHumanSession())) return { written: false, byEmployee, warnings: [] };
  const warnings: string[] = [];
  for (const e of employees) {
    const details = await getEmployeeBankDetails(companyId, e.id, reader.role);
    if (!details) continue; // pre-validation names an employee with no account
    if (details.masked) throw new Error('getEmployeeBankDetails returned a masked view to an owner / admin');
    await auditBankDetailsRead(companyId, reader.actor, details);
    const checked = bankAccountForCertificate(details);
    if ('problem' in checked) {
      warnings.push(`${e.name}: the bank account is not on the certificate, as ${checked.problem}. Correct it on the Bank details card.`);
      continue;
    }
    byEmployee.set(e.id, checked.account);
    if (checked.account.accountHolder === null) {
      warnings.push(`${e.name}: the bank account holder's name (code 3245) is not on the certificate: none is captured, or it is over `
        + '49 characters or holds a comma, pipe or double quote. e@syFile will ask for it.');
    }
  }
  return { written: true, byEmployee, warnings };
}
