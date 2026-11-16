/** The bank-transactions page's modal triggers: which row (if any) each dialog is open for. */

import { useState } from 'react';
import type { AllocType, BankTx } from '@/components/accounting/BankTxTable';
import type { RulePrompt } from './BankTxBatchPanel';
import { useBankTxOutcome } from './useBankTxOutcome';

export function useBankTxModalState() {
  const [splitTxId, setSplitTxId] = useState<string | null>(null);
  const [excludingTxId, setExcludingTxId] = useState<string | null>(null);
  const [findMatchTxId, setFindMatchTxId] = useState<string | null>(null);
  const [attachmentsTxId, setAttachmentsTxId] = useState<string | null>(null);
  const [queryTx, setQueryTx] = useState<BankTx | null>(null);
  const [linkTx, setLinkTx] = useState<BankTx | null>(null);
  const [createRuleTx, setCreateRuleTx] = useState<BankTx | null>(null);
  const [rulePrompt, setRulePrompt] = useState<RulePrompt | null>(null);
  const [createEntityTxId, setCreateEntityTxId] = useState<string | null>(null);
  const [createEntityType, setCreateEntityType] = useState<AllocType | null>(null);
  const splitOutcome = useBankTxOutcome();
  const excludeOutcome = useBankTxOutcome();
  return {
    splitTxId, setSplitTxId, excludingTxId, setExcludingTxId, findMatchTxId, setFindMatchTxId,
    attachmentsTxId, setAttachmentsTxId, queryTx, setQueryTx, linkTx, setLinkTx, createRuleTx, setCreateRuleTx,
    rulePrompt, setRulePrompt, createEntityTxId, setCreateEntityTxId, createEntityType, setCreateEntityType,
    splitOutcome, excludeOutcome,
  };
}

export type BankTxModalState = ReturnType<typeof useBankTxModalState>;
