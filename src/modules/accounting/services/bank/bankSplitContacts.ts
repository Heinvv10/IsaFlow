/**
 * Split allocation lines that name a SUPPLIER or CUSTOMER instead of a GL account.
 *
 * One bank line can settle two contacts — a staff refund that is part the
 * claimant's own bill and part a merchant's slip bill, say — and before this a
 * split could only reach GL accounts. Splitting onto the AP/AR control account
 * as a plain GL line moves the control without a payment document, so the
 * subledger and the control drift apart by the split amount. These lines get
 * the same documents `allocateTransaction` mints for a whole line:
 *
 *   supplier, money out → payment (applied per `autoApply`, FIFO by default)
 *   supplier, money in  → refund (never applied — see supplierRefundDocument)
 *   customer, money in  → receipt (applied per `autoApply`)
 *   customer, money out → refund (never applied)
 *
 * Each document carries the split's journal, so `unwindBankAllocationApplication`
 * — which finds payments by `gl_journal_entry_id` — unwinds all of them when the
 * split is reversed. Nothing new has to be recorded for the reversal to be exact.
 *
 * A contact line SETTLES a document that already carried its VAT (K-016), so it
 * posts no VAT and carries no dimensions (brief §5.3): both are refused here,
 * from reads only, before the split writes anything.
 *
 * `planSplitContacts` runs every refusal before the first write; the
 * `recordSplitContactDocuments` writes run after the journal has posted and are
 * NOT caught — a throw takes the journal with it (see supplierAutoAllocate.ts).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import { assertCustomerInCompany, assertSupplierInCompany } from '../core/contactDirectoryService';
import { assertBankLineMayPaySupplier } from '../ap/bankLinePaymentGate';
import { planSupplierRefund, recordSupplierRefund } from '../ap/supplierRefundDocument';
import { recordSupplierBankPayment } from '../ap/supplierAutoAllocate';
import { planCustomerRefund, recordCustomerRefund } from '../ar/customerRefundDocument';
import { autoApplyCustomerReceipt } from '../ar/customerAutoAllocate';
import { DEFAULT_AUTO_APPLY, type AutoApplyMode } from '../shared/autoAllocateStrategy';
import { assertImporterMayAllocateAs } from './bankLineImporterGate';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import type { SplitLine } from './bankAllocationTypes';

export type SplitContactKind = 'supplier' | 'customer';

export interface PlannedSplitContact {
  /** Position of this line in the caller's `lines`. */
  index: number;
  kind: SplitContactKind;
  contactId: string;
  contactName: string;
  /** The AP or AR control account the line posts to. */
  controlAccountId: string;
  amount: number;
  description: string;
  autoApply: AutoApplyMode;
}

export interface SplitContactDocument {
  index: number;
  kind: SplitContactKind;
  contactId: string;
  /** What the cash became: a payment (supplier, out), receipt (customer, in) or refund. */
  document: 'payment' | 'receipt' | 'refund';
  paymentId: string;
  applications: { documentId: string; documentNumber: string; amount: number }[];
  onAccount: number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The contact a split line names, or null for a GL-account line. */
export function splitLineContact(line: SplitLine): { kind: SplitContactKind; contactId: string } | null {
  if (!line.contactType || !line.contactId) return null;
  return { kind: line.contactType, contactId: line.contactId };
}

/**
 * Every refusal for the contact lines of a split, from reads only. Returns the
 * plan the journal and the documents are built from.
 *
 * `tx` is the LOCKED bank row (`lockBankTransactionForUpdate`).
 */
export async function planSplitContacts(
  companyId: string, tx: DbRow, lines: readonly SplitLine[], userId: string,
): Promise<PlannedSplitContact[]> {
  const isSpent = Number(tx.amount) < 0;
  const txDate = fmtDate(tx.transaction_date);
  const planned: PlannedSplitContact[] = [];
  // A refund cannot exceed the credit the contact holds; two refund lines to
  // one contact are checked as their SUM, or each would pass on its own.
  const refundTotals = new Map<string, { kind: SplitContactKind; contactId: string; amount: number }>();

  for (const [index, line] of lines.entries()) {
    const contact = splitLineContact(line);
    if (!contact) continue;
    const amount = round2(Math.abs(Number(line.amount)));
    const docWord = contact.kind === 'supplier' ? 'bill' : 'invoice';
    if (line.vatCode && line.vatCode !== 'none') {
      throw new BankAllocationRefusal(
        `Split line ${index + 1} settles a ${contact.kind}: it carries no VAT (the ${docWord} already did) — omit vat_code`);
    }
    if (line.cc1Id || line.cc2Id || line.buId) {
      throw new BankAllocationRefusal(
        `Split line ${index + 1} settles a ${contact.kind}: a settlement carries no CC1/CC2/BU — tag the ${docWord} instead`);
    }
    let contactName: string;
    let controlAccountId: string;
    if (contact.kind === 'supplier') {
      await assertSupplierInCompany(companyId, contact.contactId);
      if (isSpent) await assertBankLineMayPaySupplier(companyId, tx, amount);
      const rows = (await sql`SELECT name FROM suppliers WHERE id = ${contact.contactId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
      contactName = rows.length > 0 ? String(rows[0]!.name) : `Supplier #${contact.contactId}`;
      controlAccountId = await getSystemAccountId('payable', companyId);
    } else {
      await assertCustomerInCompany(companyId, contact.contactId);
      const rows = (await sql`SELECT name FROM customers WHERE id = ${contact.contactId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
      contactName = rows.length > 0 ? String(rows[0]!.name) : `Customer #${contact.contactId}`;
      controlAccountId = await getSystemAccountId('receivable', companyId);
    }
    await assertImporterMayAllocateAs(companyId, tx, userId, contact.kind, contact.contactId);

    const isRefund = contact.kind === 'supplier' ? !isSpent : isSpent;
    if (isRefund) {
      const key = `${contact.kind}:${contact.contactId}`;
      const prior = refundTotals.get(key);
      refundTotals.set(key, { ...contact, amount: round2((prior?.amount ?? 0) + amount) });
    }
    const verb = contact.kind === 'supplier'
      ? (isSpent ? `Payment to ${contactName}` : `Refund from ${contactName}`)
      : (isSpent ? `Refund to ${contactName}` : `Receipt from ${contactName}`);
    planned.push({
      index, kind: contact.kind, contactId: contact.contactId, contactName, controlAccountId, amount,
      description: line.description || verb,
      autoApply: line.autoApply ?? DEFAULT_AUTO_APPLY,
    });
  }

  for (const r of refundTotals.values()) {
    if (r.kind === 'supplier') await planSupplierRefund(companyId, r.contactId, r.amount, txDate);
    else await planCustomerRefund(companyId, r.contactId, r.amount, txDate);
  }
  return planned;
}

/**
 * The documents for the contact lines of a POSTED split. Runs after the journal
 * and inside the caller's transaction; not caught.
 */
export async function recordSplitContactDocuments(args: {
  companyId: string;
  bankTxId: string;
  bankAccountId: string;
  bankReference: string | null;
  journalEntryId: string;
  isSpent: boolean;
  txDate: string;
  planned: readonly PlannedSplitContact[];
  userId: string;
}): Promise<SplitContactDocument[]> {
  const { companyId, bankTxId, bankAccountId, journalEntryId, isSpent, txDate, userId } = args;
  const out: SplitContactDocument[] = [];
  for (const p of args.planned) {
    const base = { index: p.index, kind: p.kind, contactId: p.contactId };
    if (p.kind === 'supplier' && isSpent) {
      const rec = await recordSupplierBankPayment({
        companyId, supplierId: p.contactId, bankTxId, bankAccountId, journalEntryId,
        amount: p.amount, paymentDate: txDate, description: p.description, userId, autoApply: p.autoApply,
      });
      out.push({
        ...base, document: 'payment', paymentId: rec.paymentId,
        applications: rec.appliedLines.map((l) => ({ documentId: l.invoiceId, documentNumber: l.invoiceNumber, amount: l.amount })),
        onAccount: rec.unappliedRemainder,
      });
    } else if (p.kind === 'supplier') {
      const ref = await recordSupplierRefund({
        companyId, supplierId: p.contactId, bankTxId, bankAccountId, journalEntryId,
        amount: p.amount, paymentDate: txDate, description: p.description, userId,
      });
      out.push({ ...base, document: 'refund', paymentId: ref.paymentId, applications: [], onAccount: ref.amount });
    } else if (isSpent) {
      const ref = await recordCustomerRefund({
        companyId, customerId: p.contactId, bankTxId, bankAccountId, journalEntryId,
        amount: p.amount, paymentDate: txDate, description: p.description, userId,
      });
      out.push({ ...base, document: 'refund', paymentId: ref.paymentId, applications: [], onAccount: ref.amount });
    } else {
      // The receipt row `allocateTransaction` inserts for a whole customer line,
      // for this line's share. created_by/confirmed_by go through resolveUserUuid
      // (uuid-typed, NOT NULL) as the refund writers do.
      const createdBy = await resolveUserUuid(userId);
      const rows = (await sql`
        INSERT INTO customer_payments (
          company_id, client_id, payment_date, total_amount, payment_method,
          bank_reference, bank_account_id, description, status,
          gl_journal_entry_id, created_by, confirmed_by, confirmed_at
        ) VALUES (
          ${companyId}::UUID, ${p.contactId}::UUID, ${txDate}, ${p.amount}, 'eft',
          ${args.bankReference}, ${bankAccountId}::UUID, ${p.description}, 'confirmed',
          ${journalEntryId}::UUID, ${createdBy}::UUID, ${createdBy}::UUID, NOW()
        )
        RETURNING id`) as DbRow[];
      const paymentId = String(rows[0]!.id);
      const applied = await autoApplyCustomerReceipt({
        companyId, customerId: p.contactId, paymentId, journalEntryId, amount: p.amount, userId, autoApply: p.autoApply,
      });
      out.push({
        ...base, document: 'receipt', paymentId,
        applications: applied.appliedLines.map((l) => ({ documentId: l.invoiceId, documentNumber: l.invoiceNumber, amount: l.amount })),
        onAccount: applied.unappliedRemainder,
      });
    }
  }
  return out;
}
