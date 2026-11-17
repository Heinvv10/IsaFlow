/**
 * BankTxPageModals — the bank-transactions page's dialogs wired to its state. Every dialog that writes finishes
 * through `afterMutation` (list + summary), so the cards, tiles and statement panel move with the list: Link, Split,
 * Find-match and Create-rule used to reload the list only (WP1 PR-C, spec §4.2).
 */

import { useTrackLastClick } from './BankTxModalShell';
import { BankTxModals } from './BankTxModals';
import type { buildBankTxActions } from './useBankTxActions';
import type { BankTxModalState } from './useBankTxModalState';
import type { BankTx, RowSelection, SelectOption } from '@/components/accounting/BankTxTable';

interface Props {
  m: BankTxModalState;
  actions: ReturnType<typeof buildBankTxActions>;
  transactions: BankTx[];
  glAccounts: SelectOption[];
  suppliers: SelectOption[];
  customers: SelectOption[];
  cc2Options: SelectOption[];
  buOptions: SelectOption[];
  transferTargets: SelectOption[];
  selectedBank: string;
  rowSelections: Record<string, RowSelection>;
  /** Reloads the list AND the summary. */
  afterMutation: () => void;
  setRowSelections: (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void;
  setTransactions: (fn: (prev: BankTx[]) => BankTx[]) => void;
  setGlAccounts: (v: SelectOption[] | ((p: SelectOption[]) => SelectOption[])) => void;
  setSuppliers: (v: SelectOption[] | ((p: SelectOption[]) => SelectOption[])) => void;
  setCustomers: (v: SelectOption[] | ((p: SelectOption[]) => SelectOption[])) => void;
}

export function BankTxPageModals(p: Props) {
  const { m, actions, afterMutation } = p;
  useTrackLastClick(); // for the shell's focus return where the browser never focused the clicked button
  return (
    <BankTxModals
      transactions={p.transactions} glAccounts={p.glAccounts} suppliers={p.suppliers} customers={p.customers}
      cc2Options={p.cc2Options} buOptions={p.buOptions} bankAccounts={p.transferTargets}
      selectedBank={p.selectedBank} rowSelections={p.rowSelections} splitTxId={m.splitTxId}
      excludingTxId={m.excludingTxId} findMatchTxId={m.findMatchTxId} attachmentsTxId={m.attachmentsTxId}
      createRuleTx={m.createRuleTx} createEntityTxId={m.createEntityTxId} createEntityType={m.createEntityType}
      queryTx={m.queryTx} linkTx={m.linkTx}
      onLinkClose={() => m.setLinkTx(null)} onLinkDone={() => { m.setLinkTx(null); afterMutation(); }}
      onSplitClose={() => { m.splitOutcome.settle(false); m.setSplitTxId(null); }}
      onSplitDone={() => { m.splitOutcome.settle(true); m.setSplitTxId(null); afterMutation(); }}
      onExcludeClose={actions.handleExcludeClose} onExcludeConfirm={actions.handleExcludeConfirm}
      onFindMatchClose={() => m.setFindMatchTxId(null)} onFindMatchDone={() => { m.setFindMatchTxId(null); afterMutation(); }}
      onAttachmentsClose={() => m.setAttachmentsTxId(null)} onCreateRuleClose={() => m.setCreateRuleTx(null)}
      onAttachmentCount={(id, n) => p.setTransactions(ts => ts.map(t => (t.id === id ? { ...t, attachmentCount: n } : t)))}
      onCreateRuleDone={() => { m.setCreateRuleTx(null); p.setRowSelections(() => ({})); afterMutation(); }}
      onCreateEntityClose={() => { m.setCreateEntityTxId(null); m.setCreateEntityType(null); }}
      onCreateEntityDone={(entity, type) => {
        actions.handleCreateEntityDone(entity, type, p.setGlAccounts, p.setSuppliers, p.setCustomers);
        m.setCreateEntityTxId(null); m.setCreateEntityType(null);
      }}
      onQueryClose={() => m.setQueryTx(null)}
      onQuerySent={() => {
        // Mark the row at once (the list carries the server's own flag from the next load).
        const id = m.queryTx?.id;
        m.setQueryTx(null);
        if (id) p.setTransactions(ts => ts.map(t => (t.id === id ? { ...t, queried: true } : t)));
      }}
    />
  );
}
