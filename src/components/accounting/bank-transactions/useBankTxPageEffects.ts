/**
 * Effects of the bank transactions page that do not touch its layout: column visibility, the late-LLM poll and
 * seeding row selections from the server's suggestion fields. Moved out of the page unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, assertOk } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import type { BankTx, RowSelection } from '@/components/accounting/BankTxTable';

/** Column visibility — company settings + localStorage override. */
export function useBankColumnVisibility() {
  const [showCC, setShowCC] = useState(false);
  const [showBU, setShowBU] = useState(false);
  useEffect(() => {
    const readSetting = (key: string) => apiFetch(`/api/accounting/accounting-settings?key=${key}`).then(async r => { await assertOk(r, 'Could not load the column settings'); return r.json(); });
    Promise.all([readSetting('enable_cost_centres'), readSetting('enable_business_units')]).then(([ccJson, buJson]) => {
      const ccLocal = localStorage.getItem('isaflow_bank_showCC');
      const buLocal = localStorage.getItem('isaflow_bank_showBU');
      setShowCC(ccLocal !== null ? ccLocal !== 'false' : ccJson.data?.value === 'true');
      setShowBU(buLocal !== null ? buLocal !== 'false' : buJson.data?.value === 'true');
    }).catch(err => log.warn('Column settings unavailable, using defaults', { error: err }, 'bank-transactions'));
  }, []);
  return { showCC, showBU, setShowCC, setShowBU };
}

/** AI background poll — picks up late-arriving LLM suggestions after smart-categorize. */
export function useLlmResultPoll(transactions: BankTx[], loadTransactions: () => Promise<void>) {
  const [aiPolling, setAiPolling] = useState(0);
  const transactionsRef = useRef<BankTx[]>([]);
  useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
  const aiPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current); }, []);

  const pollForLlmResults = useCallback((residualCount: number) => {
    if (residualCount <= 0) return;
    if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current);
    setAiPolling(residualCount);
    let ticks = 0;
    let lastLlm = -1;
    aiPollTimerRef.current = setInterval(async () => {
      ticks += 1;
      await loadTransactions();
      const llmCount = transactionsRef.current.filter((t) => t.suggestedStrategy === 'llm').length;
      if ((llmCount === lastLlm && ticks > 1) || ticks >= 8) {
        if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current);
        aiPollTimerRef.current = null;
        setAiPolling(0);
      }
      lastLlm = llmCount;
    }, 4000);
  }, [loadTransactions]);
  return { aiPolling, pollForLlmResults };
}

/** Seed rowSelections from the DB suggestion fields of the rows on screen. */
export function useSeedRowSelections(
  transactions: BankTx[],
  rowSelections: Record<string, RowSelection>,
  setRowSelections: (fn: (prev: Record<string, RowSelection>) => Record<string, RowSelection>) => void,
) {
  useEffect(() => {
    if (transactions.length === 0) return;
    const initial: Record<string, RowSelection> = {};
    for (const tx of transactions) {
      if (rowSelections[tx.id]?.entityId) continue;
      const dim = { cc1Id: tx.cc1Id, cc2Id: tx.cc2Id, buId: tx.buId };
      if (tx.suggestedSupplierId) {
        initial[tx.id] = { type: 'supplier', entityId: tx.suggestedSupplierId, label: tx.suggestedSupplierName || tx.suggestedCategory || '', vatCode: 'none', ...dim };
      } else if (tx.suggestedClientId) {
        initial[tx.id] = { type: 'customer', entityId: tx.suggestedClientId, label: tx.suggestedClientName || tx.suggestedCategory || '', vatCode: 'none', ...dim };
      } else if (tx.suggestedGlAccountId) {
        initial[tx.id] = { type: 'account', entityId: tx.suggestedGlAccountId, vatCode: (tx.suggestedVatCode || 'none') as RowSelection['vatCode'], ...dim,
          label: tx.suggestedGlAccountCode ? `${tx.suggestedGlAccountCode} ${tx.suggestedGlAccountName || ''}` : tx.suggestedGlAccountName || tx.suggestedCategory || '' };
      }
    }
    if (Object.keys(initial).length > 0) {
      setRowSelections(prev => {
        const merged = { ...prev };
        for (const [id, sel] of Object.entries(initial)) { if (!merged[id]?.entityId) merged[id] = sel; }
        return merged;
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);
}
