/**
 * Shared merchant-pattern pool — the aggregation job (Hein, 2026-10-21, decision 6). The pool's ONLY writer.
 *
 * Runs on the RLS-bypassing pool role, never inside a request: the nightly cron route
 * (pages/api/cron/shared-merchant-pool.ts) and the platform-admin trigger (pages/api/admin/shared-merchant-pool.ts,
 * queued with runAfterCommit so it too runs off the request's connection). Every read names company_id.
 *
 * WHY THE WORK IS IN TS AND THE WRITE IS A DEFINER FUNCTION. The PII filter is TypeScript (heavily unit
 * tested, and the reader must run the identical code), and it must run before anything is counted, so
 * the aggregation cannot be a SQL function. The write still goes through one door, shared_pool_publish
 * (906): it refuses any field but the five the pool stores, and the table's CHECKs refuse a row under
 * the thresholds, so a bug here can publish less, never a company id or a k-of-4 merchant.
 *
 * Full recompute every run: the pool is replaced, never patched. A bureau that opts out, a company that
 * leaves a bureau, or a mapping that changes is reflected on the next run; nothing lingers.
 *
 * Inputs per eligible company (decision 2), each translated to a category through the company's own
 * mapping (company_category_mappings); a line whose account has no single category is ignored:
 *   - categorization_patterns, source learned / manual (the 212 'system' seeds carry no account)
 *   - bank_categorisation_rules that match on the description with plain text (regex rules skipped)
 *   - categorization_decisions accepted / recoded, with the bank line's description. Excluded: an auto-post
 *     later corrected by hand (its final_gl_account_id is still the account that was wrong). A pool
 *     suggestion merely accepted is loaded as 'pool_accepted' and never votes: it also mutes the company's
 *     learned patterns and rules on that merchant, which accepting it may have written (merchantPool rule 5).
 *
 * All or nothing: if any eligible company's read fails, nothing is published and the previous pool stands.
 * Publishing without a company is not "less": it can wipe the pool (every read failing) or raise a
 * merchant over the agreement threshold (a dissenting company dropped). One run at a time per process.
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { listPoolEligibleCompanyIds } from '@/modules/bureau/services/poolEligibility';
import { MERCHANT_FILTER_VERSION } from './merchantPiiFilter';
import { accountToCategory, aggregatePool, type AggregationStats, type PoolObservation } from './merchantPool';

interface TextRow {
  text: string | null; gl_account_id: string | null; weight: number | string | null; origin?: PoolObservation['origin'] | null;
}

async function loadCompanyObservations(companyId: string): Promise<PoolObservation[]> {
  const mappings = (await sql`
    SELECT category_code, gl_account_id FROM company_category_mappings WHERE company_id = ${companyId}::UUID
  `) as Array<{ category_code: string; gl_account_id: string }>;
  const toCategory = accountToCategory(mappings.map((m) => ({ categoryCode: m.category_code, glAccountId: String(m.gl_account_id) })));
  if (toCategory.size === 0) return [];

  const patterns = (await sql`
    SELECT pattern AS text, gl_account_id, 1 AS weight FROM categorization_patterns
    WHERE company_id = ${companyId}::UUID AND source IN ('learned', 'manual')
      AND gl_account_id IS NOT NULL AND COALESCE(match_type, 'contains') <> 'regex'
  `) as TextRow[];
  const rules = (await sql`
    SELECT match_pattern AS text, gl_account_id, 1 AS weight FROM bank_categorisation_rules
    WHERE company_id = ${companyId}::UUID AND is_active = true AND gl_account_id IS NOT NULL
      AND COALESCE(match_type, 'contains') <> 'regex' AND COALESCE(match_field, 'description') IN ('description', 'both')
  `) as TextRow[];
  const decisions = (await sql`
    SELECT bt.description AS text, d.final_gl_account_id AS gl_account_id, COUNT(*) AS weight,
      CASE WHEN d.outcome = 'recoded' THEN 'recoded'
           WHEN d.suggestion_source = 'shared_pool' THEN 'pool_accepted' END AS origin
    FROM categorization_decisions d
    JOIN bank_transactions bt ON bt.id = d.bank_transaction_id AND bt.company_id = d.company_id AND bt.feed_state = 'posted'
    WHERE d.company_id = ${companyId}::UUID AND d.final_gl_account_id IS NOT NULL
      AND d.outcome IN ('accepted', 'recoded')
      AND NOT (d.was_auto_posted AND d.outcome = 'recoded')
    GROUP BY 1, 2, 4
  `) as TextRow[];

  const out: PoolObservation[] = [];
  for (const r of [...patterns, ...rules, ...decisions]) {
    const categoryCode = r.gl_account_id ? toCategory.get(String(r.gl_account_id).toLowerCase()) : undefined;
    if (!categoryCode || !r.text) continue;
    out.push({ companyId, text: r.text, categoryCode, weight: Number(r.weight) || 1, ...(r.origin ? { origin: r.origin } : {}) });
  }
  return out;
}

export interface SharedPoolRunResult extends AggregationStats {
  eligibleCompanies: number;
  failedCompanies: number;
  durationMs: number;
}

let running = false;

/** True while a run is in progress in this process (the admin trigger answers 409 instead of queueing another). */
export function isSharedPoolRunning(): boolean {
  return running;
}

/**
 * Recompute and replace the pool. A company whose read fails aborts the run before the publish (logged and
 * thrown), so the previous pool stands; a second run while one is in progress is refused.
 */
export async function runSharedPoolAggregation(): Promise<SharedPoolRunResult> {
  // Inside a request, every read would be RLS-bound to one company and the publish would replace the
  // whole pool with that one company's view (an empty pool). Refuse instead of wiping it.
  if (als.getStore()) throw new Error('runSharedPoolAggregation must run off any request transaction (cron, or runAfterCommit)');
  if (running) throw new Error('shared pool: a recompute is already running');
  running = true;
  try {
    return await recompute();
  } finally {
    running = false;
  }
}

async function recompute(): Promise<SharedPoolRunResult> {
  const started = Date.now();
  const eligible = await listPoolEligibleCompanyIds();
  const observations: PoolObservation[] = [];
  let failedCompanies = 0;
  for (const companyId of eligible) {
    try {
      observations.push(...await loadCompanyObservations(companyId));
    } catch (err) {
      failedCompanies++;
      log.error('shared pool: company read failed', { companyId, error: err instanceof Error ? err.message : String(err) }, 'shared-pool');
    }
  }
  if (failedCompanies > 0) {
    log.error('shared pool: not published, the previous pool stands', { failedCompanies, eligibleCompanies: eligible.length }, 'shared-pool');
    throw new Error(`shared pool: ${failedCompanies} of ${eligible.length} company reads failed; nothing published`);
  }
  const { rows, stats } = aggregatePool(observations, new Set(eligible));
  const [res] = (await sql`
    SELECT public.shared_pool_publish(${JSON.stringify(rows)}::JSONB, ${MERCHANT_FILTER_VERSION}::INT) AS published
  `) as Array<{ published: number }>;
  const result: SharedPoolRunResult = {
    ...stats, published: Number(res?.published ?? 0), eligibleCompanies: eligible.length, failedCompanies,
    durationMs: Date.now() - started,
  };
  log.info('shared pool: recomputed', { ...result }, 'shared-pool');
  return result;
}
