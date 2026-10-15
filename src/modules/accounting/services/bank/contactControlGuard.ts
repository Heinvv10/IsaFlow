/**
 * AP and AR control are a contact's accounts. A bank line posted straight onto
 * one moves the control with no payment, receipt or refund document behind it,
 * so the subledger drifts from the control by that amount and
 * `reconcile_subledger` reports it as a posting with no document.
 *
 * The way to post cash there is to name the supplier or customer: the
 * allocation then records its document (allocateTransaction's supplier and
 * customer arms, a split's contact line). Both posting paths that take a GL
 * account from the caller refuse the control accounts here, from a read,
 * before anything is written: a split line (bankSplitDimensions) and a
 * whole-line allocation to an account (allocateTransaction).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { canonicalSubtype, type CanonicalSubtype } from '../gl/accountSubtypes';
import { BankAllocationRefusal } from './bankAllocationRefusal';

const CONTACT_CONTROLS: Partial<Record<CanonicalSubtype, { name: string; who: 'supplier' | 'customer' }>> = {
  payable: { name: 'accounts payable', who: 'supplier' },
  receivable: { name: 'accounts receivable', who: 'customer' },
};

/**
 * The refusal for posting `what` straight onto an account of raw subtype
 * `rawSubtype`, or null when that account is not AP/AR control.
 */
export function contactControlRefusal(rawSubtype: unknown, what: string): BankAllocationRefusal | null {
  const canonical = canonicalSubtype(typeof rawSubtype === 'string' ? rawSubtype : null);
  const control = canonical ? CONTACT_CONTROLS[canonical] : undefined;
  if (!control) return null;
  return new BankAllocationRefusal(`${what} posts to the ${control.name} control account: name the ${control.who} `
    + `instead (allocate it as a ${control.who}), so it gets its document`);
}

/** contactControlRefusal for an account named by id (company-scoped read); throws the refusal. */
export async function assertNotContactControl(companyId: string, accountId: string | null | undefined, what: string): Promise<void> {
  if (!accountId) return;
  const [row] = (await sql`
    SELECT account_subtype FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const refusal = contactControlRefusal(row?.account_subtype, what);
  if (refusal) throw refusal;
}
