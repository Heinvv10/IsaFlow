/**
 * The after-commit job behind `scheduleBudgetRoll` (Budgets P4 spec §6). It runs outside any
 * request, so each step takes its OWN pooled connection and transaction, as app_user with the
 * closer's claims and company GUC (RLS binds every statement), exactly as an audit snapshot does
 * (`audit/auditTx`); every statement it issues also names company_id.
 *
 * For each fiscal year an end date falls in: the company's rolling version of that year, if any,
 * rolled in 'auto' mode (one transaction per version). A failure is logged and recorded as the
 * row's last_error in a fresh transaction, so the versions bar shows why; it is never thrown.
 */
import type { PoolClient } from 'pg';
import { getPool, sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runOwnedContext } from '@/lib/afterCommit';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { tightenStatementTimeout } from '../../audit/auditTx';
import { fiscalYearForDate } from '../../gl/fiscalYearRegistry';
import { rollVersion } from './rollingForecastService';

export interface RollPrincipal {
  userId: string;
  companyId: string;
  /** The closing request's JWT claims (auth.user_companies() reads them). */
  claims: Record<string, unknown>;
}

/** A roll's statements may run this long (tightened only, never loosened). */
const ROLL_STATEMENT_TIMEOUT_MS = 60_000;

async function inCompanyTx<T>(p: RollPrincipal, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await getPool().connect();
  let begun = false;
  let unusable = false;
  try {
    await client.query('BEGIN');
    begun = true;
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(p.claims)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [p.companyId]);
    await tightenStatementTimeout(client, ROLL_STATEMENT_TIMEOUT_MS);
    const out = await runOwnedContext({ client, userId: p.userId, companyId: p.companyId, claims: p.claims }, fn);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    if (begun) unusable = await rollbackFailed(client, 'budget rolling forecast');
    throw err;
  } finally {
    client.release(unusable);
  }
}

/** The company's rolling version of each fiscal year holding one of `endDates`. */
async function rollingVersions(p: RollPrincipal, endDates: readonly string[]): Promise<string[]> {
  return inCompanyTx(p, async () => {
    const rows = (await sql`
      SELECT version_id::text AS id, fiscal_year FROM budget_rolling_forecasts
       WHERE company_id = ${p.companyId}::UUID ORDER BY fiscal_year
    `) as DbRow[];
    // Most companies roll nothing: the registry is read only when one does.
    if (rows.length === 0) return [];
    const labels = new Set<number>();
    for (const d of endDates) labels.add((await fiscalYearForDate(p.companyId, d)).fiscalYear);
    return rows.filter((r) => labels.has(Number(r.fiscal_year))).map((r) => String(r.id));
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runBudgetRolls(p: RollPrincipal, endDates: readonly string[]): Promise<void> {
  let versions: string[];
  try {
    versions = await rollingVersions(p, endDates);
  } catch (err) {
    log.error('budgets: could not find the rolling forecasts to roll', { companyId: p.companyId, endDates, error: message(err) }, 'accounting');
    return;
  }
  for (const versionId of versions) {
    try {
      const out = await inCompanyTx(p, () => rollVersion(p.companyId, p.userId, versionId, 'auto'));
      log.info('budgets: rolling forecast roll after close', {
        companyId: p.companyId, versionId, status: out.status, changed: out.changed, through: out.rolledThroughMonth,
      }, 'accounting');
    } catch (err) {
      log.error('budgets: rolling forecast roll failed', { companyId: p.companyId, versionId, error: message(err) }, 'accounting');
      try {
        await inCompanyTx(p, () => sql`
          UPDATE budget_rolling_forecasts SET last_error = ${message(err).slice(0, 500)}
           WHERE company_id = ${p.companyId}::UUID AND version_id = ${versionId}::UUID
        `);
      } catch (recordErr) {
        log.error('budgets: could not record the failed roll', { companyId: p.companyId, versionId, error: message(recordErr) }, 'accounting');
      }
    }
  }
}
