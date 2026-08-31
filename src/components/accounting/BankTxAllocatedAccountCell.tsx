/**
 * The "Selection" cell for an already-allocated bank transaction.
 *
 * It renders exactly one kind of value: the GL account the journal posted to,
 * as "<code> <name>". It used to render bank_transactions.allocated_entity_name
 * verbatim, which held the account for directly-allocated rows but the RULE's
 * name for rule-allocated ones — so a restaurant purchase that posted to Staff
 * Welfare displayed as "ROMANS PIZZA", and the screen a bookkeeper uses to check
 * where things went could not answer that question.
 *
 * The supplier/customer/transfer counterparty is a second, smaller line; the
 * rule that fired lives in its own column.
 */

export interface AllocatedTx {
  allocationType?: 'account' | 'supplier' | 'customer' | 'transfer';
  allocatedEntityName?: string;
  allocatedAccountCode?: string;
  allocatedAccountName?: string;
  allocatedCounterpartyName?: string;
}

const TYPE_COLOR: Record<string, string> = {
  supplier: 'text-blue-400',
  customer: 'text-purple-400',
  transfer: 'text-orange-400',
};

export function AllocatedAccountCell({ tx, fallbackLabel }: {
  tx: AllocatedTx;
  fallbackLabel?: string;
}) {
  const colour = TYPE_COLOR[tx.allocationType ?? ''] ?? 'text-teal-400';
  // No account resolved means the journal could not be reached (reversed or
  // deleted). Say so rather than falling back to a label that may not be one.
  const account = tx.allocatedEntityName || fallbackLabel || 'Allocated';
  // For supplier/customer/transfer rows the account is the control account
  // (payables, receivables, the other bank) — the counterparty is what names it.
  const counterparty = tx.allocatedCounterpartyName && tx.allocatedCounterpartyName !== account
    ? tx.allocatedCounterpartyName
    : undefined;

  return (
    <div className="max-w-[200px]">
      <span className={`text-xs truncate block ${colour}`} title={account}>
        {account}
      </span>
      {counterparty && (
        <span className="text-[10px] truncate block text-[var(--ff-text-tertiary)]" title={counterparty}>
          {counterparty}
        </span>
      )}
    </div>
  );
}
