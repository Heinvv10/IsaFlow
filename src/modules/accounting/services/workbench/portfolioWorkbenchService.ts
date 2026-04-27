/**
 * Portfolio Workbench aggregator.
 *
 * Practice-owner home screen — close-of-month status across every client
 * the authenticated user has access to. Builds on the per-client
 * monthEndWorkbenchService: one row per client, summarising the same 8
 * close-areas as a status digest.
 *
 * Read-only. Companies the user can't access are never queried.
 */

import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { getMonthEndWorkbench, type WorkbenchCard, type CardStatus } from './monthEndWorkbenchService';
import { log } from '@/lib/logger';

export interface PortfolioRow {
  companyId: string;
  companyName: string;
  isDefault: boolean;
  role: string;
  trialBalanceBalanced: boolean;
  cards: WorkbenchCard[];
  readyCount: number;
  attentionCount: number;
  blockedCount: number;
  failed: boolean;
  failedReason?: string;
}

export interface PortfolioWorkbench {
  userId: string;
  period: string;
  generatedAt: string;
  rows: PortfolioRow[];
  summary: {
    totalClients: number;
    clientsAtRisk: number;
    cardsByStatus: Record<CardStatus, number>;
  };
}

const PARALLEL_LIMIT = 5;

async function processInBatches<T, R>(
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

export async function getPortfolioWorkbench(
  userId: string,
  period: string,
): Promise<PortfolioWorkbench> {
  const companies = await getUserCompanies(userId);

  const rows = await processInBatches(
    companies,
    async (cu): Promise<PortfolioRow> => {
      try {
        const wb = await getMonthEndWorkbench(cu.companyId, period);
        const readyCount = wb.cards.filter(c => c.status === 'ready').length;
        const attentionCount = wb.cards.filter(c => c.status === 'attention').length;
        const blockedCount = wb.cards.filter(c => c.status === 'blocked').length;
        return {
          companyId: cu.companyId,
          companyName: cu.companyName,
          isDefault: cu.isDefault,
          role: cu.role,
          trialBalanceBalanced: wb.trialBalanceBalanced,
          cards: wb.cards,
          readyCount,
          attentionCount,
          blockedCount,
          failed: false,
        };
      } catch (err) {
        log.error('Portfolio workbench: client failed',
          { error: err, userId, companyId: cu.companyId, period }, 'workbench');
        return {
          companyId: cu.companyId,
          companyName: cu.companyName,
          isDefault: cu.isDefault,
          role: cu.role,
          trialBalanceBalanced: false,
          cards: [],
          readyCount: 0,
          attentionCount: 0,
          blockedCount: 0,
          failed: true,
          failedReason: 'Failed to load workbench for this client.',
        };
      }
    },
    PARALLEL_LIMIT,
  );

  // Sort: clients with most attention first, then blocked, then alphabetical.
  rows.sort((a, b) => {
    if (a.attentionCount !== b.attentionCount) return b.attentionCount - a.attentionCount;
    if (a.blockedCount !== b.blockedCount) return b.blockedCount - a.blockedCount;
    return a.companyName.localeCompare(b.companyName);
  });

  const cardsByStatus: Record<CardStatus, number> = {
    ready: 0, attention: 0, blocked: 0, in_progress: 0, not_started: 0,
  };
  for (const r of rows) {
    for (const c of r.cards) cardsByStatus[c.status]++;
  }

  return {
    userId,
    period,
    generatedAt: new Date().toISOString(),
    rows,
    summary: {
      totalClients: rows.length,
      clientsAtRisk: rows.filter(r => r.attentionCount > 0 || r.blockedCount > 0 || r.failed).length,
      cardsByStatus,
    },
  };
}
