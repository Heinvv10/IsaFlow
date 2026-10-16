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
 * before anything is written: a split line (bankSplitDimensions), a whole-line
 * allocation to an account (allocateTransaction), a bank rule, and a
 * reconciliation adjustment's contra (createAdjustmentEntry).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { canonicalSubtype, type CanonicalSubtype } from '../gl/accountSubtypes';
import { BankAllocationRefusal } from './bankAllocationRefusal';

/** Each caller's own way to name the contact, named in its refusal. */
export type ContactControlRemedy = 'allocation' | 'split line' | 'rule' | 'adjustment';

const CONTACT_CONTROLS: Partial<Record<CanonicalSubtype, { name: string; who: 'supplier' | 'customer' }>> = {
  payable: { name: 'accounts payable', who: 'supplier' },
  receivable: { name: 'accounts receivable', who: 'customer' },
};

/**
 * The refusal for posting `what` straight onto an account of raw subtype
 * `rawSubtype`, or null when that account is not AP/AR control.
 */
export function contactControlRefusal(
  rawSubtype: unknown, what: string, how: ContactControlRemedy = 'allocation',
): BankAllocationRefusal | null {
  const canonical = canonicalSubtype(typeof rawSubtype === 'string' ? rawSubtype : null);
  const control = canonical ? CONTACT_CONTROLS[canonical] : undefined;
  if (!control) return null;
  // Each caller's own way to name the contact: a split line takes contactType + contactId (MCP: supplier_id /
  // customer_id); a whole line is allocated as a supplier / customer.
  const remedy = how === 'split line' ? `contactType '${control.who}' / ${control.who}_id`
    : how === 'rule' ? `set the rule's ${control.who}`
    : how === 'adjustment' ? `record a ${control.who === 'supplier' ? 'supplier payment' : 'customer receipt'} and reconcile that`
    : `allocate it as a ${control.who}`;
  return new BankAllocationRefusal(`${what} posts to the ${control.name} control account: name the ${control.who} `
    + `instead (${remedy}), so it gets its document`);
}

/** contactControlRefusal for an account named by id (company-scoped read); throws the refusal. */
export async function assertNotContactControl(
  companyId: string, accountId: string | null | undefined, what: string, how: ContactControlRemedy = 'allocation',
): Promise<void> {
  if (!accountId) return;
  const [row] = (await sql`
    SELECT account_subtype FROM gl_accounts WHERE id = ${accountId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const refusal = contactControlRefusal(row?.account_subtype, what, how);
  if (refusal) throw refusal;
}

/** The rule accounts among `ids` that are AP/AR control: one read per rule sweep (bankRulesMatchingService). */
export async function contactControlAccountIds(companyId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT id::TEXT AS id, account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...new Set(ids)]}::UUID[])
  `) as DbRow[];
  return new Set(rows.filter((r) => contactControlRefusal(r.account_subtype, '') !== null).map((r) => String(r.id).toLowerCase()));
}

/**
 * The bulk allocator's batch pre-check (MCP bulk_allocate_bank_transactions): for each account line whose account is
 * AP/AR control, the refusal allocateTransaction would raise, keyed by bank transaction. One read for the batch, so
 * a bad line is reported as a skip instead of unwinding every good line beside it.
 */
export async function contactControlLineSkips(
  companyId: string, lines: readonly { txId: string; accountId: string }[],
): Promise<Map<string, string>> {
  const skips = new Map<string, string>();
  if (lines.length === 0) return skips;
  const rows = (await sql`
    SELECT id::TEXT AS id, account_subtype FROM gl_accounts
    WHERE company_id = ${companyId}::UUID AND id = ANY(${[...new Set(lines.map((l) => l.accountId))]}::UUID[])
  `) as DbRow[];
  const subtypeOf = new Map(rows.map((r) => [String(r.id).toLowerCase(), r.account_subtype]));
  for (const l of lines) {
    const refusal = contactControlRefusal(subtypeOf.get(l.accountId.toLowerCase()), 'This allocation');
    if (refusal) skips.set(l.txId, refusal.message);
  }
  return skips;
}
