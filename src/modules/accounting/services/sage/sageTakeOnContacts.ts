/**
 * Sage customers / suppliers and their outstanding documents → the contact
 * and take-on document rows of the migration wizard.
 *
 * The contact's Sage BALANCE is the truth: on a live company the per-contact
 * balances summed exactly to the Trade Receivables / Payables control lines,
 * while the outstanding-document list can be short (unallocated receipts,
 * opening balances captured without documents). So each contact's documents
 * are made to add up to its balance:
 *   - an unallocated credit is applied to the oldest documents first (it
 *     raises their amountPaid);
 *   - a balance with too few documents gets one "balance brought forward"
 *     document for the rest;
 *   - a balance on the wrong side (a customer in credit, a supplier we
 *     overpaid) cannot be taken on as a document and is reported.
 */
import type { SageCustomer, SageOutstandingDocument, SageSupplier } from './sageApiTypes';
import { formatRand, round2, type TakeOnIssue } from './sageTakeOnTypes';

export type ContactKind = 'customer' | 'supplier';

export interface TakeOnContact {
  sageId: number;
  name: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  registrationNumber?: string;
  billingAddress?: string;
  contactPerson?: string;
  creditLimit?: number;
}

export interface TakeOnDocument {
  contactName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  amountPaid: number;
  reference?: string;
}

export interface ContactsPart {
  contacts: TakeOnContact[];
  documents: TakeOnDocument[];
  /** Sum of what the documents leave outstanding. */
  documentsTotal: number;
}

const day = (iso: string | undefined): string => (iso ?? '').slice(0, 10);
const text = (s: string | undefined): string | undefined => (s && s.trim() ? s.trim() : undefined);

function toContact(c: SageCustomer | SageSupplier, name: string): TakeOnContact {
  const address = [c.PostalAddress01, c.PostalAddress02, c.PostalAddress03, c.PostalAddress04, c.PostalAddress05]
    .map(text).filter(Boolean).join(', ');
  const limit = 'CreditLimit' in c ? c.CreditLimit : undefined;
  return {
    sageId: c.ID,
    name,
    email: text(c.Email),
    phone: text(c.Telephone) ?? text(c.Mobile),
    vatNumber: text(c.TaxReference),
    registrationNumber: text(c.BusinessRegistrationNumber),
    billingAddress: address || undefined,
    contactPerson: text(c.ContactName),
    creditLimit: limit && limit > 0 ? limit : undefined,
  };
}

/** Which contacts to keep, and the name each is imported under. */
function selectContacts(list: (SageCustomer | SageSupplier)[], kind: ContactKind, issues: TakeOnIssue[]) {
  const area = kind === 'customer' ? 'customers' : 'suppliers';
  const wanted = list.filter((c) => c.Active || Math.abs(c.Balance) > 0.005);
  const groups = new Map<string, (SageCustomer | SageSupplier)[]>();
  for (const c of wanted) {
    const key = c.Name.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const nameOf = new Map<number, string>();
  for (const members of groups.values()) {
    if (members.length === 1) { nameOf.set(members[0]!.ID, members[0]!.Name.trim()); continue; }
    const withBalance = members.filter((m) => Math.abs(m.Balance) > 0.005);
    const kept = withBalance.length > 0 ? withBalance : [members.reduce((a, b) => (a.ID <= b.ID ? a : b))];
    for (const m of members) {
      if (!kept.includes(m)) {
        issues.push({ severity: 'warning', area, message: `Sage has two ${kind}s called "${m.Name.trim()}"; the one with no balance (Sage #${m.ID}) was left out.` });
      }
    }
    for (const m of kept) nameOf.set(m.ID, kept.length > 1 ? `${m.Name.trim()} (Sage ${m.ID})` : m.Name.trim());
    if (kept.length > 1) {
      issues.push({ severity: 'warning', area, message: `Sage has ${kept.length} ${kind}s called "${members[0]!.Name.trim()}" with balances; they were imported with their Sage number after the name so they stay apart. Rename them after the import.` });
    }
  }
  return wanted.filter((c) => nameOf.has(c.ID)).map((c) => ({ c, name: nameOf.get(c.ID)! }));
}

function documentsFor(
  name: string, sageId: number, balance: number, docs: SageOutstandingDocument[],
  kind: ContactKind, asAtDate: string,
): TakeOnDocument[] {
  const open = docs
    .filter((d) => d.AmountDue > 0.005)
    .sort((a, b) => day(a.Date).localeCompare(day(b.Date)) || a.DocumentNumber.localeCompare(b.DocumentNumber));
  const out: TakeOnDocument[] = open.map((d) => {
    const total = round2(d.Total);
    const tax = round2(d.Tax ?? 0);
    return {
      contactName: name,
      invoiceNumber: d.DocumentNumber?.trim() || `SAGE-${d.ID}`,
      invoiceDate: day(d.Date),
      dueDate: day(d.DueDate) || day(d.Date),
      subtotal: d.Exclusive != null ? round2(d.Exclusive) : round2(total - tax),
      taxAmount: tax,
      totalAmount: total,
      amountPaid: Math.max(0, round2(total - d.AmountDue)),
      reference: text(d.Reference),
    };
  });
  let excess = round2(out.reduce((s, d) => s + d.totalAmount - d.amountPaid, 0) - balance);
  for (const d of out) {
    if (excess <= 0) break;
    const apply = Math.min(excess, round2(d.totalAmount - d.amountPaid));
    d.amountPaid = round2(d.amountPaid + apply);
    excess = round2(excess - apply);
  }
  if (excess < 0) {
    const amount = -excess;
    out.push({
      contactName: name,
      invoiceNumber: `SAGE-BF-${kind === 'customer' ? 'C' : 'S'}${sageId}`,
      invoiceDate: asAtDate,
      dueDate: asAtDate,
      subtotal: amount,
      taxAmount: 0,
      totalAmount: amount,
      amountPaid: 0,
      reference: 'Balance brought forward from Sage',
    });
  }
  return out;
}

export function buildContacts(
  list: (SageCustomer | SageSupplier)[],
  documents: Record<number, SageOutstandingDocument[]>,
  kind: ContactKind,
  asAtDate: string,
  issues: TakeOnIssue[],
): ContactsPart {
  const area = kind === 'customer' ? 'customers' : 'suppliers';
  const selected = selectContacts(list, kind, issues);
  const docs: TakeOnDocument[] = [];
  for (const { c, name } of selected) {
    const balance = round2(c.Balance);
    if (balance < -0.005) {
      issues.push({
        severity: 'warning',
        area,
        message: kind === 'customer'
          ? `Customer "${name}" is in credit by ${formatRand(-balance)} in Sage. A credit cannot be taken on as an invoice — capture it as a credit note or unallocated receipt after the import.`
          : `Supplier "${name}" owes you ${formatRand(-balance)} in Sage (a debit balance). That cannot be taken on as a bill — capture it as a supplier credit after the import.`,
      });
      continue;
    }
    if (balance > 0.005) docs.push(...documentsFor(name, c.ID, balance, documents[c.ID] ?? [], kind, asAtDate));
  }
  return {
    contacts: selected.map(({ c, name }) => toContact(c, name)),
    documents: docs,
    documentsTotal: round2(docs.reduce((s, d) => s + d.totalAmount - d.amountPaid, 0)),
  };
}
