/**
 * How big a Sage company one take-on may hold. The import runs in ONE request
 * (Cloudflare cuts it at 100 s), so the caps are its time budget, measured on
 * the one-cluster integration harness (2026-10-21):
 *
 *   documents (wizard document + journal each): 600 documents / 300 contacts
 *     ~10-12 s at load 12-25, ~16-21 s at load 26-34; 900 ~25 s; 1 200 ~58 s;
 *     2 400 ~73 s; 5 000 did not finish in 900 s. Faster than linear.
 *   contacts alone: 1 000 ~0.4-0.6 s, 2 000 ~1.1 s; 2 000 / 5 000 contacts
 *     beside the 600-document worst case 18.6 / 16.6 s (load 26-34).
 *
 * The worst case inside the caps is 300 unpaid invoices + 300 balance-brought-
 * forward documents (one per contact owing) = 600 documents, beside 2 000
 * contacts. A bigger company uses the Migration Wizard's file upload. The pull
 * refuses with these rules before reading documents, and the import refuses a
 * stored pull with them again (a review read under older caps).
 */
import type { SagePull } from './sageApiTypes';

export const MAX_CONTACTS = 2000;
export const MAX_CONTACTS_WITH_BALANCES = 300;
/** Unpaid customer invoices and supplier bills together. */
export const MAX_OUTSTANDING_INVOICES = 300;

/** The contacts a take-on imports (sageTakeOnContacts): active ones, and any carrying a balance. */
export const isTakenOn = (c: { Active: boolean; Balance: number }): boolean => c.Active || Math.abs(c.Balance) > 0.005;

export interface PullSizes {
  /** Contacts the take-on imports. */
  contacts: number;
  /** Contacts with a positive balance: their documents are read, and each may need a brought-forward document. */
  owing: number;
  /** Unpaid invoices and bills, both lists. */
  invoices: number;
}

const WIZARD = "Use the Migration Wizard's file upload (Accounting → Migration) for this company: it takes Sage's reports in batches.";

/** Why a company this size cannot be taken on in one import, or null. */
export function pullSizeRefusal(s: PullSizes): string | null {
  if (s.contacts > MAX_CONTACTS) {
    return `This Sage company has ${s.contacts} customers and suppliers to bring across, more than the ${MAX_CONTACTS} Import from Sage takes on in one go. ${WIZARD}`;
  }
  if (s.owing > MAX_CONTACTS_WITH_BALANCES) {
    return `This Sage company has ${s.owing} customers and suppliers with open balances, more than the ${MAX_CONTACTS_WITH_BALANCES} Import from Sage takes on in one go. ${WIZARD}`;
  }
  if (s.invoices > MAX_OUTSTANDING_INVOICES) {
    return `This Sage company has more than ${MAX_OUTSTANDING_INVOICES} unpaid invoices and bills, more than Import from Sage takes on in one go. ${WIZARD}`;
  }
  return null;
}

export function sizesOf(pull: SagePull): PullSizes {
  const contacts = [...pull.customers, ...pull.suppliers];
  return {
    contacts: contacts.filter(isTakenOn).length,
    owing: contacts.filter((c) => c.Balance > 0.005).length,
    invoices: pull.customerInvoices.length + pull.supplierInvoices.length,
  };
}
