/**
 * BankTxModals — All lazily-loaded modal dialogs for the bank transactions page.
 * Each modal is only mounted when its trigger state is non-null.
 */

import dynamic from 'next/dynamic';
import { type AllocType, type SelectOption, type BankTx, type RowSelection } from '@/components/accounting/BankTxTable';

// Lazy-load modals — only loaded when opened
const SplitTransactionModal = dynamic(
  () => import('@/components/accounting/SplitTransactionModal').then(m => ({ default: m.SplitTransactionModal })),
  { ssr: false },
);
const ExcludeReasonModal = dynamic(
  () => import('@/components/accounting/ExcludeReasonModal').then(m => ({ default: m.ExcludeReasonModal })),
  { ssr: false },
);
const FindMatchModal = dynamic(
  () => import('@/components/accounting/FindMatchModal').then(m => ({ default: m.FindMatchModal })),
  { ssr: false },
);
const BankTxAttachmentsModal = dynamic(
  () => import('@/components/accounting/BankTxAttachmentsModal').then(m => ({ default: m.BankTxAttachmentsModal })),
  { ssr: false },
);
const CreateRuleModal = dynamic(
  () => import('@/components/accounting/CreateRuleModal').then(m => ({ default: m.CreateRuleModal })),
  { ssr: false },
);
const CreateEntityModal = dynamic(
  () => import('@/components/accounting/CreateEntityModal').then(m => ({ default: m.CreateEntityModal })),
  { ssr: false },
);

interface Props {
  transactions: BankTx[];
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  selectedBank: string;
  rowSelections: Record<string, RowSelection>;
  splitTxId: string | null;
  excludingTxId: string | null;
  findMatchTxId: string | null;
  attachmentsTxId: string | null;
  createRuleTx: BankTx | null;
  createEntityTxId: string | null;
  createEntityType: AllocType | null;
  onSplitClose: () => void;
  onSplitDone: () => void;
  onExcludeClose: () => void;
  onExcludeConfirm: (reason: string) => void;
  onFindMatchClose: () => void;
  onFindMatchDone: () => void;
  onAttachmentsClose: () => void;
  onCreateRuleClose: () => void;
  onCreateRuleDone: () => void;
  onCreateEntityClose: () => void;
  onCreateEntityDone: (entity: { id: string; name: string; code?: string }, type: AllocType) => void;
}

export function BankTxModals({
  transactions, glAccounts, suppliers, customers, selectedBank, rowSelections,
  splitTxId, excludingTxId, findMatchTxId, attachmentsTxId, createRuleTx,
  createEntityTxId, createEntityType,
  onSplitClose, onSplitDone,
  onExcludeClose, onExcludeConfirm,
  onFindMatchClose, onFindMatchDone,
  onAttachmentsClose,
  onCreateRuleClose, onCreateRuleDone,
  onCreateEntityClose, onCreateEntityDone,
}: Props) {
  const splitTx = splitTxId ? transactions.find(t => t.id === splitTxId) : null;
  const excludeTx = excludingTxId ? transactions.find(t => t.id === excludingTxId) : null;
  const matchTx = findMatchTxId ? transactions.find(t => t.id === findMatchTxId) : null;
  const attachTx = attachmentsTxId ? transactions.find(t => t.id === attachmentsTxId) : null;
  const entityTx = createEntityTxId ? transactions.find(t => t.id === createEntityTxId) : null;

  return (
    <>
      {splitTxId && splitTx && (
        <SplitTransactionModal
          transaction={splitTx}
          glAccounts={glAccounts}
          onClose={onSplitClose}
          onSplit={onSplitDone}
        />
      )}

      {excludingTxId && excludeTx && (
        <ExcludeReasonModal
          transaction={excludeTx}
          onClose={onExcludeClose}
          onExclude={onExcludeConfirm}
        />
      )}

      {findMatchTxId && matchTx && (
        <FindMatchModal
          transaction={{
            id: matchTx.id,
            description: matchTx.description || '',
            amount: matchTx.amount,
            transactionDate: matchTx.transactionDate,
          }}
          onClose={onFindMatchClose}
          onMatch={onFindMatchDone}
        />
      )}

      {attachmentsTxId && (
        <BankTxAttachmentsModal
          bankTransactionId={attachmentsTxId}
          transactionDescription={attachTx?.description}
          onClose={onAttachmentsClose}
        />
      )}

      {createRuleTx && (
        <CreateRuleModal
          transaction={createRuleTx}
          bankAccountId={selectedBank}
          glAccounts={glAccounts}
          suppliers={suppliers}
          clients={customers}
          selection={rowSelections[createRuleTx.id] || null}
          onClose={onCreateRuleClose}
          onCreated={onCreateRuleDone}
        />
      )}

      {createEntityTxId && createEntityType && (
        <CreateEntityModal
          type={createEntityType}
          transactionDescription={entityTx?.description}
          existingAccounts={glAccounts}
          onClose={onCreateEntityClose}
          onCreated={entity => onCreateEntityDone(entity, createEntityType)}
        />
      )}
    </>
  );
}
