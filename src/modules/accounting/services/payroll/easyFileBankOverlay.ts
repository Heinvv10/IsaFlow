/**
 * The EMP501 filing file's bank accounts, read live at download (wave 7 EA2; Hein's ruling 25). The version's stored
 * figures never carry an account (no account number at rest), so its stored or rebuilt file has none; an owner or admin
 * in their own session downloading it gets each certificate's account (3240-3246, BRS V25.3.0 pp. 45-46) read through
 * the audited reader (loadCertificateBankAccounts: one audit_log `export` row per account) and written into the bytes
 * served, at the place the record writer puts them (after the address codes that follow 3210), so the served file is
 * byte for byte the file the writer would build with the account on the certificate. An employee with no account on
 * record is 3240 = 0. The version's stamp (sha256) stays the hash of the stored file: the accounts are not part of
 * the figures a version freezes. A FILED version is re-served from exactly the rows its filing pinned (emp501BankPin:
 * the rows of the latest download, checked unchanged when it was marked filed; rows are insert-only), so its
 * re-download is the file submitted, byte for byte; a version not yet filed reads each employee's active row.
 */
import { certificateContactLines, type CertificateBankAccount } from './easyFileContactFields';
import { loadCertificateBankAccounts, type CertificateBankReader } from './easyFileBankAccounts';

/** Address codes the writer puts between 3210 and the bank fields (easyFileContactFields), any postal structure. */
const ADDRESS_CODES = new Set([3211, 3212, 3213, 3214, 3215, 3216, 3217, 3285, 3279, 3283, 3288, 3249, 3280, 3262, 3251,
  3253, 3254, 3286, 3255, 3256, 3257, 3258, 3259, 3260, 3261, 3287, 3289, 3290, 3291, 3292, 3293, 3294]);
const codeOf = (line: string): number => Number(line.slice(0, line.indexOf(',')));

/**
 * `body` with each certificate's bank lines inserted, by certificate number (3010). A certificate already carrying a
 * 3240 is left as it is; one not in `accounts` gets nothing. Pure.
 */
export function overlayBankAccounts(body: string, accounts: Map<string, CertificateBankAccount>): string {
  const lines = body.split('\r\n');
  const out: string[] = [];
  let pending: string[] = [];
  let afterPeriods = false;
  for (const line of lines) {
    const code = codeOf(line);
    if (code === 3010) {
      const account = accounts.get(line.slice(line.indexOf(',') + 2, -1)); // 3010,"<30 characters>"
      pending = account ? certificateContactLines({ bankAccount: account }) : [];
      afterPeriods = false;
    }
    if (code === 3240) pending = [];
    if (afterPeriods && !ADDRESS_CODES.has(code)) { out.push(...pending); pending = []; afterPeriods = false; }
    out.push(line);
    if (code === 3210 && pending.length > 0) afterPeriods = true;
  }
  return out.join('\r\n');
}

/**
 * The filing file's bytes with the accounts read live for `reader`, or as they are when the reader may not read them
 * (not owner / admin, not their own session) or the version names no employee per certificate (finalised before SS-c).
 */
export async function withLiveBankAccounts(
  companyId: string, body: string, certificateEmployees: Array<{ certificateNumber: string; employeeId: string }> | undefined,
  names: Map<string, string>, reader: CertificateBankReader | undefined,
  /** A filed version's pinned rows (emp501BankPin); absent = the active ones. */
  pinned?: Map<string, string | null>,
): Promise<{ body: string; rowIds: Map<string, string | null> | null }> {
  if (!certificateEmployees || certificateEmployees.length === 0) return { body, rowIds: null };
  const read = await loadCertificateBankAccounts(companyId,
    certificateEmployees.map((c) => ({ id: c.employeeId, name: names.get(c.certificateNumber) ?? '' })), reader, pinned);
  if (!read.written) return { body, rowIds: null };
  const byCertificate = new Map<string, CertificateBankAccount>();
  for (const c of certificateEmployees) {
    const account = read.byEmployee.get(c.employeeId);
    if (account) byCertificate.set(c.certificateNumber, account);
  }
  return { body: overlayBankAccounts(body, byCertificate), rowIds: read.rowIds };
}
