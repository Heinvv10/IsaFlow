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
 *     overpaid) cannot be taken on as a document and is reported, with what it
 *     does to the control account.
 *
 * Fail closed on what cannot be taken on as a home-currency invoice: an
 * outstanding document that is not one of Sage's still-owed tax invoices /
 * supplier invoices (a credit note, a receipt, an opening balance — matched by
 * ID and number, see sageApiPullService) is LEFT OUT with a warning naming it
 * and its amount; a contact or document in another currency (sageCurrency,
 * which fails closed) blocks the import.
 */
import type { SageCustomer, SageInvoiceRef, SageOutstandingDocument, SageSupplier } from './sageApiTypes';
import { foreignCurrency, type CurrencyRule } from './sageCurrency';
import { isTakenOn } from './sagePullLimits';
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
  const wanted = list.filter(isTakenOn);
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

const invoiceKey = (id: number, number: string | undefined) => `${id}|${(number ?? '').trim()}`;

/** What the documents of one kind are checked against. */
export interface ContactRules {
  /** Sage's still-owed invoices of this kind (tax invoices / supplier invoices). */
  invoices: readonly SageInvoiceRef[];
  /** The home currency; a contact or document in another is refused. */
  currency: CurrencyRule;
}

/**
 * The outstanding documents that can be taken on as invoices. One that is not
 * among Sage's unpaid invoices (a credit note, an unallocated receipt, an
 * opening-balance entry), or one with nothing due, is LEFT OUT with a warning
 * naming it and its amount (Hein, 2026-10-21): the contact's balance still
 * decides what comes across, so the item's effect is already in it and must
 * not be captured again. A foreign-currency document blocks.
 */
function invoicesOnly(
  name: string, docs: SageOutstandingDocument[], kind: ContactKind, invoices: ReadonlySet<string>,
  homeCurrency: CurrencyRule, issues: TakeOnIssue[],
): SageOutstandingDocument[] {
  const area = kind === 'customer' ? 'receivables' : 'payables';
  const invoice = kind === 'customer' ? 'tax invoice' : 'supplier invoice';
  const kept: SageOutstandingDocument[] = [];
  for (const d of docs) {
    const label = d.DocumentNumber?.trim() || `#${d.ID}`;
    const rate = kind === 'customer' ? d.Customer_ExchangeRate : d.Supplier_ExchangeRate;
    const currencyId = kind === 'customer' ? d.Customer_CurrencyId : d.Supplier_CurrencyId;
    const foreign = foreignCurrency(currencyId, null, homeCurrency);
    if (foreign || (rate != null && Math.abs(rate - 1) > 0.000001)) {
      issues.push({
        severity: 'error', area,
        message: `${label} for ${kind} "${name}" is in a foreign currency (${foreign ?? `exchange rate ${rate}`}). Import from Sage takes on home-currency balances only; use the file upload for this company.`,
      });
    } else if (d.AmountDue <= 0.005 || !invoices.has(invoiceKey(d.ID, d.DocumentNumber))) {
      const why = d.AmountDue <= 0.005
        ? 'Sage shows nothing owing on it'
        : `it is not an unpaid ${invoice} in Sage — usually a credit note, an unallocated receipt or an opening balance`;
      issues.push({
        severity: 'warning', area,
        message: `${label} (${formatRand(d.AmountDue)} outstanding, document type ${d.DocumentTypeId ?? 'not given'}) for ${kind} "${name}" was left out: ${why}. Its effect is already included in ${name}'s Sage balance, which comes across in full, so do not capture it again in IsaFlow.`,
      });
    } else {
      kept.push(d);
    }
  }
  return kept;
}

function documentsFor(
  name: string, sageId: number, balance: number, docs: SageOutstandingDocument[],
  kind: ContactKind, asAtDate: string,
): TakeOnDocument[] {
  const open = [...docs]
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
  rules: ContactRules,
  issues: TakeOnIssue[],
): ContactsPart {
  const area = kind === 'customer' ? 'customers' : 'suppliers';
  const selected = selectContacts(list, kind, issues);
  const invoices = new Set(rules.invoices.map((i) => invoiceKey(i.ID, i.DocumentNumber)));
  const docs: TakeOnDocument[] = [];
  for (const { c, name } of selected) {
    const balance = round2(c.Balance);
    const foreign = foreignCurrency(c.CurrencyId, c.CurrencySymbol, rules.currency);
    if (foreign) {
      issues.push({
        severity: 'error', area,
        message: `${kind === 'customer' ? 'Customer' : 'Supplier'} "${name}" is kept in ${foreign} in Sage, not ${rules.currency.homeCode}. Import from Sage takes on home-currency contacts only; use the file upload for this company.`,
      });
      continue;
    }
    if (balance < -0.005) {
      const amount = formatRand(-balance);
      issues.push({
        severity: 'warning',
        area,
        message: kind === 'customer'
          ? `Customer "${name}" is in credit by ${amount} in Sage. A credit cannot be taken on as an invoice, so IsaFlow's Trade Receivables will be ${amount} higher than Sage's, and Opening Balance Equity carries the ${amount} difference, until you capture it as a credit note or unallocated receipt after the import.`
          : `Supplier "${name}" owes you ${amount} in Sage (a debit balance). That cannot be taken on as a bill, so IsaFlow's Trade Payables will be ${amount} higher than Sage's, and Opening Balance Equity carries the ${amount} difference, until you capture it as a supplier credit after the import.`,
      });
      continue;
    }
    if (balance > 0.005) {
      const open = invoicesOnly(name, documents[c.ID] ?? [], kind, invoices, rules.currency, issues);
      docs.push(...documentsFor(name, c.ID, balance, open, kind, asAtDate));
    }
  }
  return {
    contacts: selected.map(({ c, name }) => toContact(c, name)),
    documents: docs,
    documentsTotal: round2(docs.reduce((s, d) => s + d.totalAmount - d.amountPaid, 0)),
  };
}
