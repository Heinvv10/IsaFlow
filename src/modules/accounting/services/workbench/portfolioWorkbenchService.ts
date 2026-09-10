/**
 * Portfolio Workbench aggregator.
 *
 * Practice-owner home screen — close-of-month status across every client
 * the authenticated user has access to. Builds on the per-client
 * monthEndWorkbenchService: one row per client, summarising the same 8
 * close-areas as a status digest.
 *
 * Tenant-isolation model:
 *   1. getUserCompanies(userId) is called via the request's normal
 *      app_user/RLS context — only companies the user has membership in
 *      come back. That list is the *authorised* set.
 *   2. For each authorised company, we open a fresh client on the
 *      platform_admin (BYPASSRLS) pool inside its own als.run() block,
 *      set app.current_company_id GUC to that company, then call
 *      getMonthEndWorkbench. The inner workbench's queries already
 *      include explicit `WHERE company_id = ${companyId}` filters, so
 *      RLS-bypass is safe — the explicit filters do the work, and we
 *      never touch a company outside the authorised set.
 *   3. Each iteration uses its own client — no concurrent-queries-on-
 *      one-pg-client cascade bug, no tx-aborted-cascades-39-other-rows
 *      stability problem.
 *
 * If we tried to reuse the request tx across companies, RLS would
 * silently filter every non-active company to empty rows because
 * app.current_company_id GUC stays bound to the cookie's active
 * company for the entire request — surfacing fake "all clean" data.
 */

import type { PoolClient } from 'pg';
import { runOwnedContext } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { getPlatformAdminPool } from '@/lib/auth/withPlatformAdmin.pools';
import { getUserCompanies } from '@/modules/accounting/services/core/companyService';
import { getMonthEndWorkbench, type WorkbenchCard, type CardStatus } from './monthEndWorkbenchService';

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

interface CompanyMembership {
  companyId: string;
  companyName: string;
  isDefault: boolean;
  role: string;
}

async function processInBatches<T, R>(
  items: ReadonlyArray<T>,
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const settled = await Promise.allSettled(batch.map(fn));
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        // The inner fn for this aggregator already converts errors into
        // failed=true rows, so a rejected promise here is unexpected. Re-
        // throwing would kill the whole batch — log and skip the slot
        // instead.
        log.error('processInBatches: rejected promise leaked', { reason: r.reason }, 'workbench');
      }
    }
  }
  return results;
}

async function buildOneClientRow(
  client: PoolClient,
  cu: CompanyMembership,
  userId: string,
  period: string,
): Promise<PortfolioRow> {
  // Wrap the iteration in a real transaction. Without BEGIN, set_config
  // with is_local=true reverts immediately on the implicit single-statement
  // tx, so the GUC would never be visible to the inner workbench queries.
  // The inner workbench is read-only today and tenant isolation rests on
  // its explicit `WHERE company_id = ${companyId}` filters — but this BEGIN
  // block makes the GUC actually take effect, so any future write or
  // RLS-aware sub-query inside getMonthEndWorkbench inherits the right
  // tenant context. Also gives us transactional rollback if mid-iteration
  // queries fail.
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [cu.companyId]);

    // Run the workbench for this company under an ALS context that points at
    // this iteration's client, so the inner sql tagged template routes through
    // the right transaction.
    const wb = await runOwnedContext(
      { client, userId, companyId: cu.companyId, claims: {} },
      () => getMonthEndWorkbench(cu.companyId, period),
    );

    await client.query('COMMIT');

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
    try { await client.query('ROLLBACK'); } catch { /* secondary */ }
    throw err;
  }
}

function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Categorise into operator-meaningful buckets without leaking schema
  // names. Full error text goes to the server log only.
  if (/timeout/i.test(msg)) return 'Timeout — DB took too long.';
  if (/permission denied|RLS|insufficient privilege/i.test(msg)) return 'Permission denied for this client.';
  if (/connection|ECONNREFUSED|terminated/i.test(msg)) return 'DB connection problem — try again shortly.';
  if (/relation .* does not exist|column .* does not exist/i.test(msg)) return 'Schema mismatch — flag to support.';
  return 'Unable to load this client (logged for support).';
}

export async function getPortfolioWorkbench(
  userId: string,
  period: string,
): Promise<PortfolioWorkbench> {
  // Step 1 — authorise. getUserCompanies runs via the request's RLS-bound
  // client (the caller's withAuth tx), so we only see companies the user
  // has membership in. Anything we iterate after this point is the
  // authorised set; the BYPASSRLS connection in step 2 cannot widen it.
  const companies = await getUserCompanies(userId);

  const memberships: CompanyMembership[] = companies.map(c => ({
    companyId: c.companyId,
    companyName: c.companyName,
    isDefault: c.isDefault,
    role: c.role,
  }));

  // Step 2 — for each authorised company, open its own BYPASSRLS client,
  // run the workbench under an ALS context that points at it, release.
  const adminPool = getPlatformAdminPool();
  const rows = await processInBatches(
    memberships,
    async (cu): Promise<PortfolioRow> => {
      const client = await adminPool.connect();
      try {
        return await buildOneClientRow(client, cu, userId, period);
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
          failedReason: classifyError(err),
        };
      } finally {
        client.release();
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
