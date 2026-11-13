/**
 * reallocate_bank_transaction: the facts `bankReallocationGuards.planReallocation` decides on, read under the line's
 * lock. Split out of bankReallocationGuards.ts (file-size cap); reads only.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { reconciliationLockOf } from './reconciledCash';
import { findChainCashLines } from './chainBankLines';
import { peekReversalTarget } from './reversalDatePostable';
import type { LineChain } from './bankChainLineReversal';
import type { ReallocationFacts, ReallocationTarget } from './bankReallocationGuards';
import { openDocumentsOf } from './bankReallocationLocks';

const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Every fact `planReallocation` decides on. Reads only; the line (`tx`) and its chain's lines are already locked. */
export async function loadReallocationFacts(
  companyId: string, tx: DbRow, chain: LineChain | null, target: ReallocationTarget,
): Promise<ReallocationFacts> {
  const txId = String(tx.id);
  const root = chain?.rootId ?? null;
  const journalId = chain?.journalId ?? null;
  const [je] = journalId ? (await sql`
    SELECT entry_date FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID AND status = 'posted'`) as DbRow[]
    : [];
  const lines = je ? (await sql`
    SELECT jl.id::TEXT AS id, jl.gl_account_id::TEXT AS account, a.account_subtype, jl.debit::float8 AS debit,
           jl.credit::float8 AS credit, jl.vat_type, jl.cc1_id::TEXT AS cc1, jl.cc2_id::TEXT AS cc2, jl.bu_id::TEXT AS bu
    FROM gl_journal_lines jl
    LEFT JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${companyId}::UUID
    ORDER BY jl.id`) as DbRow[] : [];
  const docs = root ? (await sql`
    SELECT 'supplier' AS kind, sp.supplier_id::TEXT AS contact, sp.total_amount::float8 AS total,
           COALESCE((SELECT SUM(pa.amount_allocated) FROM payment_allocations pa WHERE pa.payment_id = sp.id), 0)::float8 AS applied
      FROM supplier_payments sp
      WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id = ${root}::UUID AND sp.status <> 'cancelled'
    UNION ALL
    SELECT 'customer', cp.client_id::TEXT, cp.total_amount::float8,
           COALESCE((SELECT SUM(a.amount_allocated) FROM customer_payment_allocations a WHERE a.payment_id = cp.id), 0)::float8
      FROM customer_payments cp
      WHERE cp.company_id = ${companyId}::UUID AND cp.gl_journal_entry_id = ${root}::UUID AND cp.status <> 'cancelled'
    UNION ALL
    SELECT 'batch', NULL, 0, 0 FROM supplier_payment_batches
      WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${root}::UUID`) as DbRow[] : [];
  const positive = docs.filter((d) => d.kind !== 'batch' && Number(d.total) > 0);
  const [bank] = (await sql`
    SELECT default_cc1_id::TEXT AS cc1, default_cc2_id::TEXT AS cc2, default_bu_id::TEXT AS bu FROM gl_accounts
    WHERE id = ${String(tx.bank_account_id)}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  const [acct] = target.kind === 'account' ? (await sql`
    SELECT account_subtype FROM gl_accounts WHERE id = ${target.glAccountId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[]
    : [];
  return {
    txId,
    line: {
      status: String(tx.status ?? ''), reconciliationId: str(tx.reconciliation_id), allocationType: str(tx.allocation_type),
      allocatedEntityName: str(tx.allocated_entity_name), provisionalJeId: str(tx.provisional_je_id),
      counterpartyAccountId: str(tx.counterparty_account_id), transferJournalEntryId: str(tx.transfer_journal_entry_id),
      matchedLineId: str(tx.matched_journal_line_id), bankAccountId: String(tx.bank_account_id),
      transactionDate: fmtDate(tx.transaction_date as string | Date), amount: Number(tx.amount),
    },
    lock: await reconciliationLockOf(companyId, tx),
    chain,
    chainCashLineIds: journalId ? await findChainCashLines(companyId, journalId) : [],
    reversalTarget: root ? await peekReversalTarget(companyId, root) : null,
    journal: je && journalId ? {
      id: journalId, entryDate: fmtDate(je.entry_date as string | Date),
      lines: lines.map((l) => ({
        lineId: String(l.id), glAccountId: String(l.account), subtype: str(l.account_subtype), debit: Number(l.debit),
        credit: Number(l.credit), vatType: str(l.vat_type), cc1Id: str(l.cc1), cc2Id: str(l.cc2), buId: str(l.bu),
      })),
    } : null,
    documents: {
      supplierIds: docs.filter((d) => d.kind === 'supplier').map((d) => String(d.contact)),
      customerIds: docs.filter((d) => d.kind === 'customer').map((d) => String(d.contact)),
      batch: docs.some((d) => d.kind === 'batch'),
      applied: positive.reduce((n, d) => n + Number(d.applied), 0),
      unapplied: positive.reduce((n, d) => n + Number(d.total) - Math.min(Number(d.applied), Number(d.total)), 0),
    },
    bankDefaults: {
      ...(bank?.cc1 ? { cc1Id: String(bank.cc1) } : {}), ...(bank?.cc2 ? { cc2Id: String(bank.cc2) } : {}),
      ...(bank?.bu ? { buId: String(bank.bu) } : {}),
    },
    targetOpenDocuments: target.kind === 'supplier' ? await openDocumentsOf(companyId, { kind: 'supplier', id: target.supplierId })
      : target.kind === 'customer' ? await openDocumentsOf(companyId, { kind: 'customer', id: target.customerId }) : 0,
    targetAccount: target.kind === 'account' ? (acct ? { subtype: str(acct.account_subtype) } : null) : null,
  };
}
