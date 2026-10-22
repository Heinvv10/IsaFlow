/**
 * Who changed WHERE a supplier's money goes, recorded as an author of the
 * payments it changes (R-035 PR5; Hein, 2026-10-06: whoever sets the amount or
 * the destination of the money is an author, and may not approve sending it).
 *
 * A payment's approval digest reads the payee's bank details LIVE (migration
 * 867): they are not copied onto the payment, and eft-generate / netcash read
 * them at send time. So an edit of a supplier's bank details moves the digest
 * of every unpaid payment to that supplier, and of every batch carrying one —
 * the approval goes stale (fail closed) — and its editor joins their authors
 * here, append-only, so they cannot approve the re-submitted payment either.
 * They also join the supplier's `bank_details_setters` (decision (b), made
 * append-only in round 1), which the authors function derives into payments
 * created AFTER the edit. Paid payments are history and are left alone.
 * Creating a payment stamps nothing (its creator is created_by).
 *
 * Lock order (bank/.claude.md): batches (id order), then suppliers, then member
 * payments. The bank-file gate (eft-generate, netcash/submit) holds the batch
 * row and then share-locks its payee suppliers, and approveBatch / processBatch
 * take batch then members, so every writer here takes the batches BEFORE the
 * supplier row (`lockBatchesBeforeSuppliers`): a supplier first, then a batch,
 * was a 40P01 cycle against the gate.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** The batches `recordBankDetailsSetter` stamps: money not yet moved. */
const STAMPED_BATCH_STATUSES = ['draft', 'approved'] as const;
const MAX_LOCK_ATTEMPTS = 5;
const BANK_COLUMNS = ['bank_name', 'bank_account_number', 'bank_branch_code', 'bank_account_type', 'bank_account_holder'] as const;
/**
 * A new DESTINATION: only the account number resets the setters to its editor.
 * Not the branch code (round 2): an innocent "fix" to the universal branch code
 * would otherwise drop whoever redirected the number, who then approves.
 */
const DESTINATION_COLUMNS = ['bank_account_number'] as const;

/**
 * The supplier's bank details, under a row lock held to the end of the request
 * (the row updateSupplier, the take-on overwrite and both merges lock). Read
 * BEFORE the UPDATE so the change is judged against the row actually replaced:
 * a concurrent edit the lock waited for is in it (round 1 — the statement
 * snapshot the UPDATE's own RETURNING saw was the row before that edit, so a
 * non-bank edit could pass for a bank change). Null: no such supplier.
 *
 * `bankMayChange`: the write names a bank column, so `recordBankDetailsSetter`
 * will stamp the batches paying this supplier. They are locked first
 * (`lockBatchesBeforeSuppliers`); a write that cannot change a bank detail
 * takes the supplier row alone and waits for no batch.
 */
export async function lockSupplierBankDetails(companyId: string, supplierId: string, bankMayChange: boolean): Promise<DbRow | null> {
  const lockRow = async () => ((await sql`
    SELECT bank_name, bank_account_number, bank_branch_code, bank_account_type, bank_account_holder
    FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[])[0] ?? null;
  return bankMayChange ? lockBatchesBeforeSuppliers(companyId, [supplierId], STAMPED_BATCH_STATUSES, lockRow) : lockRow();
}

export type BankDetailsChange = 'none' | 'appended' | 'repointed';

/** An account number as a destination: its digits ("62-000 001" is 62000001), as supplier_bank_fingerprint reads it. */
const destination = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/**
 * What an UPDATE did to the bank details: nothing; a change to the account
 * NUMBER's digits ('repointed' — a new destination); or a change to any other
 * bank column, the branch code included, or a re-typing of the same account
 * digits ('appended'). Judging the destination on its digits — the
 * normalisation migration 876's fingerprint uses — means re-entering the same
 * number with spaces cannot reset the setters and shed whoever redirected it.
 * A column the returned row does not carry counts as unchanged.
 */
export function bankDetailsChange(before: DbRow, after: DbRow): BankDetailsChange {
  const moved = (c: string) => c in after && (before[c] ?? null) !== (after[c] ?? null);
  if (DESTINATION_COLUMNS.some((c) => c in after && destination(before[c]) !== destination(after[c]))) return 'repointed';
  return BANK_COLUMNS.some(moved) ? 'appended' : 'none';
}

/** True when the supplier row carries any bank detail (a create that sets where money goes). */
export function hasBankDetails(row: DbRow): boolean {
  return [row.bank_name, row.bank_account_number, row.bank_branch_code, row.bank_account_type]
    .some((v) => v != null && v !== '');
}

/**
 * Lock the batches carrying `supplierId`'s payments in `statuses`, in id order,
 * BEFORE their members are written — batch then members, as approveBatch and
 * processBatch take them. Returns their ids. The caller already holds them,
 * taken before the supplier row by `lockBatchesBeforeSuppliers`: this is the
 * re-lock that yields the ids, and it must never be the first lock on a batch
 * of a supplier this transaction has locked.
 */
export async function lockBatchesPayingSupplier(companyId: string, supplierId: string,
  statuses: readonly string[] | null): Promise<string[]> {
  const rows = (await sql`
    SELECT b.id FROM supplier_payment_batches b
    WHERE b.company_id = ${companyId}::UUID
      AND (${statuses === null} OR b.status = ANY(${statuses ?? []}::TEXT[]))
      AND b.id IN (SELECT sp.batch_id FROM supplier_payments sp
                   WHERE sp.company_id = ${companyId}::UUID AND sp.supplier_id = ${supplierId}::UUID
                     AND sp.batch_id IS NOT NULL)
    ORDER BY b.id
    FOR UPDATE OF b
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** Raised inside the savepoint to give back the locks of an attempt whose batch set was out of date. */
class BatchSetGrew extends Error {
  constructor(readonly batchIds: string[]) {
    super('a batch started paying the supplier after the batches were read');
    this.name = 'BatchSetGrew';
  }
}

async function batchIdsPayingSuppliers(companyId: string, supplierIds: readonly string[],
  statuses: readonly string[] | null): Promise<string[]> {
  const rows = (await sql`
    SELECT b.id FROM supplier_payment_batches b
    WHERE b.company_id = ${companyId}::UUID
      AND (${statuses === null} OR b.status = ANY(${statuses ?? []}::TEXT[]))
      AND b.id IN (SELECT sp.batch_id FROM supplier_payments sp
                   WHERE sp.company_id = ${companyId}::UUID AND sp.supplier_id = ANY(${supplierIds}::UUID[])
                     AND sp.batch_id IS NOT NULL)
    ORDER BY b.id
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/**
 * Take the batches paying `supplierIds` (in `statuses`, null = any) `FOR UPDATE` in id order, THEN run
 * `lockSuppliers` (the caller's own `FOR UPDATE` on the supplier rows): batch before supplier, the order the
 * bank-file gate takes them in (`batchBankFileGate`: batch row, then its payees `FOR SHARE`). The reverse order
 * deadlocked against it (40P01).
 *
 * The batches are read unlocked, locked, and the suppliers locked; with the suppliers held no payment can be
 * added to or moved off them (the FK's KEY SHARE and the merge's row lock both wait), so the batch set is re-read
 * then. A batch that started paying them in between would have to be locked AFTER the supplier, so the attempt is
 * rolled back whole (its savepoint gives the supplier AND the batch locks back, keeping id order) and retried
 * with that batch in the set. Bounded: a set that keeps growing is an error, not a spin.
 */
export async function lockBatchesBeforeSuppliers<T>(companyId: string, supplierIds: readonly string[],
  statuses: readonly string[] | null, lockSuppliers: () => Promise<T>): Promise<T> {
  let known: string[] = [];
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await withSavepoint(`batch_before_supplier_${attempt}`, async () => {
        known = [...new Set([...known, ...await batchIdsPayingSuppliers(companyId, supplierIds, statuses)])].sort();
        await sql`
          SELECT id FROM supplier_payment_batches
          WHERE company_id = ${companyId}::UUID AND id = ANY(${known}::UUID[])
          ORDER BY id FOR UPDATE
        `;
        const result = await lockSuppliers();
        const missed = (await batchIdsPayingSuppliers(companyId, supplierIds, statuses)).filter((id) => !known.includes(id));
        if (missed.length > 0) throw new BatchSetGrew(missed);
        return result;
      });
    } catch (err) {
      if (!(err instanceof BatchSetGrew)) throw err;
      known = [...known, ...err.batchIds];
    }
  }
  throw new Error('Supplier payment batches kept changing while the supplier was being locked; try again.');
}

/**
 * `userId` set the supplier's bank details (decision (b), 2026-10-06; round 1
 * append-only): they join `bank_details_setters` — derived LIVE into the
 * authors of every payment to the supplier, payments created later included —
 * and the list restarts at them only when the account number itself
 * changed (`'repointed'`, and every create with bank details): the
 * old destination is gone, and they answer for the new one. They are also
 * stamped onto every draft or approved batch carrying such a payment, then
 * onto every draft or approved payment to the supplier, append-only, so a
 * later setter cannot strip them from money already in flight. Not an UPDATE
 * OF status, so the 867 backstops do not fire. Called only for a write that
 * changed (or created) bank details: no other supplier write names the column.
 */
export async function recordBankDetailsSetter(companyId: string, supplierId: string, userId: string,
  change: Exclude<BankDetailsChange, 'none'>): Promise<void> {
  await sql`
    UPDATE suppliers
    SET bank_details_setters = CASE WHEN ${change === 'repointed'} THEN ARRAY[${userId}::UUID]
                                    ELSE approval_add_author(bank_details_setters, ${userId}::UUID) END
    WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
  `;
  const batches = await lockBatchesPayingSupplier(companyId, supplierId, STAMPED_BATCH_STATUSES);
  if (batches.length > 0) {
    await sql`
      UPDATE supplier_payment_batches
      SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
      WHERE company_id = ${companyId}::UUID AND id = ANY(${batches}::UUID[])
        AND id IN (SELECT sp.batch_id FROM supplier_payments sp
                   WHERE sp.company_id = ${companyId}::UUID AND sp.supplier_id = ${supplierId}::UUID
                     AND sp.status IN ('draft', 'approved'))
    `;
  }
  await sql`
    UPDATE supplier_payments
    SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${supplierId}::UUID AND status IN ('draft', 'approved')
  `;
}

/**
 * A supplier merge re-points payments (supplier_id is approval content, and
 * with it the payee's bank details): stamp the merging user onto each batch
 * that carries one of them. The merge locks those batches FIRST, before either
 * supplier row (`assertSupplierMergeKeepsDrcFlag` →
 * `lockBatchesBeforeSuppliers`), then re-points and stamps the payments, then
 * calls this — batch before members, as everywhere else.
 */
export async function stampBatchesOfMovedPayments(companyId: string, batchIds: readonly string[], userId: string): Promise<void> {
  if (batchIds.length === 0) return;
  await sql`
    UPDATE supplier_payment_batches
    SET content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND id = ANY(${batchIds}::UUID[])
  `;
}

/**
 * Whether `userId` set the supplier's CURRENT bank details — is in
 * `bank_details_setters` since the account was last re-pointed. Supplier bank
 * verification (decision 5) refuses such a person, as payment approval does;
 * read here so this module stays the only one naming the column.
 */
export async function isBankDetailsSetter(companyId: string, supplierId: string, userId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT (${userId} = ANY (COALESCE(bank_details_setters::TEXT[], '{}'))) AS setter
    FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0]?.setter === true;
}

/** The company's suppliers whose CURRENT bank details `userId` set — left out of the switch-on baseline. */
export async function suppliersWithBankDetailsSetBy(companyId: string, userId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT id::TEXT AS id FROM suppliers
    WHERE company_id = ${companyId}::UUID AND ${userId} = ANY (COALESCE(bank_details_setters::TEXT[], '{}'))
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** Everyone who set the supplier's CURRENT bank details (`bank_details_setters`); [] for none or no such supplier. */
export async function bankDetailsSetters(companyId: string, supplierId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT COALESCE(bank_details_setters::TEXT[], '{}') AS setters
    FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return Array.isArray(rows[0]?.setters) ? (rows[0]!.setters as unknown[]).map(String) : [];
}
