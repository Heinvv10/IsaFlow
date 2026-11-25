/**
 * The suppliers a draft bill edit locks BEFORE the bill row (#1882 fix-verify, M2). A supplier merge takes both supplier rows FOR
 * UPDATE and then the source's bills; an edit that locked the bill first and then reached the new supplier (its apply's live lock,
 * its UPDATE's FK) deadlocked against a merge whose survivor that supplier is (bill on A moved to B while A merges into B). So a
 * supplier change takes the bill's current supplier (peeked unlocked) and the new one FOR KEY SHARE, in id order, first.
 *
 * The same shape for a bill's approval / post to GL (#1882 fix-verify L1): when a bank-first provisional settles it, the settlement
 * writes a supplier payment, and the claim's supplier lock came after the bill row; a merge of that supplier holds it and waits on
 * the bill. So a bill carrying a captured document (the only kind a provisional can settle) takes its supplier first.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockSupplierIfLive } from '../core/supplierLiveLock';
import { BillSupplierDeletedError } from './billSupplierLive';

/**
 * Null when the edit names no supplier (nothing locked here); 'not_found' when the named supplier is not this company's (or does not
 * exist: #1882 L-c, the caller's "Not found"). Otherwise the live suppliers it now holds, the new one ALWAYS, even when the unlocked
 * read already shows the bill on it (L-b: a merge of it must not slip between that read and the bill lock), and the bill's current
 * one when it differs. The caller checks the bill, once locked, still names one of them (a merge or another edit moved it: L-a, a
 * retry). A new supplier that is not live is the typed refusal; an old one merged away is simply not held.
 */
export async function lockSuppliersBeforeBill(companyId: string, invoiceId: string, newSupplierId: string | undefined): Promise<string[] | null | 'not_found'> {
  if (!newSupplierId) return null;
  // The bill first: absent or another company's is Not found before any supplier is locked (#1882 fix-verify L1).
  const [bill] = (await sql`
    SELECT supplier_id::TEXT AS supplier_id FROM supplier_invoices
     WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!bill) return 'not_found';
  const [named] = (await sql`
    SELECT 1 AS ok FROM suppliers WHERE id = ${newSupplierId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!named) return 'not_found';
  const ids = [...new Set([newSupplierId, String(bill.supplier_id)])].sort();
  const held: string[] = [];
  for (const id of ids) {
    const live = await lockSupplierIfLive(companyId, id);
    if (live) held.push(id);
    else if (id === newSupplierId) throw new BillSupplierDeletedError();
  }
  return held;
}

/**
 * Before a bill's approval / post locks the bill: its supplier FOR KEY SHARE when the bill carries a captured document (a provisional
 * may settle it). Liveness is the claim's to refuse (provisionalSettlementClaim); this only fixes the order. A merge that committed
 * meanwhile moved the bill: the lock here was on the merged-away row, and the claim then locks the survivor after the bill (rare).
 */
export async function lockSettlingPayeeBeforeBill(companyId: string, invoiceId: string): Promise<void> {
  const [bill] = (await sql`
    SELECT supplier_id::TEXT AS supplier_id FROM supplier_invoices
     WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID AND source_document_id IS NOT NULL
  `) as DbRow[];
  if (bill?.supplier_id) await lockSupplierIfLive(companyId, String(bill.supplier_id));
}

