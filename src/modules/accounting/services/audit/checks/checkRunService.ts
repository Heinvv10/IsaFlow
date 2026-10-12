/**
 * Check runs: the fifteen integrity checks, the anomaly scan and the
 * journal-risk set over one window, recorded and sealed. A snapshot embeds
 * one (purpose 'snapshot', in the snapshot's own transaction); owner / admin
 * can also take one on its own ('standalone').
 *
 * Each family runs in its own SAVEPOINT so one failing query is recorded as
 * `unknown` for that family's checks instead of aborting the run.
 */
import type { PoolClient } from 'pg';
import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runIntegrity } from './integrityAdapter';
import { ANOMALY_CHECK_VERSION, runAnomalyChecks } from './anomalyAdapter';
import { JOURNAL_RISK_CHECK_VERSION, runJournalRiskChecks } from './journalRiskChecks';
import { result, type CheckResult, type CheckWindow } from './checkTypes';
import { CHECK_RUN_SEAL_DOMAIN, sign, signingKey, type SigningKey } from '../seal';
import { DOCUMENT_VERSION, checkRunHash, type CheckRunHeader } from '../documents';
import { runAuditTx, transactionNow, type AuditPrincipal } from '../auditTx';
import { withSnapshotSlot } from '../snapshotSlots';
import { bulkPlan, fiscalYearStart } from '../snapshotRows';

const ANOMALY_IDS = ['anomaly.benford', 'anomaly.statistical_outliers', 'anomaly.duplicate_payments', 'anomaly.unusual_posting_patterns'];
const JOURNAL_RISK_IDS = ['journal_risk.backdated_entry', 'journal_risk.posted_after_period_close',
  'journal_risk.outside_business_hours', 'journal_risk.reversal_relation', 'journal_risk.threshold_split'];

async function family(name: string, ids: string[], version: number, fam: CheckResult['family'],
  run: () => Promise<CheckResult[]>): Promise<CheckResult[]> {
  try {
    return await withSavepoint(`audit_checks_${name}`, run);
  } catch (err) {
    log.warn('audit: check family did not run', { family: name, error: err instanceof Error ? err.message : String(err) }, 'audit');
    return ids.map((id) => result(id, version, fam, null, [], 'unknown'));
  }
}

/**
 * Every check over the window, set-wise plans (bulkPlan): a check that still errors is recorded `unknown`.
 * `step` runs before each check and family, outside its savepoint (a snapshot's time budget: its refusal propagates).
 */
export async function runAllChecks(w: CheckWindow, step?: (name: string) => Promise<void>): Promise<CheckResult[]> {
  return bulkPlan(async () => {
    const integrity = await runIntegrity(w, step);
    await step?.('the anomaly checks');
    const anomaly = await family('anomaly', ANOMALY_IDS, ANOMALY_CHECK_VERSION, 'anomaly', () => runAnomalyChecks(w));
    await step?.('the journal-risk checks');
    const risk = await family('journal_risk', JOURNAL_RISK_IDS, JOURNAL_RISK_CHECK_VERSION, 'journal_risk', () => runJournalRiskChecks(w));
    return [...integrity, ...anomaly, ...risk];
  });
}

export function checkTotals(results: CheckResult[]): Record<string, number> {
  return {
    checks: results.length,
    failed: results.filter((r) => r.status === 'fail').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
    findings: results.reduce((n, r) => n + r.findingCount, 0),
  };
}

export interface RecordedRun { id: string; canonicalHash: string; takenAt: string; results: CheckResult[] }

/** Seals and records a run inside the caller's audit transaction. */
export async function recordCheckRun(client: PoolClient, p: AuditPrincipal, input: {
  asAt: string; periodStart: string; purpose: CheckRunHeader['purpose']; results: CheckResult[]; key: SigningKey;
}): Promise<RecordedRun> {
  const header: CheckRunHeader = {
    id: crypto.randomUUID(), companyId: p.companyId, asAt: input.asAt, periodStart: input.periodStart,
    takenAt: await transactionNow(client), takenBy: p.userId, purpose: input.purpose,
    totals: { ...checkTotals(input.results), document_version: DOCUMENT_VERSION },
  };
  const canonicalHash = checkRunHash(header, input.results);
  const seal = sign(CHECK_RUN_SEAL_DOMAIN, {
    companyId: p.companyId, id: header.id, canonicalHash, cutoff: input.asAt, takenAt: header.takenAt,
  }, input.key);
  await client.query('SELECT public.audit_check_run_record($1::jsonb, $2::jsonb)', [
    JSON.stringify({
      id: header.id, company_id: p.companyId, as_at: input.asAt, period_start: input.periodStart, taken_at: header.takenAt,
      taken_by: p.userId, purpose: input.purpose, canonical_hash: canonicalHash, hmac: seal.hmac, key_id: seal.keyId,
      totals: header.totals,
    }),
    JSON.stringify(input.results.map((r) => ({
      check_id: r.checkId, check_version: r.version, family: r.family, status: r.status, population: r.population,
      finding_count: r.findingCount, findings: r.findings,
    }))),
  ]);
  return { id: header.id, canonicalHash, takenAt: header.takenAt, results: input.results };
}

/** A check run on its own (owner / admin), as at `asAt`, over the fiscal year to that date. */
export async function takeCheckRun(p: AuditPrincipal, asAt: string): Promise<RecordedRun> {
  const key = signingKey();
  return withSnapshotSlot(p.companyId, false, () => runAuditTx(p, 'REPEATABLE READ', async (client) => {
    const from = await fiscalYearStart(p.companyId, asAt);
    const results = await runAllChecks({ companyId: p.companyId, from, to: asAt });
    return recordCheckRun(client, p, { asAt, periodStart: from, purpose: 'standalone', results, key });
  }));
}
