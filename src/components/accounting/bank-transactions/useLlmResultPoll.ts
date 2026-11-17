/**
 * useLlmResultPoll — after smart-categorize, LLM suggestions arrive late: reload
 * every 4s until the count of LLM-suggested rows stops changing (or 8 ticks).
 * Returns how many rows are still being categorised (0 = not polling).
 *
 * WP3: the interval outlives the render that started it, so each tick calls the LATEST loader (a ref), never the one
 * captured when polling began - after an account or filter change that one would put the old view's rows on the new
 * one. The loader it is given should be a silent reload (no skeleton): a poll must not blank the list every 4 s.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankTx } from '@/components/accounting/BankTxTable';

export function useLlmResultPoll(transactions: BankTx[], loadTransactions: () => Promise<void>) {
  const [aiPolling, setAiPolling] = useState(0);
  const transactionsRef = useRef<BankTx[]>([]);
  useEffect(() => { transactionsRef.current = transactions; }, [transactions]);
  const loadRef = useRef(loadTransactions);
  useEffect(() => { loadRef.current = loadTransactions; });
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
      await loadRef.current();
      const llmCount = transactionsRef.current.filter((t) => t.suggestedStrategy === 'llm').length;
      if ((llmCount === lastLlm && ticks > 1) || ticks >= 8) {
        if (aiPollTimerRef.current) clearInterval(aiPollTimerRef.current);
        aiPollTimerRef.current = null;
        setAiPolling(0);
      }
      lastLlm = llmCount;
    }, 4000);
  }, []);

  return { aiPolling, pollForLlmResults };
}
