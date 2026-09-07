/**
 * Partitioning a bulk supplier-invoice batch into what will be created and what
 * is a repeat of something already in it.
 *
 * ── WHY A SKIP AND NOT A REFUSAL ────────────────────────────────────────────
 *
 * Two elements carrying the same `(supplier_id, invoice_number)` are one bill
 * sent twice: a supplier does not issue one number twice, and the AP service
 * has no such constraint, so it would cheerfully create both. That guard is
 * right. Refusing the other 99 bills over it is not — the Velocity Fibre reload
 * had to find and renumber 14 such pairs in a Sage export by hand before any
 * batch would run, which is the bisect-it-yourself labour the bulk tool exists
 * to remove. `bulkAllocationSkip` already draws the line this module follows: a
 * fact about the DATA is a skip with a reason; a fault in the REQUEST is a
 * refusal.
 *
 * ── WHY THIS IS SAFE HERE AND WOULD NOT BE MID-WRITE ────────────────────────
 *
 * Everything here happens in the PARSE pass, before the ownership queries and
 * before the first INSERT, so an element set aside has written nothing and the
 * caller still returns normally. A skip decided after writing had begun would
 * RELEASE the registry's savepoint and commit a partial batch under a
 * success-shaped reply — which is why the create loop still throws.
 *
 * ── SPLIT OUT TO KEEP THE CALLER UNDER THE 300-LINE CAP ─────────────────────
 *
 * Same reason `allocationVatGuard` was split from `allocationLine`.
 */

import { parseSupplierInvoiceInput, type ParsedSupplierInvoice } from './invoiceCreateArgs';
import { DEFAULT_SUPPLIER_TAX_RATE } from '@/modules/accounting/constants/supplierInvoiceDefaults';

/** One element that will be created, carrying the CALLER's index. */
export interface KeptInvoice {
  /** Index into the caller's own `invoices` array — NOT the position here. */
  index: number;
  inv: ParsedSupplierInvoice;
}

export interface PartitionedBatch {
  kept: KeptInvoice[];
  skipped: Record<string, unknown>[];
  /** DISTINCT ids for the caller's one-query-per-kind ownership check. */
  supplierIds: Set<string>;
  accountIds: Set<string>;
}

/**
 * Split the batch, or return the refusal TEXT for a malformed element.
 *
 * A string result is a refusal, never a skip: a payload of the wrong shape is a
 * fault in the request, and a caller cannot act on a batch that half-ran
 * because one element did not parse.
 *
 * ── WHAT COUNTS AS A REPEAT, AND WHY THE PAIR IS NOT ENOUGH ─────────────────
 *
 * Matching on `(supplier_id, invoice_number)` alone SILENTLY DROPS REAL MONEY.
 * Two elements naming the same bill number but different amounts are a
 * numbering error in the source, not a duplicated element — and skipping the
 * second discards an AP obligation with an HTTP 200 and nothing to find it by.
 * `[{A, "INV-1001", R1,000}, {A, "INV-1001", R48,500}]` would have created the
 * R1,000 bill and thrown the other away.
 *
 * The repo's own definition of a duplicate bill already includes the amount:
 * migration 412 fingerprints `(vat_number, invoice_number, total_amount)` and
 * `supplierInvoiceService` computes exactly that on every insert. A guard
 * weaker than the one the books use is not a guard.
 *
 * So a repeat must be IDENTICAL — the whole parsed element, lines included, not
 * a computed total. Comparing the payload rather than re-deriving an amount
 * keeps this from drifting away from the service's own rounding, and it is
 * strictly safer: only an exact re-send is skipped. That is precisely the case
 * this exists for, a Sage export re-emitting the same row.
 *
 * Two elements that agree on the pair and disagree on anything else are a
 * REFUSAL. The caller has sent two different bills under one number and only it
 * knows which is right; guessing is the failure mode, not the fix.
 *
 * The FIRST occurrence is kept because the caller's order is the only thing
 * distinguishing identical copies. The pair still matters: two suppliers may
 * each issue their own INV-1, and collapsing those would drop a genuine bill.
 *
 * Note `kept` is never empty for a non-empty batch that parses: the first
 * occurrence of every key is always kept, so this can never produce a
 * nothing-to-do batch the way `bulkAllocationSkip` can.
 */
/**
 * Everything about an element that decides whether another is the SAME bill.
 *
 * The whole parsed payload, not a derived total: re-deriving the amount here
 * would be a second implementation of the service's rounding, free to drift
 * from it. Key order is fixed by the parser, so `JSON.stringify` is stable.
 */
function fingerprint(inv: ParsedSupplierInvoice): string {
  return JSON.stringify(normalise(inv));
}

/**
 * Resolve the ONE default that makes two different payloads the same bill.
 *
 * `tax_rate` omitted and `tax_rate: 15` produce identical invoices — the
 * service applies `?? DEFAULT_SUPPLIER_TAX_RATE` — so comparing the raw parsed
 * elements refused a pair that WAS a duplicate. A false refusal blocks a
 * legitimate batch, which is the friction this tool exists to remove.
 *
 * The constant is IMPORTED, never restated: a local `?? 15` here would drift
 * silently the day the service's default changed, and re-deriving values is the
 * mistake this file already refuses to make with totals.
 *
 * Only the CONSTANT default is resolved. `dueDate` is also defaulted, but from
 * `calculateDueDate(invoiceDate, paymentTerms)` — reimplementing that to
 * compare two elements would be a second implementation of a business rule, so
 * an omitted vs explicitly-equal due date stays a refusal. It is the safe
 * direction: a refusal writes nothing and now names the field.
 */
function normalise(inv: ParsedSupplierInvoice): ParsedSupplierInvoice {
  return { ...inv, taxRate: inv.taxRate ?? DEFAULT_SUPPLIER_TAX_RATE };
}

/**
 * Which fields two same-numbered elements actually disagree on.
 *
 * The refusal used to assert they "differ in their amounts, dates or lines"
 * because those are the differences worth refusing over — but the comparison is
 * the WHOLE element, so a pair differing only in `notes` was refused with a
 * message naming three fields that were identical. A refusal an agent cannot
 * act on is the defect class this connector exists to remove, so the message
 * names what actually differs.
 *
 * `accountIds` is derived from `items` and never differs on its own, so it is
 * dropped rather than reported as a second, redundant difference.
 */
function differingFields(a: ParsedSupplierInvoice, b: ParsedSupplierInvoice): string[] {
  // The NORMALISED pair, or the message names a field the comparison ignores.
  const [x, y] = [normalise(a), normalise(b)];
  const keys = Object.keys(x) as (keyof ParsedSupplierInvoice)[];
  return keys
    .filter((k) => k !== 'accountIds')
    .filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
}

export function partitionSupplierInvoiceBatch(
  batch: readonly Record<string, unknown>[],
): PartitionedBatch | string {
  const kept: KeptInvoice[] = [];
  const skipped: Record<string, unknown>[] = [];
  const supplierIds = new Set<string>();
  const accountIds = new Set<string>();
  const seenAt = new Map<string, { index: number; inv: ParsedSupplierInvoice; fingerprint: string }>();

  for (let i = 0; i < batch.length; i++) {
    const one = parseSupplierInvoiceInput(batch[i]!);
    if (typeof one === 'string') return `invoices[${i}].${one}`;

    // A separator that cannot occur inside either half. Both ids are trimmed by
    // the parser, and an invoice number may legitimately contain a space — so
    // joining on one would let ("SUP A", "1") and ("SUP", "A 1") collide and
    // silently drop the second bill. A newline cannot appear in either.
    const key = `${one.supplierId}\n${one.invoiceNumber}`;
    const first = seenAt.get(key);
    if (first !== undefined) {
      // IDENTICAL, or it is not a repeat. Same number with a different amount
      // is two different bills, and skipping one of those loses money silently.
      if (fingerprint(one) !== first.fingerprint) {
        const differs = differingFields(first.inv, one);
        return `invoices[${i}] and invoices[${first.index}] both carry invoice_number `
          + `${JSON.stringify(one.invoiceNumber)} for the same supplier but are NOT the `
          + `same bill — they differ in: ${differs.join(', ')}. One number cannot name `
          + 'two bills: correct the numbering, or combine them if they belong on one.';
      }
      skipped.push({
        index: i,
        invoice_number: one.invoiceNumber,
        supplier_id: one.supplierId,
        reason: `invoices[${first.index}] is an identical bill — same supplier, same `
          + `invoice_number ${JSON.stringify(one.invoiceNumber)}, same lines and amounts. `
          + 'A supplier does not issue one number twice, so this element was not created.',
      });
      continue;
    }
    seenAt.set(key, { index: i, inv: one, fingerprint: fingerprint(one) });
    supplierIds.add(one.supplierId);
    for (const id of one.accountIds) accountIds.add(id);
    kept.push({ index: i, inv: one });
  }

  return { kept, skipped, supplierIds, accountIds };
}
