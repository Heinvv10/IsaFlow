/**
 * A recorded check: one result per check id per run, sealed with the run.
 * `unknown` means the check did not answer (it errored or had too little data
 * to judge) — never read it as clean. A finding is a LEAD for a person to
 * look at, not a verdict.
 */
export type CheckFamily = 'integrity' | 'anomaly' | 'journal_risk';
export type CheckStatus = 'pass' | 'fail' | 'unknown';

/** Detail values are strings or integers so the run's canonical JSON round-trips (amounts as decimal strings). */
export type FindingDetail = Record<string, string | number | boolean | null>;

export interface Finding {
  /** Stable across runs for the same underlying fact (e.g. the journal id). */
  key: string;
  /** Row ids the finding is about. */
  refs: string[];
  detail: FindingDetail;
}

export interface CheckResult {
  checkId: string;
  version: number;
  family: CheckFamily;
  status: CheckStatus;
  /** How many rows the check looked at, when it knows. */
  population: number | null;
  findingCount: number;
  findings: Finding[];
}

/** Findings kept per check (the count is never capped). */
export const MAX_FINDINGS_PER_CHECK = 200;

export interface CheckWindow {
  companyId: string;
  /** First day of the population (the fiscal year start of the cutoff). */
  from: string;
  /** The as-at / cutoff date; rows dated after it are out of scope. */
  to: string;
}

/** A money value as the canonical form wants it: a decimal string, two places. */
export const money = (n: unknown): string => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '0.00');

export function result(checkId: string, version: number, family: CheckFamily, population: number | null,
  findings: Finding[], status?: CheckStatus): CheckResult {
  return {
    checkId, version, family, population, findingCount: findings.length,
    status: status ?? (findings.length > 0 ? 'fail' : 'pass'),
    findings: findings.slice(0, MAX_FINDINGS_PER_CHECK),
  };
}
