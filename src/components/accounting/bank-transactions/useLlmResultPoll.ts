/**
 * useLlmResultPoll — after smart-categorize, LLM suggestions arrive late: reload
 * every 4s until the count of LLM-suggested rows stops changing (or 8 ticks).
 * Returns how many rows are still being categorised (0 = not polling).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankTx } from '@/components/accounting/BankTxTable';

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
